import { expect, test } from 'vitest';

import { sessionMessagesUrl } from '@/shared/api';

test('history URLs encode native anchors and keep snapshot handles for unbounded reads', () => {
  const url = new URL(sessionMessagesUrl('session/a', {
    limit: 20, offset: 40, snapshotId: 'snapshot-id', before: 'turn:item/1?index=0&x=中文',
  }), 'https://example.test');
  expect(url.pathname).toBe('/api/providers/sessions/session%2Fa/messages');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    limit: '20', offset: '40', snapshotId: 'snapshot-id', before: 'turn:item/1?index=0&x=中文',
  });
  expect(sessionMessagesUrl('a', { limit: null, snapshotId: 'snapshot-id' }))
    .toBe('/api/providers/sessions/a/messages?snapshotId=snapshot-id');
  expect(sessionMessagesUrl('a')).toBe('/api/providers/sessions/a/messages');
});
