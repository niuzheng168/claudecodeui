import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage } from '@/shared/types';

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

function row(id: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    timestamp: '2026-09-07T02:36:52.000Z',
    content: id,
    ...overrides,
  };
}

function respondWith(messages: NormalizedMessage[]) {
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
  });
}

beforeEach(() => {
  sessionMessages.mockReset();
  respondWith([]);
});

test('native history retires both send/steer echoes once and survives replay without swallowing repeated input', async () => {
  const { result } = renderHook(() => useSessionStore());
  const first = row('local_first', {
    role: 'user', content: '这条从codey发送', clientMessageId: 'first-input',
    timestamp: '2026-09-14T06:31:29.000Z',
  });
  const second = row('steer_request', {
    role: 'user', content: '测试追加 0111', clientMessageId: 'second-input',
    timestamp: '2026-09-14T06:31:49.000Z',
  });
  act(() => {
    result.current.appendRealtime('session-1', first);
    result.current.appendRealtime('session-1', second);
  });
  const history = [first, second].map((message) => ({
    ...message, id: `native_${message.id}`, timestamp: '2026-09-14T06:30:46.000Z',
  }));
  respondWith(history);
  await act(async () => { await result.current.fetchFromServer('session-1'); });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id), history.map((message) => message.id));
  assert.equal(result.current.getSessionSlot('session-1')?.realtimeMessages.length, 0);
  act(() => {
    result.current.appendRealtime('session-1', second);
    result.current.appendRealtime('session-1', { ...second, id: 'steer_repeat', clientMessageId: 'third-input' });
  });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.clientMessageId),
    ['first-input', 'second-input', 'third-input']);
  await act(async () => { await result.current.refreshLatestFromServer('session-1'); });
  assert.equal(result.current.getMessages('session-1').length, 3);
});

test('cumulative Codex snapshots update one assistant bubble instead of appending prefixes', () => {
  const { result } = renderHook(() => useSessionStore());
  const snapshots = [
    '我先对照仓库里的',
    '我先对照仓库里的 onboarding 流程和截图，',
    '我先对照仓库里的 onboarding 流程和截图，确认这些材料应该从哪里获取。',
  ];

  for (const [index, content] of snapshots.entries()) {
    act(() => {
      result.current.appendRealtime('session-1', row('reply-1', { content, seq: index + 1 }));
    });

    const messages = result.current.getMessages('session-1');
    assert.equal(result.current.getSessionSlot('session-1')?.realtimeMessages.length, 1);
    assert.deepEqual(messages.map((message) => message.content), [content]);
    assert.deepEqual(normalizedToChatMessages(messages).map((message) => message.content), [content]);
  }
});

test('snapshot replacement is immutable and leaves unrelated message projections unchanged', () => {
  const { result } = renderHook(() => useSessionStore());
  const earlier = row('earlier');
  const partial = row('reply-1', { content: 'Partial' });
  act(() => {
    result.current.appendRealtime('session-1', earlier);
    result.current.appendRealtime('session-1', partial);
  });
  const previous = result.current.getMessages('session-1');
  const previousChat = normalizedToChatMessages(previous);

  act(() => {
    result.current.appendRealtime('session-1', row('reply-1', { content: 'Complete', seq: 3 }));
  });

  const updated = result.current.getMessages('session-1');
  const updatedChat = normalizedToChatMessages(updated);
  assert.equal(updated.length, 2);
  assert.strictEqual(updated[0], earlier);
  assert.strictEqual(updatedChat[0], previousChat[0]);
  assert.notStrictEqual(updated[1], partial);
  assert.notStrictEqual(updatedChat[1], previousChat[1]);
  assert.equal(updated[1].seq, 3);
  assert.equal(previous[1].content, 'Partial');
});

