import fsSync, { type Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { codeyClaudeGateway } from '@/modules/providers/services/codey-claude-gateway.service.js';
import type { AnyRecord } from '@/shared/types.js';
import { AppError, getOpenCodeDatabasePath } from '@/shared/utils.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type FileTail = {
  content: string;
  /** True when `content` is the whole file, not just its trailing bytes. */
  isComplete: boolean;
};

type ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  getHomeDirectory: () => string;
  getOpenCodeDatabasePath: () => string;
  fileExists: (filePath: string) => boolean;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  readTextFile: (filePath: string) => Promise<string>;
  readTextFileTail: (filePath: string, maxBytes: number) => Promise<FileTail>;
  getClaudeContextWindow: (
    model: string | null | undefined,
    providerSessionId: string | null | undefined,
  ) => Promise<number | string | undefined>;
  readClaudeSessionTokens: (transcriptPath: string) => Promise<number>;
  isProviderSessionSuperseded: (providerSessionId: string, provider: string) => boolean;
};

type TokenUsageResult = {
  /** Tokens the context window holds: the newest request's prompt and reply. */
  used: number;
  total?: number;
  /** Tokens every request of the session consumed, cached input included. */
  sessionTokens?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: {
    input: number;
    output: number;
  };
  unsupported?: boolean;
  message?: string;
};

type OpenCodeTokenRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/**
 * Both JSONL usage readers below only need the newest usage row, which sits at
 * or near the end of the transcript. Reading just this much of the tail keeps
 * a session-open usage lookup O(1) in the transcript's size; the rare tail
 * with no usage row at all falls back to the full read.
 */
const TOKEN_USAGE_TAIL_BYTES = 4 * 1024 * 1024;

const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  getHomeDirectory: () => os.homedir(),
  getOpenCodeDatabasePath,
  fileExists: (filePath) => fsSync.existsSync(filePath),
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
  readTextFileTail: async (filePath, maxBytes) => {
    const handle = await fsp.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      if (size <= maxBytes) {
        return { content: await handle.readFile({ encoding: 'utf8' }), isComplete: true };
      }

      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, size - maxBytes);
      const content = buffer.toString('utf8');
      // The window almost never starts on a row boundary; dropping everything
      // up to the first newline discards the partial row (and any split
      // multi-byte character with it).
      const firstNewline = content.indexOf('\n');
      return {
        content: firstNewline === -1 ? '' : content.slice(firstNewline + 1),
        isComplete: false,
      };
    } finally {
      await handle.close();
    }
  },
  getClaudeContextWindow: (model, providerSessionId) => resolveClaudeContextWindow(model, providerSessionId),
  readClaudeSessionTokens: async (transcriptPath) => (await readClaudeSessionTokens(transcriptPath)).total,
  isProviderSessionSuperseded: (providerSessionId, provider) =>
    sessionsDb.isProviderSessionSuperseded(providerSessionId, provider),
};

/**
 * Context windows the Claude SDK reported per provider session id.
 *
 * The SDK states the real window of the model that served a turn only in the
 * turn's `result.modelUsage[model].contextWindow`; the transcript records the
 * model id at most, and an id cannot tell a 200K from a 1M variant, nor what a
 * self-hosted model behind ANTHROPIC_BASE_URL allows. Remembering the reported
 * value lets the history-derived usage show the same window the live counter
 * did. It is process memory on purpose: after a restart the counter falls back
 * to CONTEXT_WINDOW until the session's next turn reports again.
 */
const reportedClaudeContextWindows = new Map<string, number>();

/** One number per session; the cap only bounds a long-lived server's memory. */
const MAX_REPORTED_CLAUDE_CONTEXT_WINDOWS = 1000;

/**
 * Used by the Claude runtime provider to record the window the SDK reported for
 * a session's turn. Non-positive or non-numeric values are ignored so a build
 * that reports no window never overwrites one that did.
 */
