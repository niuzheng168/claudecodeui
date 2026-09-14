import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { removeOptimisticUserEchoes } from '@/modules/chat/utils/sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('a replacement echo survives a kept turn that repeats its text', () => {
  // The exact shape a rewind that branches produces: the turn that survived
  // the cut is re-stamped to the moment of the copy, one second before the
  // replacement was typed, and happens to say the same thing the user just
  // corrected their message to.
  const userRow = (id: string, content: string, timestamp: string) => ({
    id,
    kind: 'text',
    role: 'user',
    provider: 'codex',
    sessionId: 's1',
    content,
    timestamp,
  }) as NormalizedMessage;

  const kept = [userRow('kept', 'continue', '2026-01-01T00:00:21.000Z')];
  const echo = {
    ...userRow('local_1', 'continue', '2026-01-01T00:00:20.000Z'),
    replacesAnchorId: 'turn-b',
    replacesAfterRowCount: kept.length,
  } as NormalizedMessage;

  assert.deepEqual(removeOptimisticUserEchoes(kept, [echo]), [echo]);

  // Once the provider has written the replacement, it is a row the cut did not
  // keep, so it retires the echo.
  const persisted = [...kept, userRow('persisted', 'continue', '2026-01-01T00:00:25.000Z')];
  assert.deepEqual(removeOptimisticUserEchoes(persisted, [echo]), []);
});

test('native send identities retire both the first optimistic input and an accepted correction despite turn-start timestamps', () => {
  const native = (id: string, content: string, clientMessageId: string) =>
    createUserMessage(id, '2026-09-14T06:30:46.000Z', { provider: 'codex', content, clientMessageId });
  const history = [
    native('native-first', '这条从codey发送', 'send-first'),
    native('native-second', '测试追加 0111', 'send-second'),
  ];
  const live = [
    { ...history[0], id: 'local_first', timestamp: '2026-09-14T06:31:29.000Z' },
    { ...history[1], id: 'steer_request', timestamp: '2026-09-14T06:31:49.000Z' },
  ];
  assert.deepEqual(removeOptimisticUserEchoes(history, live), []);
});

test('an exact native identity does not rely on clock skew, text normalization or attachment representation', () => {
  const local = createUserMessage('local_first', '2026-09-14T16:31:29.000Z', {
    provider: 'codex', content: 'See notes', clientMessageId: 'same-input',
    images: [{ path: '/uploads/image.png' }],
  });
  const persisted = createUserMessage('native-first', '2026-09-14T06:30:46.000Z', {
    provider: 'codex', content: 'See notes\n<normalized attachment>', clientMessageId: 'same-input',
  });
  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('two intentional identical corrections reconcile separately, including a lagging partial history', () => {
  const first = createUserMessage('steer_first', '2026-09-14T06:31:29.000Z', {
    provider: 'codex', content: 'continue', clientMessageId: 'input-first',
  });
  const second = { ...first, id: 'steer_second', clientMessageId: 'input-second' };
  const history = [first, second].map((row) => ({
    ...row, id: `native_${row.id}`, timestamp: '2026-09-14T06:00:00.000Z',
  }));
  assert.deepEqual(removeOptimisticUserEchoes([history[0]], [first, second]), [second]);
  assert.deepEqual(removeOptimisticUserEchoes(history, [first, second]), []);
});

test('different known identities never fall back to matching the same text and time', () => {
  const local = createUserMessage('local_new', '2026-09-14T06:31:29.000Z', {
    content: 'continue', clientMessageId: 'new-input',
  });
  const prior = { ...local, id: 'native_prior', clientMessageId: 'different-input' };
  assert.deepEqual(removeOptimisticUserEchoes([prior], [local]), [local]);
});

test('native identities are provider/session scoped and retain the edit truncation boundary', () => {
  const local = createUserMessage('local_new', '2026-09-14T06:31:29.000Z', {
    provider: 'codex', content: 'continue', clientMessageId: 'same-input',
  });
  for (const change of [{ sessionId: 'another-session' }, { provider: 'claude' as const }]) {
    assert.deepEqual(removeOptimisticUserEchoes([{ ...local, id: 'native', ...change }], [local]), [local]);
  }
  const replacement = { ...local, replacesAfterRowCount: 1, replacesAnchorId: 'turn-b' };
  assert.deepEqual(removeOptimisticUserEchoes([{ ...local, id: 'native' }], [replacement]), [replacement]);
});

test('exact identities reserve their native rows before legacy fuzzy echoes are considered', () => {
  const known = createUserMessage('steer_exact', '2026-09-14T06:31:29.000Z', {
    content: 'continue', clientMessageId: 'known-input',
  });
  const legacy = { ...known, id: 'local_legacy', clientMessageId: undefined };
  assert.deepEqual(removeOptimisticUserEchoes([{ ...known, id: 'native' }], [legacy, known]), [legacy]);
});
