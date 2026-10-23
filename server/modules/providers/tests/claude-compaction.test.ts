import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-compaction-1';

/**
 * A compaction is drawn through its summary row: the boundary and the
 * `compacting` status normalize to nothing (the runtime names a running
 * compaction in the activity label instead; see claude-local-commands.test.ts).
 * What the client needs from the server is the summary's flag.
 */
test('the summary keeps its flag, so the client can fold it into the row', () => {
  const [row] = provider.normalizeMessage({
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
  }, SESSION_ID);

  assert.equal(row.role, 'assistant');
  assert.equal(row.isCompactSummary, true);
});