export function rememberClaudeContextWindow(providerSessionId: string, contextWindow: number): void {
  if (!providerSessionId || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return;
  }

  // Re-insert so the most recently reported sessions are the last evicted.
  reportedClaudeContextWindows.delete(providerSessionId);
  reportedClaudeContextWindows.set(providerSessionId, contextWindow);
  if (reportedClaudeContextWindows.size > MAX_REPORTED_CLAUDE_CONTEXT_WINDOWS) {
    const oldestSessionId = reportedClaudeContextWindows.keys().next().value;
    if (oldestSessionId !== undefined) {
      reportedClaudeContextWindows.delete(oldestSessionId);
    }
  }
}

/**
 * Used by the Claude runtime provider (a resumed run starts from the window its
 * session last reported) and by `resolveClaudeContextWindow` below, which both
 * Claude usage readers go through. Returns undefined when no run has reported
 * a window for the session.
 */
export function getReportedClaudeContextWindow(providerSessionId: string | null | undefined): number | undefined {
  return providerSessionId ? reportedClaudeContextWindows.get(providerSessionId) : undefined;
}

/**
 * Window a Claude session's counter reports. Used by both Claude usage readers
 * (the history page and the token-usage route): a managed node's model catalog
 * knows the session model's real window, and Claude Code is launched against
 * it, so it wins over what the CLI reports; otherwise the window the SDK last
 * reported for the session, then the CONTEXT_WINDOW setting. The runtime's
 * live counter applies the same order.
 */
export async function resolveClaudeContextWindow(
  model: string | null | undefined,
  providerSessionId?: string | null,
): Promise<number | string | undefined> {
  return await codeyClaudeGateway.getContextWindow(model)
    ?? getReportedClaudeContextWindow(providerSessionId)
    ?? process.env.CONTEXT_WINDOW;
}

function readUsageNumber(value: unknown): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

async function findCodexSessionFile(
  directoryPath: string,
  providerSessionId: string,
  dependencies: ProviderTokenUsageServiceDependencies,
): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await dependencies.readDirectory(directoryPath);
  } catch {
    // Codex session folders are date-partitioned and can disappear while a
    // cleanup is running. An unreadable branch is simply not a match.
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionFile(entryPath, providerSessionId, dependencies);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      return entryPath;
    }
  }

  return null;
}

function readCodexUsageBreakdown(usage: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const record = usage as AnyRecord;
  const inputTokens = readUsageNumber(record.input_tokens ?? record.inputTokens);
  const outputTokens = readUsageNumber(record.output_tokens ?? record.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: readUsageNumber(record.total_tokens ?? record.totalTokens) || inputTokens + outputTokens,
  };
}

/**
 * Usage from Codex's token report: a rollout's `token_count` info, or the
 * app-server's `thread/tokenUsage/updated` `tokenUsage` (camelCase, same
 * meaning). `last` is the newest request, i.e. what the context window holds;
 * `total` sums every request of the thread, cached input included.
 *
 * Used by the token-usage route, the Codex history reader and the native
 * runtime's live counter, so all three report the same numbers.
 */
export function readCodexTokenUsage(info: unknown): TokenUsageResult | null {
  if (!info || typeof info !== 'object') {
    return null;
  }
  const record = info as AnyRecord;
  const sessionUsage = readCodexUsageBreakdown(record.total_token_usage ?? record.total);
  // Rollouts from before Codex reported the newest request only carry the total.
  const contextUsage = readCodexUsageBreakdown(record.last_token_usage ?? record.last) ?? sessionUsage;
  if (!contextUsage) {
    return null;
  }

  return {
    used: contextUsage.totalTokens,
    total: readUsageNumber(record.model_context_window ?? record.modelContextWindow) || 200_000,
    ...(sessionUsage ? { sessionTokens: sessionUsage.totalTokens } : {}),
    inputTokens: contextUsage.inputTokens,
    outputTokens: contextUsage.outputTokens,
    breakdown: { input: contextUsage.inputTokens, output: contextUsage.outputTokens },
  };
}

