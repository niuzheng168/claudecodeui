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

function nativeRow(id: string, itemIndex: number, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return row(id, {
    nativePosition: { turnId: 'desktop-turn', turnStartedAt: '2026-09-15T15:25:47.000Z', itemIndex },
    timestamp: '2026-09-15T15:25:47.000Z',
    ...overrides,
  });
}

test('a late join orders replayed desktop output before the newer native history tail, not after it', async () => {
  const { result } = renderHook(() => useSessionStore());
  respondWith([
    nativeRow('latest-question', 120, { role: 'user' }),
    nativeRow('latest-answer', 121),
  ]);
  await act(async () => { await result.current.fetchFromServer('session-1'); });
  act(() => {
    result.current.appendRealtime('session-1', nativeRow('earlier-answer', 90, {
      timestamp: '2026-09-15T16:13:11.000Z',
    }));
    result.current.appendRealtime('session-1', nativeRow('new-answer', 125, {
      timestamp: '2026-09-15T16:56:00.000Z',
    }));
  });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id),
    ['earlier-answer', 'latest-question', 'latest-answer', 'new-answer']);
});

test('native steering receipts precede their answers even when the accepted gateway echo arrives last', () => {
  const { result } = renderHook(() => useSessionStore());
  act(() => {
    result.current.appendRealtime('session-1', nativeRow('native-question', 10, {
      role: 'user', clientMessageId: 'correction-one', timestamp: '2026-09-15T16:12:00.000Z',
    }));
    result.current.appendRealtime('session-1', nativeRow('answer', 11, {
      timestamp: '2026-09-15T16:12:01.000Z',
    }));
    result.current.appendRealtime('session-1', row('steer_ack', {
      role: 'user', clientMessageId: 'correction-one', timestamp: '2026-09-15T16:12:02.000Z',
    }));
  });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id),
    ['native-question', 'answer']);
  assert.equal(result.current.getSessionSlot('session-1')?.realtimeMessages.length, 2);
});

test('a native input replaces its optimistic echo without moving past later output or swallowing another send', () => {
  const { result } = renderHook(() => useSessionStore());
  act(() => {
    result.current.appendRealtime('session-1', row('local_question', {
      role: 'user', content: 'continue', clientMessageId: 'one', timestamp: '2026-09-15T16:12:00.000Z',
    }));
    result.current.appendRealtime('session-1', nativeRow('answer', 11));
    result.current.appendRealtime('session-1', nativeRow('native-question', 10, {
      role: 'user', content: 'continue', clientMessageId: 'one',
    }));
    result.current.appendRealtime('session-1', nativeRow('repeat-question', 12, {
      role: 'user', content: 'continue', clientMessageId: 'two',
    }));
  });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id),
    ['native-question', 'answer', 'repeat-question']);
});

test('native positions survive a history refresh whose turn-start timestamps precede every live arrival', async () => {
  const { result } = renderHook(() => useSessionStore());
  act(() => {
    result.current.appendRealtime('session-1', nativeRow('question', 100, {
      role: 'user', clientMessageId: 'input', timestamp: '2026-09-15T16:12:00.000Z',
    }));
    result.current.appendRealtime('session-1', nativeRow('answer', 102, {
      timestamp: '2026-09-15T16:13:00.000Z',
    }));
  });
  respondWith([
    nativeRow('question', 100, { role: 'user', clientMessageId: 'input' }),
    nativeRow('tool', 101, { kind: 'tool_use', toolId: 'tool' }),
  ]);
  await act(async () => { await result.current.refreshLatestFromServer('session-1'); });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id),
    ['question', 'tool', 'answer']);
  respondWith([
    nativeRow('question', 100, { role: 'user', clientMessageId: 'input' }),
    nativeRow('tool', 101, { kind: 'tool_use', toolId: 'tool' }),
    nativeRow('answer', 102),
  ]);
  await act(async () => { await result.current.refreshLatestFromServer('session-1'); });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id),
    ['question', 'tool', 'answer']);
});

test('joining a partially streamed native item keeps receiving updates across stale history reads', async () => {
  const { result } = renderHook(() => useSessionStore());
  const prompt = nativeRow('question', 0, { role: 'user' });
  respondWith([prompt, nativeRow('answer', 1, { content: 'I will' })]);
  await act(async () => { await result.current.fetchFromServer('session-1'); });
  act(() => {
    result.current.appendRealtime('session-1', nativeRow('answer', 1, {
      content: 'I will check the tests', timestamp: '2026-09-15T16:12:01.000Z',
    }));
  });
  assert.equal(result.current.getMessages('session-1')[1].content, 'I will check the tests');
  await act(async () => { await result.current.refreshLatestFromServer('session-1'); });
  assert.equal(result.current.getMessages('session-1')[1].content, 'I will check the tests');
  assert.equal(result.current.getSessionSlot('session-1')?.realtimeMessages.length, 1);
  respondWith([prompt, nativeRow('answer', 1, { content: 'I will check the tests and report back.' })]);
  await act(async () => { await result.current.refreshLatestFromServer('session-1'); });
  assert.equal(result.current.getMessages('session-1')[1].content, 'I will check the tests and report back.');
  assert.equal(result.current.getSessionSlot('session-1')?.realtimeMessages.length, 0);
});

test('distinct native items with identical text are not mistaken for synthetic assistant echoes', async () => {
  const { result } = renderHook(() => useSessionStore());
  respondWith([
    nativeRow('question', 0, { role: 'user' }),
    nativeRow('first-answer', 1, { content: 'Done' }),
  ]);
  await act(async () => { await result.current.fetchFromServer('session-1'); });
  act(() => {
    result.current.appendRealtime('session-1', nativeRow('second-answer', 2, { content: 'Done' }));
  });
  await act(async () => { await result.current.refreshLatestFromServer('session-1'); });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id),
    ['question', 'first-answer', 'second-answer']);
});

test('a long native turn bridges disjoint latest pages even though their timestamps all equal turn start', async () => {
  const { result } = renderHook(() => useSessionStore());
  const history = Array.from({ length: 100 }, (_, index) => nativeRow(`item-${index}`, index * 3));
  let total = 70;
  sessionMessages.mockImplementation(async (_id, options) => {
    const end = Math.max(0, total - options.offset);
    const start = Math.max(0, end - options.limit);
    return {
      ok: true,
      json: async () => ({ data: { messages: history.slice(start, end), total, hasMore: start > 0 } }),
    };
  });
  await act(async () => { await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 }); });
  total = 100;
  await act(async () => {
    const refresh = await result.current.refreshLatestFromServer('session-1', { limit: 20 });
    assert.equal(refresh.applied, true);
  });
  assert.deepEqual(sessionMessages.mock.calls.map(([, options]) => options), [
    { limit: 20, offset: 0 }, { limit: 20, offset: 0 }, { limit: 11, offset: 20 },
  ]);
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id),
    history.slice(50).map((message) => message.id));
  await act(async () => { await result.current.fetchMore('session-1', { limit: 20 }); });
  assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id),
    history.slice(30).map((message) => message.id));
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
