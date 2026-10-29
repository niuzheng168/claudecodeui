import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSessionSummary } from '@/modules/activity/services/session-summary-generator.service.js';
import {
  SESSION_SUMMARY_INSTRUCTIONS, SESSION_SUMMARY_SCHEMA, fallbackSessionSummary, parseSessionSummary,
} from '@/shared/index.js';
import type { NormalizedMessage, SessionSummaryRequest } from '@/shared/index.js';

const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const SECOND = 1_000;
let rowCount = 0;

const row = (fields: Partial<NormalizedMessage>, at: number): NormalizedMessage => ({
  id: `row-${rowCount++}`, sessionId: 's', provider: 'claude', timestamp: new Date(at).toISOString(), kind: 'text', ...fields,
});
const user = (content: string, at: number) => row({ role: 'user', content }, at);
const agent = (content: string, at: number) => row({ role: 'assistant', content }, at);
const toolCall = (toolName: string, at: number, toolInput: unknown = {}) => row({ kind: 'tool_use', toolName, toolInput }, at);

const request = (fields: Partial<SessionSummaryRequest> = {}): SessionSummaryRequest => ({
  sessionId: 's', provider: 'claude', reason: 'settled', at: T0 + 120 * SECOND,
  segmentStartedAt: T0, turnEndedAt: T0 + 60 * SECOND, ...fields,
});

const completed = (text: string) => ({
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  ],
});

/** A model API that records each request and answers with `answer` (an object, or a raw body). */
function modelApi(answer: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { status });
  }) as typeof globalThis.fetch;
  return {
    calls,
    dependencies: (history: NormalizedMessage[], runEvents: NormalizedMessage[] = [], environment: NodeJS.ProcessEnv = {}) => ({
      readMaterial: async () => ({ history, runEvents }),
      modelEndpoint: () => ({ url: 'http://127.0.0.1:4141/v1/responses', headers: { Authorization: 'Bearer test-key' } }),
      fetch,
      environment,
    }),
  };
}

const live = () => new AbortController().signal;
const inputOf = (call: { body: Record<string, any> }): string => call.body.input[0].content[0].text;

test('the first sentence of the reply, without Markdown, stands in for a model', () => {
  assert.equal(fallbackSessionSummary('The fix is in. All 12 tests pass.'), 'The fix is in.');
  assert.equal(fallbackSessionSummary('已修复登录按钮错位。全部测试通过。'), '已修复登录按钮错位。');
  assert.equal(
    fallbackSessionSummary('## Summary\n\n**Fixed** the `login` button on [mobile](https://example.test/x).\n\nMore.'),
    'Fixed the login button on mobile.',
  );
  assert.equal(fallbackSessionSummary('```ts\nconst done = true.\n```\n\nThe build passes on Node 24.1 now'),
    'The build passes on Node 24.1 now', 'code is skipped; a version number is not the end of a sentence');
  assert.equal(fallbackSessionSummary('Here is what changed:\n\n- Moved the button. Also the label.\n- Updated tests'),
    'Here is what changed: Moved the button.');
  assert.equal(fallbackSessionSummary('> Quoted: keep snake_case and 2 * 3 as they are.'), 'Quoted: keep snake_case and 2 * 3 as they are.');
  assert.equal(fallbackSessionSummary('# Done'), 'Done', 'a heading when nothing else is there');
  assert.equal(fallbackSessionSummary('| a | b |\n|---|---|\n| 1 | 2 |'), 'a b');
  assert.equal(fallbackSessionSummary('Ring\u0007 the‮ bell'), 'Ring the bell');
  assert.equal(fallbackSessionSummary('```\nonly code\n```'), null);
  assert.equal(fallbackSessionSummary('   \n\n'), null);
});

test('a summary line is cut at 80 wide or 160 narrow characters, within the Portal\'s 200', () => {
  const chinese = '这'.repeat(100);
  assert.equal(fallbackSessionSummary(chinese), `${'这'.repeat(79)}…`);
  assert.equal(fallbackSessionSummary('这'.repeat(80)), '这'.repeat(80), 'eighty fit');
  const english = 'word '.repeat(60);
  const cut = fallbackSessionSummary(english)!;
  assert.ok(cut.endsWith('…') && cut.length <= 160, cut);
  // Narrow characters outside the Basic Multilingual Plane take two code units each.
  const math = '\u{1D400}'.repeat(150);
  assert.ok(fallbackSessionSummary(math)!.length <= 200);
});