/** Newest `token_count` snapshot in the given JSONL text, or null when it has none. */
function findCodexTokenUsage(fileContent: string): TokenUsageResult | null {
  const lines = fileContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const usage = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
        ? readCodexTokenUsage(entry.payload.info)
        : null;
      if (usage) {
        return usage;
      }
    } catch {
      // A provider may be writing the last JSONL line while this read happens.
    }
  }

  return null;
}

function emptyCodexTokenUsage(): TokenUsageResult {
  return {
    used: 0,
    total: 200_000,
    sessionTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
  };
}

/**
 * Latest context-window usage from a Claude transcript's already-parsed rows.
 *
 * Exported because the session-messages reader hands the same usage back on
 * every history page, the way the Codex and OpenCode readers do. Without that,
 * a Claude session's counter only moved when the session was reselected, and
 * the store's "this provider reports no usage" path overwrote it with zero.
 *
 * Reads the newest assistant turn only: `input_tokens + cache_read +
 * cache_creation` is that one request's whole prompt, i.e. what the context
 * window currently holds. Summing turns would count the same cached prefix
 * once per turn.
 *
 * The total is the window `resolveClaudeContextWindow` picked for the session
 * (the managed catalog's, else the one the SDK reported, else the
 * CONTEXT_WINDOW setting), with 160K when none is known.
 *
 * `sessionTokens` is passed through when the caller counted it, which takes
 * the whole transcript (see `readClaudeSessionTokens`), not just these rows.
 */
export function summarizeClaudeTokenUsage(
  entries: AnyRecord[],
  configuredContextWindow: number | string | undefined = process.env.CONTEXT_WINDOW,
  sessionTokens?: number,
): TokenUsageResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // A subagent's turns report the subagent's context window, not this
    // conversation's; reading one makes the counter drop to the subagent's
    // number and bounce back on the next main-thread turn.
    if (entry?.isSidechain === true) {
      continue;
    }

    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    if (!usage) {
      continue;
    }

    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
    const rowCacheReadTokens = readUsageNumber(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
    );
    const rowCacheCreationTokens = readUsageNumber(
      usage.cache_creation_input_tokens
        ?? usage.cacheCreationInputTokens
        ?? usage.cacheCreationTokens,
    );
    const rowInputTokens = directInputTokens + rowCacheReadTokens + rowCacheCreationTokens;
    const rowOutputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

    // `<synthetic>` rows — interrupts, API errors, "No response requested" —
    // are written with an all-zero usage block rather than none at all. They
    // never carried a prompt, so treating one as the newest turn zeroed a
    // counter that a live event had just set correctly.
    if (rowInputTokens === 0 && rowOutputTokens === 0) {
      continue;
    }

    cacheReadTokens = rowCacheReadTokens;
    cacheCreationTokens = rowCacheCreationTokens;
    inputTokens = rowInputTokens;
    outputTokens = rowOutputTokens;
    break;
  }

  const parsedContextWindow = Number.parseInt(String(configuredContextWindow ?? ''), 10);
  const contextWindow = Number.isFinite(parsedContextWindow) && parsedContextWindow > 0 ? parsedContextWindow : 160_000;
  const cacheTokens = cacheReadTokens + cacheCreationTokens;

  return {
    used: inputTokens + outputTokens,
    total: contextWindow,
    ...(sessionTokens !== undefined ? { sessionTokens } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

/**
 * The tokens one main-thread Claude API request consumed (its whole prompt,
 * cached input included, plus its reply), keyed by the API message id.
 *
 * Claude Code writes one transcript row per content block and the SDK streams
 * one message per block, all repeating the request's usage, so the id is what
 * counts a request once. Subagent requests are left out: they never enter this
 * session's context, and their transcripts live in files of their own.
 *
 * Used by `readClaudeSessionTokens` for transcript rows and by the Claude
 * runtime for the SDK messages of a live turn.
 */
export function readClaudeRequestTokens(entry: AnyRecord | null | undefined): { id: string; tokens: number } | null {
  if (entry?.type !== 'assistant' || entry.isSidechain === true || entry.parent_tool_use_id) {
    return null;
  }
  const usage = entry.message?.usage;
  const id = entry.message?.id ?? entry.uuid;
  if (!usage || typeof usage !== 'object' || typeof id !== 'string' || !id) {
    return null;
  }

  const tokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens)
    + readUsageNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens)
    + readUsageNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens)
    + readUsageNumber(usage.output_tokens ?? usage.outputTokens);
  // `<synthetic>` rows carry an all-zero usage block and made no request.
  return tokens > 0 ? { id, tokens } : null;
}