test('updates retain their original position and timestamp when interleaved with history', async () => {
  const { result } = renderHook(() => useSessionStore());
  respondWith([row('prompt', { role: 'user', timestamp: '2026-09-07T02:36:51.000Z' })]);
  await act(async () => {
    await result.current.fetchFromServer('session-1');
  });

  const partial = row('reply-1', { content: 'Partial' });
  act(() => {
    result.current.appendRealtime('session-1', partial);
    result.current.appendRealtime('session-1', row('tool-1', {
      kind: 'tool_use',
      toolId: 'tool-1',
      toolName: 'Bash',
      timestamp: '2026-09-07T02:36:53.000Z',
    }));
    result.current.appendRealtime('session-1', row('reply-1', {
      content: 'Complete',
      timestamp: '2026-09-07T02:36:54.000Z',
    }));
  });

  const messages = result.current.getMessages('session-1');
  assert.deepEqual(messages.map((message) => message.id), ['prompt', 'reply-1', 'tool-1']);
  assert.equal(messages[1].timestamp, partial.timestamp);
  assert.equal(messages[1].content, 'Complete');
});

test('tool progress and completion update one tool row and its paired result', () => {
  const { result } = renderHook(() => useSessionStore());
  const tool = row('tool-1', {
    kind: 'tool_use', toolId: 'tool-1', toolName: 'Bash', toolInput: { command: 'pwd' },
    status: 'in_progress',
  });
  const output = row('tool-1_result', { kind: 'tool_result', toolId: 'tool-1', content: '/work' });
  act(() => {
    result.current.appendRealtime('session-1', tool);
    result.current.appendRealtime('session-1', output);
    result.current.appendRealtime('session-1', { ...tool, status: 'completed' });
    result.current.appendRealtime('session-1', { ...output, content: '/workspace/demo' });
  });

  const messages = result.current.getMessages('session-1');
  assert.deepEqual(messages.map((message) => message.id), ['tool-1', 'tool-1_result']);
  const chat = normalizedToChatMessages(messages);
  assert.equal(chat.length, 1);
  assert.equal(chat[0].toolStatus, 'completed');
  assert.equal(chat[0].toolResult?.content, '/workspace/demo');
});

test('different message IDs are not merged just because one text is a prefix of the other', () => {
  const { result } = renderHook(() => useSessionStore());
  act(() => {
    result.current.appendRealtime('session-1', row('reply-1', { content: 'I will check' }));
    result.current.appendRealtime('session-1', row('reply-2', { content: 'I will check the tests' }));
  });

  assert.deepEqual(
    result.current.getMessages('session-1').map((message) => message.id),
    ['reply-1', 'reply-2'],
  );
});

test('snapshot IDs are scoped to the routed app session, including background sessions', () => {
  const { result } = renderHook(() => useSessionStore());
  act(() => {
    result.current.setActiveSession('session-1');
    result.current.appendRealtime('session-1', row('reply-1', { content: 'First session' }));
    result.current.appendRealtime('session-2', row('reply-1', { content: 'Second' }));
    result.current.appendRealtime('session-2', row('reply-1', { content: 'Second session' }));
  });

  assert.equal(result.current.getMessages('session-1')[0].content, 'First session');
  const background = result.current.getMessages('session-2');
  assert.equal(background.length, 1);
  assert.equal(background[0].content, 'Second session');
  assert.equal(background[0].sessionId, 'session-2');
});

test('history reconciliation replaces the live snapshot with its persisted final copy', async () => {
  const { result } = renderHook(() => useSessionStore());
  act(() => {
    result.current.appendRealtime('session-1', row('reply-1', { content: 'Partial' }));
    result.current.appendRealtime('session-1', row('reply-1', { content: 'Complete' }));
  });

  // A delayed transcript write must not erase the live reply.
  await act(async () => {
    await result.current.refreshLatestFromServer('session-1');
  });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.content), ['Complete']);

  const persisted = row('reply-1', { content: 'Complete' });
  respondWith([persisted]);
  await act(async () => {
    await result.current.refreshLatestFromServer('session-1');
  });
  assert.deepEqual(result.current.getMessages('session-1'), [persisted]);
  assert.equal(result.current.getSessionSlot('session-1')?.realtimeMessages.length, 0);
});

test('repeated snapshots do not exhaust the realtime row limit or evict earlier messages', () => {
  const { result } = renderHook(() => useSessionStore());
  act(() => {
    result.current.appendRealtime('session-1', row('earlier'));
    for (let index = 0; index < 600; index++) {
      result.current.appendRealtime('session-1', row('reply-1', { content: `Snapshot ${index}` }));
    }
  });

  const messages = result.current.getMessages('session-1');
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.content), ['earlier', 'Snapshot 599']);
});
