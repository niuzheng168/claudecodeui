import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLookupMap } from '@/shared/index.js';

test('JSONL lookups keep first-seen names by default but support append-only rename indexes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-name-index-'));
  try {
    const file = path.join(root, 'session_index.jsonl');
    await writeFile(file, [
      JSON.stringify({ id: 'thread', thread_name: 'Original title' }),
      '', 'null', '[]', '{incomplete',
      JSON.stringify({ id: 'thread', thread_name: 'Renamed title' }),
      JSON.stringify({ id: 'other', thread_name: 'Other session' }),
      JSON.stringify({ id: 'thread', thread_name: 123 }),
      '{"id":"thread","thread_name":',
    ].join('\n'));
    assert.deepEqual([...await buildLookupMap(file, 'id', 'thread_name')], [
      ['thread', 'Original title'], ['other', 'Other session'],
    ]);
    assert.deepEqual([...await buildLookupMap(file, 'id', 'thread_name', 'last')], [
      ['thread', 'Renamed title'], ['other', 'Other session'],
    ]);
    assert.equal((await buildLookupMap(path.join(root, 'missing.jsonl'), 'id', 'thread_name', 'last')).size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