/** A transcript's counted requests, and how far into the file they were read. */
export type ClaudeSessionTokenLedger = {
  total: number;
  requestIds: Set<string>;
  /** Bytes read so far; always the end of a whole line. */
  offset: number;
  inode: number;
};

/**
 * Ledgers by transcript path. A transcript only ever grows, so a later read
 * picks up where the last one stopped instead of parsing the file again; the
 * history reader, the token-usage route and every Claude run share them.
 */
const claudeSessionTokenLedgers = new Map<string, ClaudeSessionTokenLedger>();
const claudeSessionTokenReads = new Map<string, Promise<ClaudeSessionTokenLedger>>();
/** One ledger per recently used session; the cap only bounds a long-lived server's memory. */
const MAX_CLAUDE_SESSION_TOKEN_LEDGERS = 100;
const CLAUDE_TRANSCRIPT_READ_CHUNK_BYTES = 4 * 1024 * 1024;

function countClaudeTranscriptLines(ledger: ClaudeSessionTokenLedger, text: string): void {
  for (const line of text.split('\n')) {
    // Only assistant rows carry usage; skipping the rest unparsed keeps a
    // transcript full of tool output and images cheap to read.
    if (!line.includes('"usage"')) {
      continue;
    }
    let request: ReturnType<typeof readClaudeRequestTokens>;
    try {
      request = readClaudeRequestTokens(JSON.parse(line) as AnyRecord);
    } catch {
      continue;
    }
    if (request && !ledger.requestIds.has(request.id)) {
      ledger.requestIds.add(request.id);
      ledger.total += request.tokens;
    }
  }
}

async function updateClaudeSessionTokenLedger(transcriptPath: string): Promise<ClaudeSessionTokenLedger> {
  const handle = await fsp.open(transcriptPath, 'r');
  try {
    const { size, ino } = await handle.stat();
    const previous = claudeSessionTokenLedgers.get(transcriptPath);
    // A replaced or truncated file is a different transcript: count it afresh.
    // Updated in place: a run holding it sees the newest count, and `total`
    // and `requestIds` change together, so they agree at every await below.
    const ledger = previous && previous.inode === ino && previous.offset <= size
      ? previous
      : { total: 0, requestIds: new Set<string>(), offset: 0, inode: ino };

    let position = ledger.offset;
    let pending = Buffer.alloc(0);
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(CLAUDE_TRANSCRIPT_READ_CHUNK_BYTES, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      const data = pending.length > 0 ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      // Splitting on the newline byte keeps multi-byte characters whole; a
      // last line without one may still be being written and waits.
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        pending = data;
        continue;
      }
      countClaudeTranscriptLines(ledger, data.toString('utf8', 0, lastNewline));
      pending = data.subarray(lastNewline + 1);
    }
    ledger.offset = position - pending.length;

    claudeSessionTokenLedgers.delete(transcriptPath);
    claudeSessionTokenLedgers.set(transcriptPath, ledger);
    if (claudeSessionTokenLedgers.size > MAX_CLAUDE_SESSION_TOKEN_LEDGERS) {
      const oldestPath = claudeSessionTokenLedgers.keys().next().value;
      if (oldestPath !== undefined) {
        claudeSessionTokenLedgers.delete(oldestPath);
      }
    }
    return ledger;
  } finally {
    await handle.close();
  }
}

