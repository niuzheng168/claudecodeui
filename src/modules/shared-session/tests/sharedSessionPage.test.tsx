import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import '@/modules/i18n';
import SharedSessionApp from '@/modules/shared-session/SharedSessionApp';
import type { NormalizedMessage, SharedSessionLive, SharedSessionRun } from '@/shared/types';

const GRANT_ID = 'grt_0123456789abcdef01234567';
const API_ROOT = `/api/v1/shared/${GRANT_ID}`;
const SESSION_ID = 'session-1';
const ADDRESS = `codey://n-fedcba9876543210fedcba98/${SESSION_ID}`;
const HISTORY_PATH = `/shared-sessions/${GRANT_ID}/api/providers/sessions/${SESSION_ID}/messages`;

const RUNTIME = {
  grantId: GRANT_ID,
  api: API_ROOT,
  address: ADDRESS,
  sessionId: SESSION_ID,
  provider: 'claude',
  title: 'Parser review',
  owner: 'bob',
  viewer: 'alice',
  mode: 'confirm',
  approvals: 'user',
  expiresAt: null,
};

type FetchCall = { url: string; method: string; body: unknown; headers: Record<string, string> };

let calls: FetchCall[] = [];
let historyPages: NormalizedMessage[][] = [];
let livePages: Array<Partial<SharedSessionLive> | { status: number; error: { code: string; message: string } }> = [];
let infoResponse: unknown = null;
let actionStatus = 204;

const row = (id: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id,
  sessionId: SESSION_ID,
  timestamp: '2026-11-10T08:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content: id,
  ...overrides,
});

const envelope = (user: string, body: string) =>
  `<codey-session-message from="codey://n-0000/x" user="${user}" agent="Claude">\n${body}\n</codey-session-message>\nThis came from ${user}, another Codey user.`;

const running = (overrides: Partial<SharedSessionRun> = {}): SharedSessionRun => ({
  id: 'run-0001-abcdef',
  status: 'running',
  startedAt: Date.now() - 5_000,
  completedAt: null,
  outcome: null,
  lastSeq: 0,
  startedBy: null,
  canStop: false,
  ...overrides,
});

const live = (overrides: Partial<SharedSessionLive> = {}): Partial<SharedSessionLive> => ({
  supported: true,
  online: true,
  run: null,
  events: [],
  reset: false,
  more: false,
  background: false,
  permissions: [],
  waitingForOwner: false,
  messages: [],
  ...overrides,
});

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});

const readHeaders = (headers: HeadersInit | undefined): Record<string, string> => {
  const read: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    read[name] = value;
  });
  return read;
};

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: readHeaders(init.headers),
    });
    const path = url.split('?')[0];

    if (path === HISTORY_PATH) {
      const messages = historyPages.length > 1 ? historyPages.shift()! : historyPages[0] ?? [];
      return jsonResponse(200, { success: true, data: { messages, total: messages.length, hasMore: false } });
    }
    if (path === `${API_ROOT}/live`) {
      const page = livePages.length > 1 ? livePages.shift()! : livePages[0] ?? live();
      return 'status' in page && typeof page.status === 'number'
        ? jsonResponse(page.status, { error: (page as { error: unknown }).error })
        : jsonResponse(200, page);
    }
    if (path === API_ROOT) {
      return infoResponse ? jsonResponse(200, infoResponse) : jsonResponse(500, { error: { code: 'X', message: 'no info' } });
    }
    if (path === '/api/v1/messages' && method === 'POST') {
      const body = JSON.parse(String(init.body));
      return jsonResponse(201, {
        id: 'msg_sent_1', text: body.text, status: 'awaiting_confirmation', error: null, createdAt: new Date().toISOString(),
      });
    }
    if (path.startsWith(`${API_ROOT}/`) && method === 'POST') {
      return actionStatus === 204
        ? { ok: true, status: 204, headers: new Headers(), json: async () => { throw new Error('no body'); } }
        : jsonResponse(actionStatus, { error: { code: 'NOT_YOURS', message: 'Not your turn' } });
    }
    return jsonResponse(404, { error: { code: 'NOT_FOUND', message: `unexpected ${method} ${url}` } });
  }));
}

