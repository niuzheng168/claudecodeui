import { createReadStream, type Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { antigravityGateway } from '@/modules/providers/list/antigravity/antigravity-gateway.service.js';
import { readObjectRecord } from '@/shared/index.js';
import type { AnyRecord, NormalizedMessage, ProviderTokenUsage } from '@/shared/index.js';

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

async function journal(file: string): Promise<AnyRecord[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').flatMap(line => {
      try { return [readObjectRecord(JSON.parse(line)) ?? {}]; }
      catch { return []; }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Runtime, history and the token-usage endpoint share this read-only snapshot.
 * SDK cumulative snapshots are replacements, never deltas. Native full logs
 * recover old/interrupted turns and the latest main-agent request's context:
 * the SDK's public Step.usage_metadata is always null in the pinned harness.
 * Only full logs count (not their chunks/compact transcript copies); subagent
 * requests contribute to spend, never to the main conversation's context.
 */
export async function readAntigravityTokenUsage(
  nativeId: string,
  transcript: string,
  options: {
    messages?: NormalizedMessage[];
    sdkUsage?: unknown;
    contextWindow?: number;
    model?: string;
  } = {},
): Promise<ProviderTokenUsage> {
  const messages = options.messages ?? await journal(transcript);
  let saved: AnyRecord | undefined;
  let lastSdkUsage: AnyRecord | undefined;
  let sessionTokens: number | undefined;
  for (const message of messages) {
    if (message.kind !== 'status') continue;
    if (message.text === 'token_budget') {
      const value = readObjectRecord(message.tokenBudget);
      if (value) saved = value;
      const total = count(value?.sessionTokens);
      if (total !== undefined) sessionTokens = Math.max(sessionTokens ?? 0, total);
    } else if (message.text === 'antigravity_usage') {
      lastSdkUsage = readObjectRecord(message.googleUsage) ?? lastSdkUsage;
      const total = count(lastSdkUsage?.total_token_count);
      if (total !== undefined) sessionTokens = Math.max(sessionTokens ?? 0, total);
    }
  }
  const sdkTotal = count(readObjectRecord(options.sdkUsage)?.total_token_count);
  lastSdkUsage = readObjectRecord(options.sdkUsage) ?? lastSdkUsage;
  if (sdkTotal !== undefined) sessionTokens = Math.max(sessionTokens ?? 0, sdkTotal);

  let latest: { input: number; output: number; cached: number } | undefined;
  let nativeTotal: number | undefined;
  // SDK save/app dirs are private to this conversation. Never follow symlink
  // agent directories or a user-supplied path from a transcript row.
  const brain = path.join(path.dirname(transcript), 'sdk', 'app', 'brain');
  let agents: Dirent[];
  try { agents = await readdir(brain, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    agents = [];
  }
  for (const agent of agents) {
    if (!agent.isDirectory() || !/^[a-f\d-]{1,64}$/i.test(agent.name)) continue;
    const file = path.join(brain, agent.name, '.system_generated', 'logs', 'transcript_full.jsonl');
    const steps = new Map<number, { input: number; output: number; cached: number }>();
    try {
      const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        let row: AnyRecord | null;
        try { row = readObjectRecord(JSON.parse(line)); }
        catch { continue; } // A writer may still be appending the final row.
        if (row?.source !== 'MODEL' || row.type !== 'PLANNER_RESPONSE'
          || count(row.step_index) === undefined) continue;
        const input = count(row.input_tokens);
        const output = count(row.output_tokens);
        const cached = count(row.cache_read_tokens) ?? 0;
        if (input === undefined || output === undefined || input + cached + output === 0) continue;
        // Unlike Gemini usageMetadata, these native log inputs EXCLUDE cache
        // hits. Native output already includes thinking; add neither twice.
        steps.set(row.step_index, { input: input + cached, output, cached });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const usage of steps.values()) nativeTotal = (nativeTotal ?? 0) + usage.input + usage.output;
    if (agent.name === nativeId && steps.size) {
      let newest = -1;
      for (const [index, usage] of steps) if (index > newest) { newest = index; latest = usage; }
    }
  }
  if (nativeTotal !== undefined) sessionTokens = Math.max(sessionTokens ?? 0, nativeTotal);
  const input = latest?.input ?? count(saved?.inputTokens) ?? 0;
  const output = latest?.output ?? count(saved?.outputTokens) ?? 0;
  const used = latest ? input + output : count(saved?.used) ?? 0;
  const contextAvailable = Boolean(latest) || (saved?.contextUsageAvailable !== false && count(saved?.used) !== undefined);
  const window = options.contextWindow ?? count(saved?.total)
    ?? (options.model ? await antigravityGateway.getContextWindow(options.model) : undefined);
  return {
    used,
    ...(window ? { total: window } : {}),
    ...(sessionTokens !== undefined ? { sessionTokens } : {}),
    contextUsageAvailable: contextAvailable,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: latest?.cached ?? count(saved?.cacheReadTokens)
      ?? count(lastSdkUsage?.cached_content_token_count) ?? 0,
    breakdown: { input, output },
  };
}