/**
 * Every token a Claude session's requests consumed, read from its transcript:
 * each main-thread request counted once (see `readClaudeRequestTokens`), on
 * every branch the file holds, since an abandoned branch was paid for too.
 *
 * Used by the Claude history reader and the token-usage route for the
 * composer's session total, and by the Claude runtime as the base its live
 * turns add to. Rejects when the transcript cannot be read.
 */
export async function readClaudeSessionTokens(transcriptPath: string): Promise<ClaudeSessionTokenLedger> {
  // Concurrent readers of one file share a read rather than racing to update it.
  const inFlight = claudeSessionTokenReads.get(transcriptPath);
  if (inFlight) {
    return inFlight;
  }
  const read = updateClaudeSessionTokenLedger(transcriptPath).finally(() => {
    claudeSessionTokenReads.delete(transcriptPath);
  });
  claudeSessionTokenReads.set(transcriptPath, read);
  return read;
}

/**
 * Where Claude Code keeps a provider session's transcript: the path recorded
 * on the app session row when it is that session's, else the one Claude Code
 * derives from the working directory. Null when neither is known.
 *
 * Used by the Claude runtime to count a resumed session's earlier requests.
 */
export function resolveClaudeTranscriptPath(
  appSessionId: string | null | undefined,
  providerSessionId: string,
  cwd: string | null | undefined,
): string | null {
  const recordedPath = appSessionId ? sessionsDb.getSessionById(appSessionId)?.jsonl_path : null;
  if (recordedPath && path.basename(recordedPath) === `${providerSessionId}.jsonl`) {
    return recordedPath;
  }
  if (!cwd) {
    return null;
  }
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${providerSessionId}.jsonl`);
}

function parseClaudeUsageEntries(fileContent: string): AnyRecord[] {
  const entries: AnyRecord[] = [];
  for (const line of fileContent.trim().split('\n')) {
    try {
      entries.push(JSON.parse(line) as AnyRecord);
    } catch {
      // Skip malformed lines without discarding usage from earlier messages.
    }
  }
  return entries;
}

function claudeEntriesHaveUsage(entries: AnyRecord[]): boolean {
  return entries.some((entry) => entry?.type === 'assistant' && entry.message?.usage);
}

function readOpenCodeTokenUsage(databasePath: string, providerSessionId: string): TokenUsageResult {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = [
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
    ];

    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return {
        used: 0,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
        unsupported: true,
        message: 'Token usage tracking is not available in this OpenCode database schema',
      };
    }

    const row = database.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(providerSessionId) as OpenCodeTokenRow | undefined;

    if (!row) {
      throw new AppError('OpenCode session was not found.', {
        code: 'OPENCODE_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const inputTokens = readUsageNumber(row.inputTokens) + readUsageNumber(row.cacheReadTokens);
    const outputTokens = readUsageNumber(row.outputTokens);
    const used = readUsageNumber(row.inputTokens)
      + outputTokens
      + readUsageNumber(row.reasoningTokens)
      + readUsageNumber(row.cacheReadTokens)
      + readUsageNumber(row.cacheWriteTokens);

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  } finally {
    database.close();
  }
}

/**
 * Creates the provider token-usage service used by the provider routes. The
 * provider test suite supplies isolated filesystem and session dependencies so
 * every calculator can be exercised without touching a developer's real data.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    /**
     * Resolves all provider-specific storage details from one app-facing
     * session id, then returns the latest usage snapshot for that provider.
     */
    async getSessionTokenUsage(sessionId: string): Promise<TokenUsageResult> {
      const session = dependencies.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      // The fallback covers rows whose provider id was never recorded, and for
      // a session discovered from disk the app id *is* its provider id. That
      // stops being true the moment an edit rewinds the conversation off a
      // thread: until the replacement run announces its own id, the fallback
      // would resolve the retired transcript and report the discarded
      // conversation's usage against an empty one.
      if (
        !session.provider_session_id
        && dependencies.isProviderSessionSuperseded(sessionId, session.provider)
      ) {
        return {
          used: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
        };
      }

      const providerSessionId = session.provider_session_id || sessionId;

      if (session.provider === 'cursor') {
        return {
          used: 0,
          total: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking not available for Cursor sessions',
        };
      }

      if (session.provider === 'opencode') {
        const databasePath = dependencies.getOpenCodeDatabasePath();
        if (!dependencies.fileExists(databasePath)) {
          throw new AppError('OpenCode database was not found.', {
            code: 'OPENCODE_DATABASE_NOT_FOUND',
            statusCode: 404,
          });
        }

        return readOpenCodeTokenUsage(databasePath, providerSessionId);
      }

      if (session.provider === 'codex') {
        const indexedFilePath = session.jsonl_path && dependencies.fileExists(session.jsonl_path)
          ? session.jsonl_path
          : null;
        const sessionFilePath = indexedFilePath ?? await findCodexSessionFile(
          path.join(dependencies.getHomeDirectory(), '.codex', 'sessions'),
          providerSessionId,
          dependencies,
        );

        if (!sessionFilePath) {
          throw new AppError(`Codex session file for "${sessionId}" was not found.`, {
            code: 'CODEX_SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const tail = await dependencies.readTextFileTail(sessionFilePath, TOKEN_USAGE_TAIL_BYTES);
        const tailUsage = findCodexTokenUsage(tail.content);
        if (tailUsage || tail.isComplete) {
          return tailUsage ?? emptyCodexTokenUsage();
        }

        // A tail this large with no token_count row is pathological, but the
        // whole file is still authoritative when it happens.
        return findCodexTokenUsage(await dependencies.readTextFile(sessionFilePath))
          ?? emptyCodexTokenUsage();
      }

      let sessionFilePath = session.jsonl_path;
      if (!sessionFilePath) {
        if (!session.project_path) {
          throw new AppError(`Session file for "${sessionId}" was not found.`, {
            code: 'SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const encodedProjectPath = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDirectory = path.join(
          dependencies.getHomeDirectory(),
          '.claude',
          'projects',
          encodedProjectPath,
        );
        sessionFilePath = path.join(projectDirectory, `${providerSessionId}.jsonl`);

        const relativePath = path.relative(path.resolve(projectDirectory), path.resolve(sessionFilePath));
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          throw new AppError('Resolved session path is invalid.', {
            code: 'INVALID_SESSION_PATH',
            statusCode: 400,
          });
        }
      }

      if (!dependencies.fileExists(sessionFilePath)) {
        throw new AppError(`Session file for "${sessionId}" was not found.`, {
          code: 'SESSION_FILE_NOT_FOUND',
          statusCode: 404,
        });
      }

      const tail = await dependencies.readTextFileTail(sessionFilePath, TOKEN_USAGE_TAIL_BYTES);
      let entries = parseClaudeUsageEntries(tail.content);
      if (!claudeEntriesHaveUsage(entries) && !tail.isComplete) {
        entries = parseClaudeUsageEntries(await dependencies.readTextFile(sessionFilePath));
      }
      return summarizeClaudeTokenUsage(
        entries,
        await dependencies.getClaudeContextWindow(session.model, providerSessionId),
        await dependencies.readClaudeSessionTokens(sessionFilePath),
      );
    },
  };
}

/**
 * Used by the provider routes to serve token usage from only an app session id.
 */
export const providerTokenUsageService = createProviderTokenUsageService();
