import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readAntigravityTokenUsage } from '@/modules/providers/list/antigravity/antigravity-usage.service.js';

const id = 'c322bae1-d4a0-4797-8c45-c9cfce50e8a9';
const row = (index: number, input: number, cached: number, output: number) => ({
  step_index: index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
  input_tokens: input, cache_read_tokens: cached, output_tokens: output,
});

test('native SDK logs recover old/interrupted usage, cache hits and subagent spend without confusing context', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'antigravity-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'messages.jsonl');
  await writeFile(transcript, JSON.stringify({ kind: 'status', text: 'antigravity_usage',
    googleUsage: { total_token_count: 125 } }) + '\n{partial');
  async function log(agent: string, rows: unknown[]) {
    const directory = path.join(root, 'sdk', 'app', 'brain', agent, '.system_generated', 'logs');
    await mkdir(path.join(directory, 'chunks'), { recursive: true });
    const content = rows.map(r => JSON.stringify(r)).join('\n') + '\n{partial';
    await writeFile(path.join(directory, 'transcript_full.jsonl'), content);
    await writeFile(path.join(directory, 'transcript.jsonl'), content);
    await writeFile(path.join(directory, 'chunks', '00000000.jsonl'), content);
  }
  await log(id, [row(1, 40, 60, 25), row(3, 60, 100, 10), row(3, 60, 100, 10),
    row(4, -10, 0, 0), { ...row(5, 800, 0, 50), source: 'USER_EXPLICIT' },
    { ...row(6, 0, 0, 0), status: 'ERROR' }]);
  await log('abcd1234', [row(1, 10, 5, 5)]);
  const options = { contextWindow: 1_000_000, sdkUsage: { total_token_count: 315 } };
  const expected = { used: 170, total: 1_000_000, sessionTokens: 315, contextUsageAvailable: true,
    inputTokens: 160, outputTokens: 10, cacheReadTokens: 100, breakdown: { input: 160, output: 10 } };
  assert.deepEqual(await readAntigravityTokenUsage(id, transcript, options), expected);
  // Cumulative snapshots and repeated reloads are not added as new spend.
  assert.deepEqual(await readAntigravityTokenUsage(id, transcript, options), expected);
  assert.deepEqual(await readAntigravityTokenUsage(id, transcript, { contextWindow: 1_000_000 }), expected);
  // A compacted main request can shrink while cumulative spend keeps growing.
  await log(id, [row(1, 40, 60, 25), row(3, 60, 100, 10), row(6, 10, 0, 2)]);
  const compacted = await readAntigravityTokenUsage(id, transcript, options);
  assert.equal(compacted.used, 12);
  assert.equal(compacted.sessionTokens, 327);
});

test('missing native context stays unknown, and saved normalized usage survives missing SDK logs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'antigravity-usage-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'messages.jsonl');
  await writeFile(transcript, JSON.stringify({ kind: 'status', text: 'antigravity_usage',
    googleUsage: { total_token_count: 250, cached_content_token_count: 100 } }));
  const legacy = await readAntigravityTokenUsage(id, transcript);
  assert.equal(legacy.sessionTokens, 250);
  assert.equal(legacy.contextUsageAvailable, false);
  assert.equal(legacy.used, 0);
  assert.equal(legacy.cacheReadTokens, 100);
  const snapshot = { used: 50, total: 1_000_000, sessionTokens: 300, contextUsageAvailable: true,
    inputTokens: 40, outputTokens: 10, cacheReadTokens: 20, breakdown: { input: 40, output: 10 } };
  await writeFile(transcript, JSON.stringify({ kind: 'status', text: 'token_budget', tokenBudget: snapshot }));
  assert.deepEqual(await readAntigravityTokenUsage(id, transcript, { sdkUsage: { total_token_count: 250 } }), snapshot);
});