/** Runs due timers and lets the promise chains they start finish. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let round = 0; round < 8; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const liveCalls = () => calls.filter((call) => call.url.split('?')[0] === `${API_ROOT}/live`);
const historyCalls = () => calls.filter((call) => call.url.split('?')[0] === HISTORY_PATH);

async function openPage(runtime: Record<string, unknown> = RUNTIME) {
  render(<SharedSessionApp runtime={runtime} />);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame'] });
  (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__ = `/shared-sessions/${GRANT_ID}/`;
  calls = [];
  historyPages = [];
  livePages = [];
  infoResponse = null;
  actionStatus = 204;
  mockFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__;
});

describe('the shared session page', () => {
  it('reads history through the Portal\'s history proxy and labels who wrote each turn', async () => {
    historyPages = [[
      row('owner-question', { role: 'user', content: 'Owner asks' }),
      row('answer-1', { content: 'Owner answer' }),
      row('my-question', { role: 'user', content: envelope('alice', 'I ask'), timestamp: '2026-11-10T08:01:00.000Z' }),
      row('other-question', { role: 'user', content: envelope('carol', 'Carol asks'), timestamp: '2026-11-10T08:02:00.000Z' }),
    ]];
    await openPage();

    assert.ok(screen.getByText('Parser review'));
    assert.ok(screen.getByText(/bob shared this with you · Your messages wait for bob to confirm/));
    assert.equal(historyCalls().length, 1);
    assert.ok(historyCalls()[0].url.includes('limit=20'), 'history is read a page at a time');

    const badges = screen.getAllByTestId('message-sender').map((badge) => badge.textContent);
    assert.deepEqual(badges, ['bob', 'Me', 'From carol']);
    assert.ok(screen.getByText('I ask'));
    assert.equal(screen.queryByText(/another Codey user/), null);
  });

  it('merges live events into the transcript, follows the run by seq, and re-reads history on complete', async () => {
    historyPages = [
      [row('q1', { role: 'user', content: 'Owner asks' })],
      [row('q1', { role: 'user', content: 'Owner asks' }), row('final-answer', { content: 'Persisted answer' })],
    ];
    const run = running({ lastSeq: 2 });
    livePages = [
      live({ run, events: [
        { kind: 'text', role: 'assistant', id: 'live-1', content: 'Live partial answer', seq: 1, runId: run.id, timestamp: '2026-11-10T08:00:01.000Z' },
        { kind: 'tool_use', id: 'tool-1', toolId: 'tool-1', toolName: 'Bash', toolInput: { command: 'ls -la' }, seq: 2, runId: run.id, timestamp: '2026-11-10T08:00:02.000Z' },
      ] }),
      live({ run: { ...run, status: 'completed', lastSeq: 3 }, events: [
        { kind: 'complete', seq: 3, runId: run.id, exitCode: 0, success: true },
      ] }),
      live({ run: { ...run, status: 'completed', lastSeq: 3 } }),
    ];
    await openPage();

    assert.ok(screen.getByText('Live partial answer'));
    assert.ok(screen.getByText('ls -la'));
    assert.equal(liveCalls()[0].url, `${API_ROOT}/live`, 'the first poll asks for the run from its start');

    // A running turn is polled every second, from the last event seen.
    await settle(1000);
    assert.equal(liveCalls().length, 2);
    assert.equal(liveCalls()[1].url, `${API_ROOT}/live?afterSeq=2&runId=${run.id}`);
    // `complete` re-reads the newest history.
    assert.equal(historyCalls().length, 2);
    assert.ok(screen.getByText('Persisted answer'));

    // Idle again: the next poll waits five seconds.
    await settle(1000);
    assert.equal(liveCalls().length, 2);
    await settle(4000);
    assert.equal(liveCalls().length, 3);
  });

  it('does not replay a run that ended before the page opened', async () => {
    historyPages = [[row('persisted', { content: 'Persisted answer' })]];
    const run = running({ status: 'completed', lastSeq: 1 });
    livePages = [
      live({ run, events: [{ kind: 'text', role: 'assistant', id: 'old-live', content: 'Stale live copy', seq: 1, runId: run.id }] }),
    ];
    await openPage();

    assert.equal(screen.queryByText('Stale live copy'), null);
    assert.ok(screen.getByText('Persisted answer'));
    await settle(5000);
    assert.equal(liveCalls()[1].url, `${API_ROOT}/live?afterSeq=1&runId=${run.id}`);
  });

  it('shows Stop only for a turn the reader may stop, and stops it through the Portal', async () => {
    historyPages = [[]];
    livePages = [live({ run: running({ canStop: false }) })];
    await openPage();
    assert.ok(screen.getByText(/…/), 'the activity tab shows the turn running');
    assert.equal(screen.queryByRole('button', { name: 'Stop' }), null);

    livePages = [live({ run: running({ canStop: true, startedBy: { user: 'alice', mine: true } }) })];
    await settle(1000);
    const stop = screen.getByRole('button', { name: 'Stop' });

    fireEvent.click(stop);
    await settle();
    const stopCall = calls.find((call) => call.url === `${API_ROOT}/stop`);
    assert.ok(stopCall);
    assert.equal(stopCall.method, 'POST');
    assert.deepEqual(stopCall.body, { runId: 'run-0001-abcdef' });
  });

  it('reports a refused stop', async () => {
    historyPages = [[]];
    livePages = [live({ run: running({ canStop: true }) })];
    actionStatus = 403;
    await openPage();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    assert.ok(screen.getByText('Could not stop the turn: Not your turn'));
  });

  it('offers only the approvals the Portal lists, and answers them through it', async () => {
    historyPages = [[]];
    const run = running({ canStop: true, lastSeq: 1 });
    // A request seen in the event stream is not the reader's to answer.
    livePages = [live({ run, events: [
      { kind: 'permission_request', requestId: 'req-from-events', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, seq: 1, runId: run.id },
    ] })];
    await openPage();
    assert.equal(screen.queryByText('Permission required'), null);

    livePages = [live({ run, permissions: [{ requestId: 'req-1', toolName: 'Bash', input: { command: 'npm test' }, receivedAt: Date.now() }] })];
    await settle(1000);
    assert.ok(screen.getByText('Permission required'));
    // No remembered rules: the owner's settings are not the reader's.
    assert.equal(screen.queryByText('Allow & remember'), null);

    fireEvent.click(screen.getByText('Allow once'));
    await settle();
    const answer = calls.find((call) => call.url === `${API_ROOT}/permissions/req-1`);
    assert.ok(answer);
    assert.deepEqual(answer.body, { runId: run.id, allow: true });
    assert.equal(screen.queryByText('Permission required'), null, 'an answered request is hidden at once');
  });

  it('says when a turn waits for the owner\'s approval', async () => {
    historyPages = [[]];
    livePages = [live({ run: running(), waitingForOwner: true })];
    await openPage();
    assert.ok(screen.getByText('Waiting for bob: this turn needs an approval only bob can give.'));
  });

  it('lists the reader\'s messages the transcript does not show yet', async () => {
    historyPages = [[
      row('delivered-turn', { role: 'user', content: envelope('alice', 'Already in the transcript'), timestamp: '2026-11-10T08:05:00.000Z' }),
    ]];
    const now = Date.now();
    livePages = [live({ messages: [
      { id: 'msg_1', text: 'Please confirm me', status: 'awaiting_confirmation', error: null, createdAt: new Date(now - 60_000).toISOString() },
      { id: 'msg_2', text: 'Waiting in line', status: 'queued', error: null, createdAt: new Date(now - 30_000).toISOString() },
      { id: 'msg_3', text: 'Did not make it', status: 'failed', error: { code: 'NODE_UNAVAILABLE', message: 'machine offline' }, createdAt: new Date(now - 20_000).toISOString() },
      { id: 'msg_4', text: 'Already in the transcript', status: 'started', error: null, createdAt: '2026-11-10T08:04:59.000Z' },
    ] })];
    await openPage();

    const outbox = screen.getByTestId('shared-session-outbox');
    assert.ok(outbox.textContent?.includes('Please confirm me'));
    assert.ok(outbox.textContent?.includes('Waiting for bob to confirm'));
    assert.ok(outbox.textContent?.includes('Waiting in line'));
    assert.ok(outbox.textContent?.includes('Queued'));
    assert.ok(outbox.textContent?.includes('Not delivered: machine offline'));
    assert.ok(!outbox.textContent?.includes('Already in the transcript'), 'a message the transcript shows is not listed again');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    assert.ok(!screen.getByTestId('shared-session-outbox').textContent?.includes('Did not make it'));
  });

  it('sends a message to the session\'s address and lists it until the transcript shows it', async () => {
    historyPages = [[]];
    await openPage();

    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: 'Can you rerun the tests?' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    await settle();

    const send = calls.find((call) => call.url === '/api/v1/messages');
    assert.ok(send);
    assert.equal(send.method, 'POST');
    assert.deepEqual(send.body, { to: ADDRESS, text: 'Can you rerun the tests?' });
    assert.match(send.headers['idempotency-key'] ?? '', /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal((textbox as HTMLTextAreaElement).value, '');
    assert.ok(screen.getByTestId('shared-session-outbox').textContent?.includes('Can you rerun the tests?'));
    assert.ok(liveCalls().length >= 2, 'a send polls at once');
  });

  it('re-reads history every few seconds when the owner\'s machine has no live support', async () => {
    historyPages = [[]];
    livePages = [live({ supported: false })];
    await openPage();
    assert.ok(screen.getByText(/runs an older Codey/));
    const readsAfterOpen = historyCalls().length;
    await settle(5000);
    assert.ok(historyCalls().length > readsAfterOpen);
    assert.equal(screen.queryByRole('button', { name: 'Stop' }), null);
  });

  it('stops polling while the tab is hidden and catches up when it is shown again', async () => {
    historyPages = [[]];
    await openPage();
    const pollsBefore = liveCalls().length;

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle(20_000);
    assert.equal(liveCalls().length, pollsBefore);

    visibility.mockReturnValue('visible');
    const historyBefore = historyCalls().length;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    assert.equal(liveCalls().length, pollsBefore + 1);
    assert.ok(historyCalls().length > historyBefore);
  });

  it('says so when the share is gone', async () => {
    historyPages = [[]];
    livePages = [{ status: 404, error: { code: 'NOT_FOUND', message: 'gone' } }];
    await openPage();
    assert.ok(screen.getByText('This shared session is no longer available'));
  });

  it('takes the address and title from the grant when the page was served without them', async () => {
    historyPages = [[]];
    infoResponse = {
      grant: { mode: 'auto', approvals: 'owner', expiresAt: null },
      session: { address: ADDRESS, sessionId: SESSION_ID, provider: 'claude', title: 'Renamed' },
      owner: 'bob',
      viewer: 'alice',
    };
    await openPage({ ...RUNTIME, address: undefined, title: null });
    assert.ok(screen.getByText('Renamed'));
    assert.ok(screen.getByText(/Your messages go straight to the agent/));
    assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).disabled, false);
  });

  it('refuses page parameters without an API root', async () => {
    await openPage({ ...RUNTIME, api: 'https://elsewhere.example/api' });
    assert.ok(screen.getByText(/missing its parameters/));
    assert.equal(calls.length, 0);
  });
});