test('a model\'s answer must be the summary object, and is flattened to one line', () => {
  assert.equal(parseSessionSummary('{"summary":"已修复，测试通过；请确认是否提交。"}'), '已修复，测试通过；请确认是否提交。');
  assert.equal(parseSessionSummary('{"summary":"Fixed **the** `parser`\\nand pushed"}'), 'Fixed the parser and pushed');
  assert.equal(parseSessionSummary('{"summary":"\\"Waiting for approval\\""}'), 'Waiting for approval');
  assert.equal(parseSessionSummary('{"summary":"ok","extra":1}'), null);
  assert.equal(parseSessionSummary('{"summary":"   "}'), null);
  assert.equal(parseSessionSummary('{"title":"x"}'), null);
  assert.equal(parseSessionSummary('Fixed it.'), null);
});

test('a long turn is summarized by the node\'s model from this turn\'s messages and the last reply', async () => {
  const api = modelApi(completed('{"summary":"登录按钮已修复，测试全部通过。"}'));
  const history = [
    user('an earlier request', T0 - 10 * 60 * SECOND),
    agent('an earlier answer', T0 - 9 * 60 * SECOND),
    user('修复登录按钮', T0 + SECOND),
    toolCall('Edit', T0 + 10 * SECOND),
    user('再跑一下测试', T0 + 20 * SECOND),
    agent('已修复登录按钮。\n\n全部 128 个测试通过。', T0 + 50 * SECOND),
  ];
  const summary = await generateSessionSummary(request(), live(), api.dependencies(history));
  assert.equal(summary, '登录按钮已修复，测试全部通过。');
  assert.equal(api.calls.length, 1);
  const [call] = api.calls;
  assert.equal(call.url, 'http://127.0.0.1:4141/v1/responses');
  assert.equal(call.headers.Authorization, 'Bearer test-key');
  assert.equal(call.body.model, 'gpt-6.1-terra');
  assert.equal(call.body.instructions, SESSION_SUMMARY_INSTRUCTIONS);
  assert.deepEqual(call.body.text.format, { type: 'json_schema', name: 'session_summary', strict: true, schema: SESSION_SUMMARY_SCHEMA });
  assert.deepEqual([call.body.store, call.body.stream, call.body.tool_choice, call.body.tools, call.body.reasoning],
    [false, false, 'none', [], { effort: 'low' }]);
  const input = inputOf(call);
  assert.match(input, /^Session state: the turn has ended/);
  assert.match(input, /\[1\] 修复登录按钮\n\[2\] 再跑一下测试/);
  assert.match(input, /The agent's last reply:\n已修复登录按钮。\n\n全部 128 个测试通过。/);
  assert.doesNotMatch(input, /earlier/, 'nothing from before these turns');

  const other = modelApi(completed('{"summary":"Done."}'));
  await generateSessionSummary(request(), live(), other.dependencies(history, [], { CODEY_SUMMARY_MODEL: 'gpt-6.1-sol' }));
  assert.equal(other.calls[0].body.model, 'gpt-6.1-sol', 'CODEY_SUMMARY_MODEL names another model');
});

test('without a model API, or after a short turn, the first sentence of the reply is the summary', async () => {
  const history = [user('Is 2 + 2 four?', T0 + SECOND), agent('Yes. It is four.', T0 + 3 * SECOND)];
  const api = modelApi(completed('{"summary":"unused"}'));
  const noModel = { ...api.dependencies(history), modelEndpoint: () => null };
  assert.equal(await generateSessionSummary(request(), live(), noModel), 'Yes.');

  const short = request({ turnEndedAt: T0 + 8 * SECOND });
  assert.equal(await generateSessionSummary(short, live(), api.dependencies(history)), 'Yes.');
  assert.equal(api.calls.length, 0, 'ten seconds without a tool call needs no model');

  const withTool = [...history.slice(0, 1), toolCall('Bash', T0 + 2 * SECOND), ...history.slice(1)];
  assert.equal(await generateSessionSummary(short, live(), api.dependencies(withTool)), 'unused');
  assert.equal(api.calls.length, 1, 'a short turn that used a tool is summarized by the model');
});

test('a failed model call falls back to the first sentence; a session with nothing said gets no summary', async () => {
  const history = [user('Deploy it', T0 + SECOND), agent('Deployed to staging. Production is next.', T0 + 50 * SECOND)];
  for (const [answer, status] of [
    ['{"error":"busy"}', 500],
    [completed('not json'), 200],
    [{ status: 'incomplete', output: [] }, 200],
  ] as const) {
    const api = modelApi(answer, status);
    assert.equal(await generateSessionSummary(request(), live(), api.dependencies(history)), 'Deployed to staging.');
  }
  const unreachable = {
    ...modelApi('').dependencies(history),
    fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof globalThis.fetch,
  };
  assert.equal(await generateSessionSummary(request(), live(), unreachable), 'Deployed to staging.');

  const api = modelApi(completed('{"summary":"unused"}'));
  assert.equal(await generateSessionSummary(request(), live(), api.dependencies([])), null);
  assert.equal(api.calls.length, 0);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(generateSessionSummary(request(), aborted.signal, api.dependencies(history)));
});

test('a question the session waits on, and the error a run failed with, are what it says last', async () => {
  const question = toolCall('AskUserQuestion', T0 + 20 * SECOND, {
    questions: [{ question: 'Which database should I use?', options: [{ label: 'Postgres' }] }],
  });
  const waiting = request({ reason: 'waiting', waitingKind: 'question', turnEndedAt: undefined });
  const history = [user('Set up the backend', T0 + SECOND), agent('I have a question first.', T0 + 10 * SECOND), question];
  const noModel = { ...modelApi('').dependencies(history), modelEndpoint: () => null };
  assert.equal(await generateSessionSummary(waiting, live(), noModel), 'Which database should I use?');
  const api = modelApi(completed('{"summary":"等你选择数据库。"}'));
  assert.equal(await generateSessionSummary(waiting, live(), api.dependencies(history)), '等你选择数据库。');
  assert.match(inputOf(api.calls[0]), /asked the user a question[\s\S]*The agent's question: Which database should I use\?/);

  const failed = request({ reason: 'failed' });
  const runEvents = [
    row({ kind: 'tool_use', toolName: 'Bash' }, T0 + 5 * SECOND),
    row({ kind: 'error', content: 'Claude Code process exited with code 1. See the log.' }, T0 + 6 * SECOND),
  ];
  const failedHistory = [user('Run the migration', T0 + SECOND), agent('Running it now.', T0 + 4 * SECOND)];
  const noModelFailed = { ...modelApi('').dependencies(failedHistory, runEvents), modelEndpoint: () => null };
  assert.equal(await generateSessionSummary(failed, live(), noModelFailed), 'Claude Code process exited with code 1.');
  const failedApi = modelApi(completed('{"summary":"Migration run failed: the process exited."}'));
  await generateSessionSummary(failed, live(), failedApi.dependencies(failedHistory, runEvents));
  assert.match(inputOf(failedApi.calls[0]), /ended with an error[\s\S]*The error: Claude Code process exited with code 1/);
});

test('a turn begun without a stamped request still reads the latest one, and the input stays near 6,000 characters', async () => {
  const api = modelApi(completed('{"summary":"Still going."}'));
  await generateSessionSummary(request(), live(), api.dependencies([
    user('the request from before', T0 - 3_600 * SECOND),
    agent('Worked through the scheduled check.', T0 + 30 * SECOND),
  ]));
  assert.match(inputOf(api.calls[0]), /\[1\] the request from before/);

  const long = modelApi(completed('{"summary":"Long."}'));
  const history = [
    ...Array.from({ length: 10 }, (_, index) => user(`request ${index} ${'x'.repeat(5_000)}`, T0 + index * SECOND)),
    agent(`BEGIN ${'y'.repeat(50_000)} END`, T0 + 50 * SECOND),
  ];
  await generateSessionSummary(request(), live(), long.dependencies(history));
  const input = inputOf(long.calls[0]);
  assert.ok(input.length <= 6_300, `input is ${input.length} characters`);
  assert.match(input, /request 9 x/, 'the newest request first');
  assert.match(input, /BEGIN y+\n…\ny+ END/, 'a long reply keeps its head and tail');
});
