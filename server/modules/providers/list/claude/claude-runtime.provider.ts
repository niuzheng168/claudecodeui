/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ElicitationRequest, ElicitationResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import {
  buildClaudeContextLaunch,
  claudeCodeRefusesBypassPermissions,
  codeyClaudeGateway
} from '@/modules/providers/services/codey-claude-gateway.service.js';
import {
  AppError,
  appendFilesInputTag,
  buildClaudeUserContent,
  createCompleteMessage,
  createNormalizedMessage,
  errorMessage,
  normalizeImageDescriptors,
  readObjectRecord,
  resolveClaudeCodeExecutablePath,
} from '@/shared/index.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  CODEY_CLAUDE_ENTRYPOINT,
  endForeignSessionProcess,
  findForeignSessionProcess,
  followForeignTurn,
  isClaudeDesktopProcess,
  isTranscriptContinuedElsewhere,
  readForeignSessionStatus,
  signalForeignSessionProcess
} from '@/modules/providers/list/claude/claude-session-owner.service.js';
import { askClaudeSideQuestion } from '@/modules/providers/list/claude/claude-side-question.provider.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { sessionHistoryCache } from '@/modules/providers/services/session-history-cache.service.js';
import {
  getReportedClaudeContextWindow,
  readClaudeRequestTokens,
  readClaudeSessionTokens,
  rememberClaudeContextWindow,
  resolveClaudeTranscriptPath
} from '@/modules/providers/services/provider-token-usage.service.js';
import type {
  AnyRecord,
  BackgroundTaskSummary,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  ProviderRuntimeObservation,
  ProviderAbortOptions,
  ScheduledTaskSummary,
  SideQuestionRequest,
  SideQuestionSink,
  SideQuestionOutcome,
} from '@/shared/index.js';

// The notifications module is still JavaScript, and its defaults (`dedupeKey = null`)
// infer as the only accepted types; this states the shape callers really pass.
const notificationEvent = createNotificationEvent as (event: AnyRecord) => unknown;

type ClaudeQuery = ReturnType<NonNullable<ProviderRuntimeContext['createQuery']>>;

/** The run's writer: the WebSocket writer adds a socket swap for reconnects. */
type ClaudeRuntimeWriter = ProviderRuntimeWriter & { updateWebSocket?(rawWs: unknown): void };

type ToolApprovalDecision = AnyRecord | null;

/** A pending approval's resolver, carrying the lookup fields getPendingApprovalsForSession reads. */
type ToolApprovalResolver = ((decision: ToolApprovalDecision) => void) & AnyRecord;

/**
 * A context-window reading. `used` is what the window holds; `total` is its size.
 */
type TokenBudget = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: { input: number; output: number };
};


// The resident process outlives individual turns; its sinks are rebound for each turn.
type ClaudeTurn = {
  steering: {
    canSteer(): boolean;
    steer(command: string, options?: AnyRecord): Promise<{ clientMessageId: string }>;
    cancelPending(): Promise<unknown[]>;
  };
  onMessage(message: AnyRecord): void;
  onEnd(error?: unknown): Promise<void>;
};
type ClaudeProcess = {
  key: string | null;
  instance: ClaudeQuery & { cancelAsyncMessage?(id: string): Promise<unknown> };
  signature: string;
  resident: boolean;
  status: 'active' | 'idle' | 'aborted';
  startedAt: number;
  turn: ClaudeTurn | null;
  writer: ClaudeRuntimeWriter;
  sessionSummary: string | null;
  appSessionId: string | null;
  providerSessionId: string | null;
  contextWindow: number | undefined;
  reportedContextWindow: number | null;
  mainThreadModel: string | null;
  sessionTokenLedger: Pick<Awaited<ReturnType<typeof readClaudeSessionTokens>>, 'total' | 'requestIds'> | null;
  liveRequestTokens: Map<string, number>;
  normalizeMessage: ProviderRuntimeContext['normalizeMessage'];
  startFollowUpRun: ProviderRuntimeContext['startFollowUpRun'];
  followUpRun: boolean;
  cliBusy: boolean;
  backgroundWorkPending: boolean;
  sawTaskEventThisTurn: boolean;
  heldForBackgroundWork: boolean;
  scheduledTasks: ScheduledTaskSummary[] | null;
  retireAfterTurn: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  retired: boolean;
  lastActiveAt: number;
  push(message: unknown): boolean;
  releaseInput(): void;
  inputReleased: boolean;
  pendingNativeSideQuestions: number;
  releaseDeferred: boolean;
  ended: Promise<void>;
};
type ForeignSessionProcess = NonNullable<Awaited<ReturnType<typeof findForeignSessionProcess>>>;
type ClaudeProcessInit = Pick<ClaudeProcess,
  'signature' | 'resident' | 'turn' | 'writer' | 'sessionSummary' | 'appSessionId'
  | 'providerSessionId' | 'contextWindow' | 'normalizeMessage' | 'startFollowUpRun'
> & {
  sdkOptions: AnyRecord;
  promptMessage: AnyRecord;
  createQuery?: ProviderRuntimeContext['createQuery'];
  unattended?: boolean;
};

// Session key -> the Claude Code process serving it, whether a turn is
// running in it ('active') or it is resident between turns ('idle').
const activeSessions = new Map<string, ClaudeProcess>();
// Session key -> exit of a retired process that may still be writing its transcript.
const exitingProcesses = new Map<string, Promise<void>>();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the process registered under the key: cleared
// when that process is retired or ends, and reset when another one takes the
// key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map<string, ToolApprovalResolver>();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set<string>();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();
// Session key -> the turn waiting for Claude Desktop or a terminal to finish
// a turn of the session before taking it over; aborting it cancels the wait.
const foreignTurnWaits = new Map<string, AbortController>();
// Session key -> a turn Claude Desktop or a terminal is running that an open
// tab follows (see prepareClaudeObservation), with what Stop interrupts.
const observedForeignTurns = new Map<string, { owner: ForeignSessionProcess; following: AbortController }>();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS ?? '', 10) || 55000;

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, background work releases it as soon as it reports back, and a
// new turn supersedes the previous hold. This ceiling only catches background work
// that never reports at all, so an abandoned session cannot leak a CLI process
// forever. The timer resets on every message, so it measures silence, not total time.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

// Steering that misses a turn's last tool boundary runs as a follow-up turn,
// which the CLI starts (with a `system init`) right after the `result`. If none
// starts within this grace period, the turn is settled instead of left running.
const STEER_FOLLOW_UP_GRACE_MS = 30 * 1000;

function readNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// A session's Claude Code process stays resident between its turns, so the
// next turn skips the CLI start, the transcript reload and the MCP server
// connections (about 1-1.5 s per turn on a node with Agency's MCP servers,
// measured with short replies). An idle process holds roughly 200 MB plus its
// MCP servers, so idle ones are bounded in time and number.
// CLAUDE_MAX_IDLE_PROCESSES=0 restores one process per turn.
const idleProcessTimeoutMs = () => readNonNegativeInteger(process.env.CLAUDE_IDLE_PROCESS_TIMEOUT_MS, 10 * 60 * 1000);
const maxIdleProcesses = () => readNonNegativeInteger(process.env.CLAUDE_MAX_IDLE_PROCESSES, 3);
// The longest a turn waits for a retired process of its session to exit.
const RETIRE_WAIT_MS = 5000;
// The longest a turn waits for Claude Desktop's or a terminal's process to
// exit when it takes their session over.
const TAKE_OVER_EXIT_WAIT_MS = 5000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An MCP server's request for input travels as a permission request under this
// name. It is not a tool the model can call: the name routes the request to the
// client's McpElicitation panel and keys it in the pending-approval list, so a
// page refresh replays it like any other prompt.
const MCP_ELICITATION_TOOL_NAME = 'McpElicitation';

/**
 * Turns the client's answer to an McpElicitation request into the MCP result.
 * The panel accepts with `updatedInput.content` and declines with a denial. No
 * answer at all (an abort, a closed run) is `cancel`, never an invented accept.
 */
function toElicitationResult(decision: ToolApprovalDecision, mode: ElicitationRequest['mode']): ElicitationResult {
  if (!decision || decision.cancelled) {
    return { action: 'cancel' };
  }
  if (!decision.allow) {
    return { action: 'decline' };
  }
  // A URL request is accepted without content: accepting is consent to open
  // the page, and the server learns the outcome from the page itself.
  if (mode === 'url') {
    return { action: 'accept' };
  }
  const content = (decision.updatedInput as AnyRecord | undefined)?.content;
  const fields: Record<string, string | number | boolean | string[]> = {};
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    for (const [key, value] of Object.entries(content as AnyRecord)) {
      // Form fields are flat primitives, or string lists for multi-select.
      const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      const isStringList = Array.isArray(value) && value.every((item) => typeof item === 'string');
      if (isPrimitive || isStringList) {
        fields[key] = value as string | number | boolean | string[];
      }
    }
  }
  return { action: 'accept', content: fields };
}

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

function resolveClaudeEffort(
  model: string,
  effort: unknown,
  modelsDefinition: ProviderModelsDefinition = CLAUDE_PREDEFINED_MODELS,
  { useCatalogDefault = false } = {},
): string | undefined {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  if (typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)) {
    return effort;
  }
  const catalogDefault = selectedModel?.effort?.default;
  return useCatalogDefault && allowedEfforts.includes(catalogDefault ?? '') ? catalogDefault : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions: AnyRecord, resolvedEffort: string | undefined) {
  if (!resolvedEffort) {
    return;
  }

  if (resolvedEffort !== CLAUDE_ULTRACODE_EFFORT) {
    sdkOptions.effort = resolvedEffort;
    return;
  }

  sdkOptions.effort = ULTRACODE_SDK_EFFORT;
  sdkOptions.settings = {
    ...(sdkOptions.settings || {}),
    ultracode: true,
    enableWorkflows: true
  };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

type ToolApprovalWaitOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onCancel?: (reason: string) => void;
  metadata?: AnyRecord;
};

function waitForToolApproval(requestId: string, options: ToolApprovalWaitOptions = {}): Promise<ToolApprovalDecision> {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise<ToolApprovalDecision>(resolve => {
    let settled = false;

    const finalize = (decision: ToolApprovalDecision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver: ToolApprovalResolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

export function resolveToolApproval(requestId: string, decision: ToolApprovalDecision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry: string, toolName: string, input: unknown) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof (input as AnyRecord).command === 'string') {
      command = (input as AnyRecord).command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * The CLI the SDK should launch, or undefined for the binary the SDK ships.
 * Shared by runs and by slash-command discovery, which must ask the same CLI.
 * @returns {string|undefined}
 */
export function resolveClaudeExecutableOption() {
  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  // When nothing resolves the option stays unset on purpose: the SDK then falls back to the
  // binary it ships, which beats handing it a bare `claude` that raw spawn can never launch.
  // Managed deployments already bundle a tested SDK binary. An explicitly
  // configured executable still wins; do not pick an unrelated global CLI.
  return codeyClaudeGateway.isManaged() && !process.env.CLAUDE_CLI_PATH
    ? undefined
    : resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
}

/**
 * Environment for the spawned CLI. Forwards all host env vars (e.g. ANTHROPIC_BASE_URL);
 * since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
 *
 * Claude Code turns the Artifact tools off for SDK-driven sessions unless
 * CLAUDE_CODE_ARTIFACT is set, so a session continued from this UI would lose them.
 * Default it on; a host value (e.g. CLAUDE_CODE_ARTIFACT=0) still wins.
 *
 * @param {NodeJS.ProcessEnv} [hostEnv] - Environment to forward, `process.env` by default
 * @returns {NodeJS.ProcessEnv} Environment for the spawned CLI
 */
export function buildClaudeSdkEnv(hostEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    CLAUDE_CODE_ARTIFACT: '1',
    CLAUDE_CODE_ENTRYPOINT: 'claudecodeui',
    ...hostEnv,
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS),
  };
}

function mapCliOptionsToSDK(options: AnyRecord = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions: AnyRecord = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = {
    ...buildClaudeSdkEnv(codeyClaudeGateway.buildEnvironment()),
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS),
    // What tells Codey's processes from Claude Desktop's or a terminal's
    // (see findForeignSessionProcess); never inherited from the node's shell.
    CLAUDE_CODE_ENTRYPOINT: CODEY_CLAUDE_ENTRYPOINT,
    // Per-process startup ticket; do not mutate the node's shared environment.
    CODEY_MEMORY_LAUNCH_ID: options.memoryLaunchId || '',
  };

  const claudeExecutablePath = resolveClaudeExecutableOption();
  if (claudeExecutablePath) {
    sdkOptions.pathToClaudeCodeExecutable = claudeExecutablePath;
  }

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }
  // Launching in bypassPermissions is enough. `allowDangerouslySkipPermissions`
  // only lets a session switch into it later, and Claude Code then applies
  // its root refusal to every mode, so it is deliberately never set.

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  applyClaudeEffort(sdkOptions, resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
    { useCatalogDefault: codeyClaudeGateway.isManaged() },
  ));

  // Only a managed catalog knows the model's real window; Claude Code would
  // otherwise size it from the model id. After effort, which keys on the id.
  if (options.contextWindow) {
    ({ model: sdkOptions.model, env: sdkOptions.env } = buildClaudeContextLaunch(
      sdkOptions.model,
      options.contextWindow,
      sdkOptions.env,
    ));
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  // `resumeFromScratch` is set when the very first prompt of a conversation was
  // edited: there is nothing before it to resume through, so the turn has to
  // start the conversation over instead.
  if (providerSessionId && !resumeFromScratch) {
    sdkOptions.resume = providerSessionId;

    // Editing an already-sent message re-runs the conversation truncated just
    // before it. `resumeSessionAt` is inclusive of the uuid it names, so the
    // caller resolves the last row to KEEP and passes that — never the edited
    // turn itself, which would leave the original prompt in context.
    if (resumeAnchorId) {
      sdkOptions.resumeSessionAt = resumeAnchorId;
    }
  }

  return sdkOptions;
}

const BYPASS_REFUSED_NOTICE = 'Full access is unavailable here: Claude Code refuses it when the node '
  + 'runs as root outside a sandbox. This turn runs in Default mode and asks before using tools. '
  + 'Run the node as a regular user, or set IS_SANDBOX=1 if it really is sandboxed.';

/**
 * Drops bypassPermissions from SDK options Claude Code would refuse to start
 * with. It exits with only a stderr line the SDK discards, so the turn would
 * otherwise fail as "process exited with code 1" before doing anything.
 * The run falls back to `default`, where Codey's approval prompts keep the
 * turn usable; emulating bypass through canUseTool would defeat the CLI's guard.
 * @param {Object} sdkOptions - Options from mapCliOptionsToSDK; updated in place
 * @param {number|undefined} [uid] - Process uid, injectable for tests
 * @returns {string|null} Notice for the user when the mode was withdrawn
 */
function withdrawRefusedBypassMode(sdkOptions: AnyRecord, uid = process.getuid?.()) {
  if (sdkOptions.permissionMode !== 'bypassPermissions'
    || !claudeCodeRefusesBypassPermissions(sdkOptions.env || {}, uid)) {
    return null;
  }
  delete sdkOptions.permissionMode;
  return BYPASS_REFUSED_NOTICE;
}

/**
 * Names the Claude Code process outside Codey that has a session open.
 * @param {{ pid: number, entrypoint: string }} owner - From findForeignSessionProcess
 * @returns {string}
 */
function describeForeignProcess(owner: ForeignSessionProcess) {
  return isClaudeDesktopProcess(owner)
    ? `Claude Desktop (process ${owner.pid})`
    : `another Claude Code process (${owner.entrypoint}, process ${owner.pid})`;
}

/**
 * Refusal for a turn whose session another Claude Code process has open.
 * `details` tells the client whether the user can confirm taking it over,
 * which resends the turn with `takeOver: true`.
 * @param {Object} owner - From findForeignSessionProcess
 * @param {'confirm'|'background'|'stayed'} reason - A terminal's process ends
 *   only on the user's word, a background session never, and `stayed` is a
 *   process that did not exit when asked
 * @returns {AppError}
 */
function sessionOpenElsewhereError(owner: ForeignSessionProcess, reason: 'confirm' | 'background' | 'stayed') {
  const where = describeForeignProcess(owner);
  const message = {
    confirm: `This session is open in ${where}, such as \`claude\` in a terminal. Continuing it here `
      + 'ends that process, because two processes continuing one session split the conversation.',
    background: `This session is open in ${where}, a background session Codey does not end. `
      + 'Continue it there, or stop it first.',
    stayed: `${where} did not exit when Codey asked it to, so the session was not taken over.`,
  }[reason];
  return new AppError(`${message} Your message was not sent.`, {
    code: 'CLAUDE_SESSION_OPEN_ELSEWHERE',
    statusCode: 409,
    details: { pid: owner.pid, entrypoint: owner.entrypoint, canTakeOver: reason === 'confirm' },
  });
}

/**
 * Sends one transcript row another Claude Code process wrote to a Codey client.
 * @param {Object} row - Transcript row
 * @param {Object} writer - The run's writer
 * @param {Function} normalizeMessage - The provider's normalizer
 * @param {string} providerSessionId - Claude Code's session id
 */
function forwardForeignRow(row: unknown, writer: ClaudeRuntimeWriter, normalizeMessage: ProviderRuntimeContext['normalizeMessage'], providerSessionId: string) {
  for (const message of normalizeMessage(row, providerSessionId)) {
    writer.send(message);
  }
}

/**
 * Makes this turn the session's only writer when Claude Desktop or a terminal
 * has the session open, instead of refusing it.
 *
 * - An idle Claude Desktop process is ended right away: Desktop starts its
 *   process again, resuming the session with this turn in it, when its user
 *   next opens the session.
 * - Another interactive process (`claude` in a terminal) is ended only when
 *   the user confirmed it (`confirmed`), because that ends their terminal
 *   program. A background session is never ended.
 * - A process in the middle of a turn finishes it first. Meanwhile its rows
 *   are forwarded to this turn's client, and Stop cancels this turn only.
 *
 * Ending an idle process is clean: nothing is being written, and Claude Code
 * removes its registration on SIGTERM.
 * @param {Object} owner - From findForeignSessionProcess
 * @param {Object} input
 * @param {string} input.providerSessionId - Claude Code's session id
 * @param {string|undefined} input.cwd - The session's project directory
 * @param {boolean} input.confirmed - The user agreed to end a terminal's process
 * @param {Object} input.writer - The run's writer
 * @param {Function} input.normalizeMessage - The provider's normalizer
 * @param {AbortSignal} input.signal - Aborted when the user stops this turn
 * @returns {Promise<void>} Settles once the session has no other writer
 */
async function takeOverSession(owner: ForeignSessionProcess, { providerSessionId, cwd, confirmed, writer, normalizeMessage, signal }: { providerSessionId: string; cwd?: string; confirmed: boolean; writer: ClaudeRuntimeWriter; normalizeMessage: ProviderRuntimeContext['normalizeMessage']; signal: AbortSignal }) {
  if (owner.kind && owner.kind !== 'interactive') {
    throw sessionOpenElsewhereError(owner, 'background');
  }
  if (!isClaudeDesktopProcess(owner) && !confirmed) {
    throw sessionOpenElsewhereError(owner, 'confirm');
  }
  const name = isClaudeDesktopProcess(owner) ? 'Claude Desktop' : 'the other Claude Code process';
  const status = (text: string) => writer.send(createNormalizedMessage({
    kind: 'status', text, canInterrupt: true, sessionId: providerSessionId, provider: 'claude'
  }));

  for (;;) {
    if (signal.aborted) {
      throw new Error('The turn was stopped before the session was taken over.');
    }
    const state = await readForeignSessionStatus(owner, providerSessionId);
    if (state === 'gone') {
      return;
    }
    if (state === 'busy' || state === 'waiting') {
      status(`Waiting for ${name} to finish its turn`);
      await followForeignTurn({
        owner, providerSessionId, cwd, signal,
        onRow: (row) => forwardForeignRow(row, writer, normalizeMessage, providerSessionId),
      });
      continue;
    }
    if (state === null) {
      // Its registration was being rewritten; read it again.
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    status(`Taking this session over from ${name}`);
    if (!(await endForeignSessionProcess(owner, TAKE_OVER_EXIT_WAIT_MS))) {
      throw sessionOpenElsewhereError(owner, 'stayed');
    }
    status('');
    return;
  }
}

/**
 * Lets an open tab follow a turn that Claude Desktop or a terminal is running
 * in the session: its rows appear as they are written, the session shows as
 * busy until the turn ends, a message sent meanwhile waits in the queue, and
 * Stop interrupts that process's turn (see abortClaudeSDKSession). Nothing is
 * sent to the process.
 * @param {string} sessionId - App session id
 * @param {Object} context - Provider-scoped lookups
 * @returns {Promise<import('@/shared/types.js').ProviderRuntimeObservation|null>}
 *   The observation, or null when no such turn runs
 */
async function prepareClaudeObservation(sessionId: string, context: ProviderRuntimeContext): Promise<ProviderRuntimeObservation | null> {
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  if (!providerSessionId || getSession(sessionId)?.status === 'active') {
    return null;
  }
  const owner = await findForeignSessionProcess(providerSessionId);
  if (!owner || (owner.status !== 'busy' && owner.status !== 'waiting')) {
    return null;
  }
  const following = new AbortController();
  let started = false;
  return {
    async start(writer) {
      if (started) {
        throw new Error('This Claude observer has already been attached.');
      }
      started = true;
      observedForeignTurns.set(sessionId, { owner, following });
      try {
        const name = isClaudeDesktopProcess(owner) ? 'Claude Desktop' : 'Another Claude Code process';
        writer.send(createNormalizedMessage({
          kind: 'status', text: `${name} is running this turn`, canInterrupt: true, canSteer: false,
          sessionId: providerSessionId, provider: 'claude'
        }));
        const ended = await followForeignTurn({
          owner, providerSessionId, cwd: null, signal: following.signal,
          onRow: (row) => forwardForeignRow(row, writer, context.normalizeMessage, providerSessionId),
        });
        if (ended !== 'aborted') {
          writer.send(createCompleteMessage({ provider: 'claude', sessionId: providerSessionId, exitCode: 0 }));
        }
      } finally {
        if (observedForeignTurns.get(sessionId)?.following === following) {
          observedForeignTurns.delete(sessionId);
        }
      }
    },
    dispose() {
      following.abort();
    },
  };
}

/**
 * Registers the process serving a session under its key.
 *
 * A different process still running a turn under the same key means an
 * earlier run was superseded without being stopped (e.g. an abort that raced
 * run setup and found nothing to interrupt). Overwriting its entry would strand
 * its generator forever — this map entry is the only handle for interrupting
 * it. Stop it directly rather than via abortClaudeSDKSession, whose
 * session-keyed abortedSessionIds flag would be consumed by the new run and
 * suppress its terminal `complete`. An idle one is simply retired.
 * @param {string} sessionId - Session identifier
 * @param {Object} proc - Process record (see spawnClaudeProcess)
 */
function addSession(sessionId: string, proc: ClaudeProcess) {
  const existing = activeSessions.get(sessionId);
  if (existing && existing !== proc) {
    if (existing.status === 'active') {
      supersededInstances.add(existing.instance);
      Promise.resolve()
        .then(() => existing.turn?.steering.cancelPending())
        .then(() => existing.instance.interrupt())
        .catch((error) => {
          console.error(`Error interrupting superseded run for session ${sessionId}:`, errorMessage(error));
        });
    }
    retireProcess(existing);
  }
  proc.key = sessionId;
  activeSessions.set(sessionId, proc);
  // The history reader reports a background agent as running or stopped by
  // whether a live process serves the session, and the cached history does
  // not see this map.
  sessionHistoryCache.invalidate(sessionId);
}

/**
 * Gets a session's process from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Process record or undefined
 */
function getSession(sessionId: string) {
  return activeSessions.get(sessionId);
}

function clearProcessTimer(proc: ClaudeProcess) {
  if (proc.timer) {
    clearTimeout(proc.timer);
    proc.timer = null;
  }
}

function armProcessTimer(proc: ClaudeProcess, delayMs: number) {
  clearProcessTimer(proc);
  proc.timer = setTimeout(() => {
    proc.timer = null;
    retireProcess(proc);
  }, delayMs);
  // Never let a resident process keep the server alive on its own.
  proc.timer.unref?.();
}

/**
 * True while the process is the one registered for its session key, which is
 * what the background-work tracker and the history reader key on.
 * @param {Object} proc - Process record
 * @returns {boolean}
 */
function isRegisteredProcess(proc: ClaudeProcess): proc is ClaudeProcess & { key: string } {
  return proc.key !== null && activeSessions.get(proc.key) === proc;
}

/**
 * Forgets a process as the one serving its session: its outstanding
 * background work goes with it, and a history page cached while it was up
 * (which still says `running` for any agent that never reported back) is
 * dropped.
 * @param {Object} proc - Process record
 */
function unregisterProcess(proc: ClaudeProcess) {
  if (!isRegisteredProcess(proc)) {
    return;
  }
  activeSessions.delete(proc.key);
  backgroundWork.clear(proc.key);
  sessionHistoryCache.invalidate(proc.key);
}

/**
 * Closes a process's stdin so the CLI winds down, and forgets it. Background
 * work it was still running ends with it.
 *
 * Closing stdin is not enough on its own: the CLI's wind-down waits for the
 * background agents the process still has going — for up to the ceiling it
 * was started with (BG_WAIT_CEILING_MS) — so a retired process with an agent
 * outstanding would run next to the process that replaces it for as long as
 * the agent does, both appending to the same session file. Its tasks are
 * stopped first, while stdin is still open: the SDK drops control requests
 * written after stdin has ended. The stops are not awaited — each request is
 * written to the CLI before this returns, and a reply is only missing when
 * the process has already gone.
 * @param {Object} proc - Process record
 * @returns {Promise<void>} Settles once the process has exited
 */
function retireProcess(proc: ClaudeProcess) {
  if (!proc.retired) {
    proc.retired = true;
    clearProcessTimer(proc);
    if (isRegisteredProcess(proc)) {
      for (const task of backgroundWork.outstanding(proc.key)) {
        // A stop that cannot be delivered changes nothing about what happens
        // next: the process is on its way out either way. Guard the
        // synchronous call too, so a failing stop can never skip the release.
        try {
          Promise.resolve(proc.instance?.stopTask?.(task.taskId)).catch(() => {});
        } catch {
          // Same as a rejected stop.
        }
      }
    }
    unregisterProcess(proc);
    if (proc.key) {
      exitingProcesses.set(proc.key, proc.ended);
    }
    proc.releaseInput();
  }
  return proc.ended;
}

/**
 * Decides what a process does once no turn is running in it: wait for
 * background work to report back, stay resident for the session's next turn,
 * or exit. Idle resident processes beyond the cap are retired, least recently
 * used first and those still waiting on background work last. A process held
 * for tasks its session scheduled has no ceiling and does not count against
 * the cap: the tasks live in it, and retiring it would cancel them.
 * @param {Object} proc - Process record
 */
function scheduleIdleProcess(proc: ClaudeProcess) {
  if (proc.retired || proc.status !== 'idle') {
    return;
  }
  if (proc.pendingNativeSideQuestions > 0) {
    proc.releaseDeferred = true;
    armProcessTimer(proc, BG_WAIT_CEILING_MS);
    return;
  }
  if (proc.heldForBackgroundWork) {
    if (hasScheduledWork(proc)) {
      // The next task may be hours away, so silence says nothing.
      clearProcessTimer(proc);
      return;
    }
    // The ceiling measures silence: background activity re-arms it.
    armProcessTimer(proc, BG_WAIT_CEILING_MS);
    return;
  }
  const maxIdle = maxIdleProcesses();
  if (!proc.resident || proc.retireAfterTurn || maxIdle === 0) {
    retireProcess(proc);
    return;
  }
  armProcessTimer(proc, idleProcessTimeoutMs());
  const idle = [...activeSessions.values()]
    .filter((candidate) => candidate.status === 'idle' && !candidate.retired
      && !(candidate.heldForBackgroundWork && hasScheduledWork(candidate)))
    .sort((a, b) => Number(a.heldForBackgroundWork) - Number(b.heldForBackgroundWork) || a.lastActiveAt - b.lastActiveAt);
  for (const candidate of idle.slice(0, Math.max(0, idle.length - maxIdle))) {
    retireProcess(candidate);
  }
}

/**
 * Whether the background-work tracker still has tasks outstanding for the
 * process's session.
 * @param {Object} proc - Process record
 * @returns {boolean}
 */
function hasOutstandingBackgroundWork(proc: ClaudeProcess) {
  return isRegisteredProcess(proc) && backgroundWork.hasOutstanding(proc.key);
}

// How much of a scheduled task's prompt the running-sessions list carries.
const SCHEDULED_PROMPT_MAX_CHARS = 200;

/**
 * Records the tasks the process's session has scheduled for itself, as its
 * Stop hook reported them; a task keeps the time it was first reported. A CLI
 * that does not report them leaves the record unknown (null), and the hold
 * goes by what the turn's tool calls launched alone.
 * @param {Object} proc - Process record
 * @param {unknown} crons - The hook input's `session_crons`
 */
function noteScheduledTasks(proc: ClaudeProcess, crons: unknown) {
  if (!Array.isArray(crons)) {
    return;
  }
  const known = new Map((proc.scheduledTasks ?? []).map((task) => [task.id, task]));
  const now = Date.now();
  proc.scheduledTasks = crons
    .filter((cron) => typeof cron?.id === 'string' && cron.id && typeof cron.schedule === 'string')
    .map((cron) => ({
      id: cron.id,
      schedule: cron.schedule,
      recurring: cron.recurring === true,
      prompt: typeof cron.prompt === 'string' ? cron.prompt.slice(0, SCHEDULED_PROMPT_MAX_CHARS) : '',
      since: known.get(cron.id)?.since ?? now
    }));
}

/**
 * Whether the process's session has tasks scheduled to wake it later.
 * @param {Object} proc - Process record
 * @returns {boolean}
 */
function hasScheduledWork(proc: ClaudeProcess) {
  return (proc.scheduledTasks?.length ?? 0) > 0;
}

/**
 * Folds one SDK message into the process's background-work bookkeeping: the
 * tracker of outstanding tasks (only for the process registered for its
 * session — a retired one's late events must not touch its successor's), and
 * whether the CLI turn under way reported any task starting.
 * @param {Object} proc - Process record
 * @param {Object} message - SDK stream message
 */
function trackBackgroundWork(proc: ClaudeProcess, message: AnyRecord) {
  if (message.type === 'system' && message.subtype === 'task_started') {
    proc.sawTaskEventThisTurn = true;
  }
  if (isRegisteredProcess(proc)) {
    backgroundWork.apply(proc.key, message);
  }
}

/**
 * Bookkeeping for every turn the CLI finishes. Background work started in a
 * turn holds the process until a later turn reports it back.
 *
 * Work from an earlier turn that has not settled yet (a follow-up turn reports
 * one task in while another is still going) keeps holding it too. When the
 * turn reported its tasks, the tracker is the whole truth: an Agent call
 * without `run_in_background` is scored as background by
 * `startsBackgroundWork`, but the CLI runs it in the foreground and it has
 * settled before this `result` — holding for it kept a process alive for the
 * full ceiling with nothing outstanding. `startsBackgroundWork` stays the rule
 * for tools that emit no task events (Monitor, ScheduleWakeup, CronCreate,
 * TaskCreate) and for an SDK that does not report tasks at all.
 *
 * Tasks the session scheduled for itself hold the process for as long as the
 * Stop hook reports any, including ones a resumed process took over: each
 * fires a turn of its own, which only a live process can run.
 * @param {Object} proc - Process record
 * @param {boolean} reportsBack - The turn was the CLI's own follow-up, not a Codey turn
 */
function noteCliTurnEnded(proc: ClaudeProcess, reportsBack: boolean) {
  const stillOutstanding = hasOutstandingBackgroundWork(proc);
  const scheduled = hasScheduledWork(proc);
  if (reportsBack && proc.heldForBackgroundWork && !stillOutstanding && !scheduled) {
    // The last of the work the process was held for has reported back.
    (notifyBackgroundWorkCompleted as (input: { userId: string | number | null; provider: string; sessionId: string | null; sessionName: string | null }) => void)({
      userId: proc.writer?.userId || null,
      provider: 'claude',
      sessionId: proc.appSessionId || proc.providerSessionId || null,
      sessionName: proc.sessionSummary
    });
  }
  proc.heldForBackgroundWork = scheduled || (proc.sawTaskEventThisTurn
    ? stillOutstanding
    : proc.backgroundWorkPending || stillOutstanding);
  proc.backgroundWorkPending = false;
  proc.sawTaskEventThisTurn = false;
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage: AnyRecord): AnyRecord {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * True for the user bubble the SDK echoes for a subagent's own prompt.
 *
 * Subagent traffic carries `parent_tool_use_id`, so this echo lands in the main
 * thread and stacks a second copy of the prompt right below the Agent tool card
 * that already displays it. It also disappears on reload, because the transcript
 * keeps that turn in the subagent's sidechain rather than the session file.
 * @param {Object} message - Normalized message about to be sent to the client
 * @returns {boolean}
 */
export function isSubagentPromptEcho(message: AnyRecord | null | undefined) {
  return Boolean(message?.parentToolUseId) && message?.role === 'user' && message?.kind === 'text';
}

function readNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * True for the all-zero usage Claude Code stamps on `<synthetic>` replies —
 * local command output such as /context, and the `result` of a turn that never
 * called the model. It describes no prompt, so publishing it zeroed the
 * counter; the history reader skips the same rows.
 * @param {TokenBudget} budget
 * @returns {boolean}
 */
function isEmptyTokenBudget(budget: TokenBudget) {
  return budget.inputTokens === 0 && budget.outputTokens === 0;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheCreationTokens]
 * @property {number} [cacheTokens]
 * @property {number} [sessionTokens] - Every request of the session, added by publishTokenBudget
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * The window a budget is measured against: the one the run knows for its
 * model (the managed catalog's, else the one the SDK reported for the
 * session), else the server-wide CONTEXT_WINDOW setting.
 * @param {number|null|undefined} contextWindow - Known window of the run's model
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(contextWindow?: number | null): number {
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
    return contextWindow;
  }
  return parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || 160000;
}

/**
 * Reads the context window the SDK measured for the model that served a turn.
 *
 * `result.modelUsage` has one entry per model the turn billed, subagents'
 * included, so the entry has to be the main thread's model. Its key is the id
 * the CLI requested, which for a 1M variant carries a `[1m]` suffix that the
 * assistant rows' `message.model` lacks (`claude-sonnet-5-5[1m]` vs
 * `claude-sonnet-5-5`); newer CLIs also state the bare id as `canonicalModel`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {string|null} mainModel - `message.model` of the turn's main-thread assistant rows
 * @returns {number|null} The reported window, or null when there is none
 */
function readReportedContextWindow(sdkMessage: AnyRecord, mainModel: string | null): number | null {
  const modelUsage = sdkMessage?.type === 'result' ? sdkMessage.modelUsage : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }

  const reported = Object.entries(modelUsage as Record<string, AnyRecord>).filter(
    ([, modelData]) => modelData && typeof modelData === 'object' && readNumber(modelData.contextWindow) > 0
  );
  const exactMatch = reported.find(([modelKey]) => modelKey === mainModel);
  const variantMatch = reported.find(([modelKey, modelData]) => (
    Boolean(mainModel)
    && (modelData.canonicalModel === mainModel || modelKey.replace(/\[[^\]]*\]$/, '') === mainModel)
  ));
  // A turn that billed a single model was served by it, whatever it is called.
  const entry = exactMatch ?? variantMatch ?? (reported.length === 1 ? reported[0] : null);
  return entry ? readNumber(entry[1].contextWindow) : null;
}

/**
 * The window a process's budgets are measured against when it knows one: the
 * managed catalog's (Claude Code is launched against it, so it outranks what
 * the CLI reports), else the one the SDK last reported for the session.
 * @param {Object} proc - Process record
 * @returns {number|undefined}
 */
function knownContextWindow(proc: ClaudeProcess) {
  return proc.contextWindow || proc.reportedContextWindow || undefined;
}

/**
 * Records the model the main thread's assistant rows name, and the window the
 * SDK reports for it on a turn's `result`, which is remembered for the
 * session so history and a resumed run measure against it too.
 * @param {Object} proc - Process record
 * @param {Object} message - SDK stream message
 * @returns {number|null} The window this message reported, or null
 */
function trackReportedContextWindow(proc: ClaudeProcess, message: AnyRecord) {
  if (
    message.type === 'assistant'
    && !message.parent_tool_use_id
    && typeof message.message?.model === 'string'
    && message.message.model !== '<synthetic>'
  ) {
    proc.mainThreadModel = message.message.model;
  }

  // Only a turn's `result` states the window of the model that served it.
  const reported = readReportedContextWindow(message, proc.mainThreadModel);
  if (!reported) {
    return null;
  }
  const changed = reported !== proc.reportedContextWindow;
  proc.reportedContextWindow = reported;
  rememberClaudeContextWindow(message.session_id || proc.providerSessionId, reported);
  if (changed && isRegisteredProcess(proc)) {
    // A history page cached before this turn ended carries the old total.
    sessionHistoryCache.invalidate(proc.key);
  }
  return reported;
}

/**
 * Starts counting the requests a resumed session made before this process,
 * which every budget the process publishes adds its own requests to. A new
 * conversation has made none. An unreadable transcript counts as empty rather
 * than holding the counter back.
 * @param {Object} proc - Process record
 * @param {Object} sdkOptions - The process's launch options
 */
function loadSessionTokenLedger(proc: ClaudeProcess, sdkOptions: AnyRecord) {
  if (!sdkOptions.resume) {
    proc.sessionTokenLedger = { total: 0, requestIds: new Set() };
    return;
  }
  void (async () => {
    const transcriptPath = resolveClaudeTranscriptPath(proc.appSessionId, sdkOptions.resume, sdkOptions.cwd);
    return transcriptPath ? await readClaudeSessionTokens(transcriptPath) : null;
  })()
    .catch(() => null)
    .then((ledger) => {
      proc.sessionTokenLedger = ledger ?? { total: 0, requestIds: new Set() };
    });
}

/**
 * Notes the tokens a main-thread request of this process consumed, once per
 * request however many messages repeat its usage.
 * @param {Object} proc - Process record
 * @param {Object} message - SDK stream message
 */
function trackRequestTokens(proc: ClaudeProcess, message: AnyRecord) {
  const request = readClaudeRequestTokens(message);
  if (request) {
    proc.liveRequestTokens.set(request.id, request.tokens);
  }
}

/**
 * The session's token total: the requests its transcript held when the
 * process started, plus the ones the process made since. A request the
 * transcript has caught up with in the meantime is counted once.
 * @param {Object} proc - Process record
 * @returns {number|undefined} Undefined until the transcript has been counted
 */
function sessionTokenTotal(proc: ClaudeProcess) {
  const ledger = proc.sessionTokenLedger;
  if (!ledger) {
    return undefined;
  }
  let total = ledger.total;
  for (const [id, tokens] of proc.liveRequestTokens) {
    if (!ledger.requestIds.has(id)) {
      total += tokens;
    }
  }
  return total;
}

/**
 * Sends a budget to the client, with the session's token total when known.
 * @param {Object} proc - Process record
 * @param {Object} writer - Where the budget goes
 * @param {TokenBudget} tokenBudget - The context-window budget
 * @param {string|null} sessionId - Session the budget is stamped with
 */
function publishTokenBudget(proc: ClaudeProcess, writer: ClaudeRuntimeWriter, tokenBudget: TokenBudget, sessionId: string | null) {
  const sessionTokens = sessionTokenTotal(proc);
  writer.send(createNormalizedMessage({
    kind: 'status',
    text: 'token_budget',
    tokenBudget: sessionTokens === undefined ? tokenBudget : { ...tokenBudget, sessionTokens },
    sessionId,
    provider: 'claude'
  }));
}

/**
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {number|null} [contextWindow] - Known window of the run's model (see resolveContextWindow)
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage: AnyRecord, contextWindow?: number | null): TokenBudget {
  const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
  const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
  const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
  const cacheTokens = cacheCreationTokens + cacheReadTokens;
  const inputTokens = directInputTokens + cacheTokens;
  const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);

  return {
    used: inputTokens + outputTokens,
    total: resolveContextWindow(contextWindow),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Extracts the session's context-window usage from an SDK stream message.
 *
 * Only assistant messages describe the context window: each one reports the
 * prompt its own request carried. The turn-ending `result` is deliberately not
 * a source here — see `extractCumulativeTokenBudget`.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [contextWindow] - Known window of the run's model (see resolveContextWindow)
 * @returns {TokenBudget|null} Token budget object or null
 */
export function extractTokenBudget(sdkMessage: unknown, contextWindow?: number | null): TokenBudget | null {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  const message = sdkMessage as AnyRecord;
  if (message.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (message.type !== 'assistant') {
    return null;
  }

  const messageUsage = message.message?.usage;
  if (!messageUsage || typeof messageUsage !== 'object') {
    return null;
  }

  const budget = buildTokenBudget(messageUsage, contextWindow);
  return isEmptyTokenBudget(budget) ? null : budget;
}

/**
 * Last-resort budget read from a turn's `result` message.
 *
 * `result.usage` and `result.modelUsage` are the turn's *bill*: every request
 * the turn made, summed, including each subagent's. A turn that made four
 * requests therefore reports roughly four times the context the conversation
 * actually holds, so publishing it made the counter leap at the end of a turn
 * and fall back on the next assistant message — worst with subagents running,
 * whose requests inflate the sum without ever entering this session's context.
 *
 * It is still the only usage an SDK build that reports none per assistant
 * message ever emits, so it stays available for the caller to use when a turn
 * produced no assistant budget at all.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [contextWindow] - Known window of the run's model (see resolveContextWindow)
 * @returns {TokenBudget|null} Token budget object or null
 */
export function extractCumulativeTokenBudget(rawMessage: unknown, contextWindow?: number | null): TokenBudget | null {
  const sdkMessage = rawMessage as AnyRecord | null;
  if (!sdkMessage || typeof sdkMessage !== 'object' || sdkMessage.type !== 'result') {
    return null;
  }

  if (sdkMessage.usage && typeof sdkMessage.usage === 'object') {
    const budget = buildTokenBudget(sdkMessage.usage, contextWindow);
    return isEmptyTokenBudget(budget) ? null : budget;
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;

  return {
    used: totalUsed,
    total: resolveContextWindow(contextWindow),
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// Tool calls that leave work running past the end of a turn. Bash and Agent only
// count when they are backgrounded; the rest defer or watch work by nature.
// Workflow belongs here rather than in a branch of its own: its input schema has
// no foreground option at all, so every call returns a task id immediately and
// reports back in a later turn.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate', 'TaskCreate', 'Workflow']);

/**
 * Detects tool calls that keep working after the turn's `result` arrives.
 *
 * Only turns that start background work need their CLI process held open; every
 * other turn can let it exit immediately, as it did before the hold existed.
 *
 * Used by the providers module's tests, which pin the tool matching directly:
 * the alternative is driving a whole SDK run to observe whether stdin was held,
 * and the cost of getting this wrong is silently killed background work.
 *
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean} True when the message launches work that outlives the turn
 */
export function startsBackgroundWork(sdkMessage: AnyRecord | null | undefined) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block: AnyRecord | null) => {
    if (block?.type !== 'tool_use') {
      return false;
    }
    if (block.name === 'Bash') {
      return block.input?.run_in_background === true;
    }
    // A backgrounded subagent outlives the turn exactly like a backgrounded
    // Bash does, so the process has to be held open for it to report back.
    // Agents background by default — `run_in_background` is optional and only
    // an explicit `false` opts out — hence `!== false` rather than `=== true`.
    // A foreground agent must stay out of DEFERRED_WORK_TOOLS: it never pushes
    // a follow-up turn, so it would pin the process for the full ceiling.
    if (block.name === 'Agent') {
      return block.input?.run_in_background !== false;
    }
    return DEFERRED_WORK_TOOLS.has(block.name);
  });
}

// `task_updated` patch statuses after which a task is gone for good. `pending`,
// `running` and `paused` are still outstanding; `killed` is what the CLI
// writes when it stops a task itself (the task notification spells it
// `stopped`).
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Tracks the background tasks each live session still has outstanding, folded
 * from the `system` task events the SDK stream already carries.
 *
 * `startsBackgroundWork` above only knows that a turn *launched* something
 * lasting; this knows what is still running and which task ids it answers to,
 * which is what the running-sessions list and a stop request need once the
 * turn's `result` has gone out and nothing else remembers the session is busy.
 *
 * Verified against a real query (SDK 0.3.165): `task_started` carries
 * `task_id`, `tool_use_id`, `task_type` and `description` for every agent,
 * workflow and backgrounded command (a foreground Bash emits nothing);
 * `task_notification` settles a task with any status; `task_updated` carries
 * only `task_id` and a patch, and is terminal when the patch's `status` is.
 * Housekeeping tasks the CLI starts on its own have no `tool_use_id` and are
 * not tracked — nothing in the transcript could show them.
 *
 * Exported so the folding can be driven with the four event shapes directly;
 * the runtime keeps one instance keyed like `activeSessions`.
 *
 */
export function createBackgroundWorkTracker() {
  const sessions = new Map<string, Map<string, BackgroundTaskSummary>>();
  /**
   * Tool-use ids the session's own turns issued. A task started for a call an
   * agent made inside its own transcript — a workflow agent's backgrounded
   * command, say — reaches this stream too, and nothing in the parent
   * transcript could show it; it is kept for stopping but flagged `nested`.
   */
  const ownToolUseIds = new Map<string, Set<string>>();

  const remove = (sessionKey: string, taskId: string) => {
    const tasks = sessions.get(sessionKey);
    if (!tasks) {
      return;
    }
    tasks.delete(taskId);
    if (tasks.size === 0) {
      sessions.delete(sessionKey);
    }
  };

  return {
    apply(sessionKey: string, message: AnyRecord | null | undefined) {
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              let ids = ownToolUseIds.get(sessionKey);
              if (!ids) {
                ids = new Set<string>();
                ownToolUseIds.set(sessionKey, ids);
              }
              ids.add(block.id);
            }
          }
        }
        return;
      }
      if (message?.type !== 'system' || typeof message.task_id !== 'string') {
        return;
      }
      switch (message.subtype) {
        case 'task_started': {
          if (typeof message.tool_use_id !== 'string') {
            return;
          }
          const task: BackgroundTaskSummary = {
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            taskType: message.task_type,
            description: message.description,
            startedAt: Date.now()
          };
          if (typeof message.workflow_name === 'string') {
            task.workflowName = message.workflow_name;
          }
          if (!ownToolUseIds.get(sessionKey)?.has(message.tool_use_id)) {
            task.nested = true;
          }
          let tasks = sessions.get(sessionKey);
          if (!tasks) {
            tasks = new Map<string, BackgroundTaskSummary>();
            sessions.set(sessionKey, tasks);
          }
          tasks.set(task.taskId, task);
          return;
        }
        case 'task_notification':
          remove(sessionKey, message.task_id);
          return;
        case 'task_updated':
          if (TERMINAL_TASK_STATUSES.has(message.patch?.status)) {
            remove(sessionKey, message.task_id);
          }
          return;
        default:
      }
    },

    hasOutstanding(sessionKey: string) {
      return sessions.has(sessionKey);
    },

    has(sessionKey: string, taskId: string) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    outstanding(sessionKey: string): BackgroundTaskSummary[] {
      return Array.from(sessions.get(sessionKey)?.values() ?? []);
    },

    clear(sessionKey: string) {
      sessions.delete(sessionKey);
      ownToolUseIds.delete(sessionKey);
    },

    list() {
      return Array.from(sessions, ([sessionId, tasks]) => ({
        sessionId,
        tasks: Array.from(tasks.values())
      }));
    }
  };
}

/**
 * Input Claude Code takes as a slash command (`/compact`, `/simplify app.py`),
 * as opposed to text that merely starts with a path like `/etc/hosts`.
 */
const SLASH_COMMAND_INPUT = /^\/[\w:.-]+(?:\s|$)/;

/**
 * True for a replayed row that carries a local command's output.
 *
 * The CLI replays what a command produced alongside the input it took up —
 * /compact reports "Compacted" this way — but unlike an input echo it is not
 * already on screen, and history shows it.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean}
 */
function isLocalCommandOutput(sdkMessage: AnyRecord) {
  const content = sdkMessage?.message?.content;
  return typeof content === 'string' && /^<local-command-std(?:out|err)>/.test(content);
}

/**
 * Uuids of the rows a compaction kept verbatim. The CLI streams them again
 * right after the boundary for clients rebuilding the conversation; this run
 * already sent them, and history shows them once, where they first happened.
 * @param {Object} sdkMessage - `compact_boundary` system message
 * @returns {string[]}
 */
function readPreservedMessageIds(sdkMessage: AnyRecord) {
  const metadata = sdkMessage?.compact_metadata;
  return [
    ...(metadata?.preserved_messages?.uuids ?? []),
    metadata?.preserved_segment?.head_uuid,
    metadata?.preserved_segment?.tail_uuid,
  ].filter((uuid) => typeof uuid === 'string' && uuid);
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command: string, images: unknown, files: unknown, cwd: string) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    uuid: undefined as string | undefined,
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone. While it parks,
 * `push` writes steering input to the same stdin.
 *
 * While it is parked, `push` writes one more message to the same stdin. That is
 * how a message sent during a turn reaches the running CLI (steering) instead of
 * waiting for the run to end. A push after `release` is refused, because the
 * CLI is already on its way out and would never read it.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void, push: (message: Object) => boolean }}
 *   Stream, its closer, and an appender that refuses once the stream is released
 */
function createHeldPromptStream(messages: unknown[]) {
  const queued = [...messages];
  let released = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const stream = (async function* () {
    for (;;) {
      while (queued.length > 0) {
        yield queued.shift();
      }
      if (released) {
        return;
      }
      // Keeps stdin open — the CLI stays alive until release() is called.
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();

  return {
    stream,
    release: () => {
      released = true;
      notify();
    },
    push: (message: unknown) => {
      if (released) {
        return false;
      }
      queued.push(message);
      notify();
      return true;
    }
  };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd: string | undefined): Promise<AnyRecord | null> {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', (error as Error).message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers: AnyRecord = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', (error as Error).message);
    return null;
  }
}

/**
 * Identifies how a process was launched. A resident process only serves a
 * turn that would launch it identically; the resume itself is what reuse
 * replaces, so it is not part of the identity.
 * @param {Object} sdkOptions - SDK options for the turn, before callbacks are bound
 * @returns {string}
 */
function launchSignature(sdkOptions: AnyRecord) {
  const { resume, resumeSessionAt, hooks, canUseTool, ...launch } = sdkOptions;
  // The SDK stamps its version into the server's own environment on first use,
  // which the next turn's copy then carries.
  const { CLAUDE_AGENT_SDK_VERSION, ...env } = launch.env || {};
  return crypto.createHash('sha256').update(JSON.stringify({ ...launch, env })).digest('hex');
}

function emitProcessNotification(proc: ClaudeProcess, event: unknown) {
  notifyUserIfEnabled({
    userId: proc.writer?.userId || null,
    event
  });
}

/**
 * Binds the SDK callbacks of a process. They outlive the turn that launched
 * it, so they address whichever turn is running now through the record.
 * @param {Object} proc - Process record
 * @param {Object} sdkOptions - SDK options the process is launched with
 */
function bindProcessCallbacks(proc: ClaudeProcess, sdkOptions: AnyRecord, unattended: boolean) {
  // Notifications are app-facing, so they carry the app session id.
  const appSessionId = () => proc.appSessionId || proc.providerSessionId || null;
  const streamSessionId = () => proc.providerSessionId || proc.appSessionId || null;

  sdkOptions.hooks = {
    Notification: [{
      matcher: '',
      hooks: [async (input: AnyRecord) => {
        const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
        emitProcessNotification(proc, notificationEvent({
          provider: 'claude',
          sessionId: appSessionId(),
          kind: 'action_required',
          code: 'agent.notification',
          meta: { message, sessionName: proc.sessionSummary },
          severity: 'warning',
          requiresUserAction: true,
          dedupeKey: `claude:hook:notification:${appSessionId() || 'none'}:${message}`
        }));
        return {};
      }]
    }],
    // The tasks a session has scheduled for itself are only reported here:
    // Claude Code passes them to every Stop hook, right before the turn's
    // `result` (checked against Claude Code 2.1.310, also for a resumed
    // session and for a turn a task fired).
    Stop: [{
      hooks: [async (input: AnyRecord) => {
        noteScheduledTasks(proc, input?.session_crons);
        return {};
      }]
    }]
  };

  // An MCP server asking the person for input mid-call ("elicitation"). The
  // CLI declares form and URL elicitation support to every server, and without
  // this callback the SDK answers each request with `decline` itself — the
  // server is told a person refused when nobody was shown anything. The
  // request takes the permission round trip so it reaches every attached tab,
  // survives a refresh and raises a notification. There is no timeout here:
  // the server keeps its own, and an abort arrives through the signal.
  // An unattended run (commit-message generation, and an agent-API run unless
  // its caller passed `unattended: false`) has nobody to show the form to, so
  // it leaves the callback unset: the SDK then declines at once, rather than
  // the run waiting on an answer that cannot come.
  if (!unattended) {
    sdkOptions.onElicitation = async (request: ElicitationRequest, elicitationOptions: { signal: AbortSignal }) => {
      const requestId = createRequestId();
      const input = {
        serverName: request.serverName,
        message: request.message,
        mode: request.mode ?? 'form',
        requestedSchema: request.requestedSchema,
        url: request.url,
        elicitationId: request.elicitationId,
        title: request.title,
        displayName: request.displayName,
        description: request.description,
      };
      const serverLabel = request.displayName || request.serverName;
      proc.writer.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName: MCP_ELICITATION_TOOL_NAME, input, sessionId: streamSessionId(), provider: 'claude' }));
      emitProcessNotification(proc, notificationEvent({
        provider: 'claude',
        sessionId: appSessionId(),
        kind: 'action_required',
        code: 'agent.notification',
        meta: { message: `${serverLabel} asks: ${request.message}`, sessionName: proc.sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:elicitation:${appSessionId() || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: 0,
        signal: elicitationOptions?.signal,
        metadata: {
          _sessionId: appSessionId(),
          _toolName: MCP_ELICITATION_TOOL_NAME,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason: string) => {
          proc.writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: streamSessionId(), provider: 'claude' }));
        }
      });
      if (decision && !decision.cancelled) {
        // Same as canUseTool: retract the answered prompt on every attached tab.
        proc.writer.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: streamSessionId(), provider: 'claude' }));
      }
      return toElicitationResult(decision, request.mode);
    };
  }

  // AskUserQuestion and ExitPlanMode reach this callback in 'auto' and
  // 'bypassPermissions' modes too: Claude Code returns their "ask" before
  // either mode can approve them (checked against Claude Code 2.1.165), so
  // questions and plan approvals still wait for the user.
  sdkOptions.canUseTool = async (toolName: string, input: unknown, context?: { signal?: AbortSignal }) => {
    const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

    if (!requiresInteraction) {
      if (sdkOptions.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input };
      }

      const isDisallowed = (sdkOptions.disallowedTools || []).some((entry: string) =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isDisallowed) {
        return { behavior: 'deny', message: 'Tool disallowed by settings' };
      }

      const isAllowed = (sdkOptions.allowedTools || []).some((entry: string) =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isAllowed) {
        return { behavior: 'allow', updatedInput: input };
      }
    }

    const requestId = createRequestId();
    proc.writer.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: streamSessionId(), provider: 'claude' }));
    emitProcessNotification(proc, notificationEvent({
      provider: 'claude',
      sessionId: appSessionId(),
      kind: 'action_required',
      code: 'permission.required',
      meta: { toolName, sessionName: proc.sessionSummary },
      severity: 'warning',
      requiresUserAction: true,
      dedupeKey: `claude:permission:${appSessionId() || 'none'}:${requestId}`
    }));

    const decision = await waitForToolApproval(requestId, {
      timeoutMs: requiresInteraction ? 0 : undefined,
      signal: context?.signal,
      metadata: {
        // Keyed by the app session id so `chat.subscribe` can look pending
        // approvals up directly; provider id only for legacy callers.
        _sessionId: appSessionId(),
        _toolName: toolName,
        _input: input,
        _receivedAt: new Date(),
      },
      onCancel: (reason) => {
        proc.writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: streamSessionId(), provider: 'claude' }));
      }
    });
    if (!decision) {
      return { behavior: 'deny', message: 'Permission request timed out' };
    }

    if (decision.cancelled) {
      return { behavior: 'deny', message: 'Permission request cancelled' };
    }

    // A client answered. Announce it on the run stream so the replay buffer
    // and every other attached tab drop the prompt — resolving happens over
    // the inbound socket only, so without this a mid-run page refresh
    // replays the `permission_request` with nothing to retract it and the
    // already-answered prompt resurrects.
    proc.writer.send(createNormalizedMessage({ kind: 'permission_resolved', requestId, sessionId: streamSessionId(), provider: 'claude' }));

    if (decision.allow) {
      if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
        if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
          sdkOptions.allowedTools.push(decision.rememberEntry);
        }
        if (Array.isArray(sdkOptions.disallowedTools)) {
          sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter((entry: string) => entry !== decision.rememberEntry);
        }
      }
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
    }

    return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
  };
}

/**
 * Sends one SDK message to the client in normalized form.
 * @param {Object} proc - Process record whose writer receives it
 * @param {Object} message - SDK stream message
 */
function forwardMessage(proc: ClaudeProcess, message: AnyRecord) {
  // Transform and normalize message via adapter
  const transformedMessage = transformMessage(message);
  const normalized = proc.normalizeMessage(transformedMessage, proc.providerSessionId || proc.appSessionId || null);
  for (const msg of normalized) {
    // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
    if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
      msg.parentToolUseId = transformedMessage.parentToolUseId;
    }
    if (isSubagentPromptEcho(msg)) {
      continue;
    }
    proc.writer.send(msg);
  }
}

/**
 * Gives a turn the CLI starts on its own (background work reporting back) a
 * run of its own, so the session shows as busy while the turn runs instead of
 * idle. The turn, and the background work still going after it, send through
 * the new run's writer from here on. Without a run (one is already in
 * progress, or the runtime was driven without the hook) they keep going to
 * the last turn's writer.
 * @param {Object} proc - Process record
 */
function openFollowUpRun(proc: ClaudeProcess) {
  if (proc.followUpRun || !proc.appSessionId || !proc.startFollowUpRun) {
    return;
  }
  const writer = proc.startFollowUpRun(proc.appSessionId, proc.providerSessionId, proc.writer?.userId ?? null);
  if (!writer) {
    return;
  }
  proc.writer = writer;
  proc.followUpRun = true;
  writer.send(createNormalizedMessage({
    kind: 'status', canInterrupt: true, canSteer: false, sessionId: proc.providerSessionId, provider: 'claude'
  }));
}

/**
 * Ends the run openFollowUpRun started, once its turn is over.
 * @param {Object} proc - Process record
 * @param {number} exitCode - 0 when the CLI finished the turn
 */
function closeFollowUpRun(proc: ClaudeProcess, exitCode: number) {
  if (!proc.followUpRun) {
    return;
  }
  proc.followUpRun = false;
  proc.writer.send(createCompleteMessage({ provider: 'claude', sessionId: proc.providerSessionId, exitCode }));
}

/**
 * Handles what the CLI sends while no Codey turn runs in the process:
 * background work reporting back, and the follow-up turns in which the CLI
 * relays what it reported.
 * @param {Object} proc - Process record
 * @param {Object} message - SDK stream message
 */
function handleIdleMessage(proc: ClaudeProcess, message: AnyRecord) {
  if (message.type === 'system' && message.subtype === 'init') {
    openFollowUpRun(proc);
  }
  trackBackgroundWork(proc, message);
  trackReportedContextWindow(proc, message);
  if (message.isReplay === true && !isLocalCommandOutput(message)) {
    return;
  }
  forwardMessage(proc, message);
  trackRequestTokens(proc, message);
  const tokenBudget = extractTokenBudget(message, knownContextWindow(proc));
  if (tokenBudget) {
    publishTokenBudget(proc, proc.writer, tokenBudget, proc.providerSessionId);
  }
  if (startsBackgroundWork(message)) {
    proc.backgroundWorkPending = true;
  }
  if (message.type === 'result') {
    noteCliTurnEnded(proc, true);
    closeFollowUpRun(proc, 0);
    scheduleIdleProcess(proc);
  } else if (
    proc.heldForBackgroundWork
    && message.type === 'system'
    && message.subtype === 'task_notification'
    && message.status === 'stopped'
    && !hasOutstandingBackgroundWork(proc)
  ) {
    // A task the user stopped gets no follow-up turn from the CLI — only its
    // `stopped` notification — so when that was the last outstanding task
    // nothing will ever push the `result` that ends the hold, and the process
    // would sit until the ceiling. End it here. A completed task is
    // different: the CLI relays its result in a turn of its own. Tasks the
    // session scheduled keep holding it.
    proc.heldForBackgroundWork = hasScheduledWork(proc);
    scheduleIdleProcess(proc);
  } else if (proc.heldForBackgroundWork && hasScheduledWork(proc) && !proc.cliBusy) {
    // What the CLI says between turns (its `command_lifecycle` bookkeeping
    // after a scheduled task's turn) starts no countdown: the process waits
    // for the next task without one.
  } else if (!proc.retired) {
    // Activity pushes the countdown back out.
    armProcessTimer(proc, proc.heldForBackgroundWork ? BG_WAIT_CEILING_MS : idleProcessTimeoutMs());
  }
}

/**
 * Reads everything a process says for as long as it lives, routing it to the
 * turn running in it, or to the idle handler between turns.
 * @param {Object} proc - Process record
 */
async function pumpProcess(proc: ClaudeProcess) {
  let failure: unknown = null;
  try {
    for await (const rawMessage of proc.instance) {
      const message = readObjectRecord(rawMessage);
      if (!message) continue;
      proc.lastActiveAt = Date.now();
      if (message.type === 'system' && message.subtype === 'init') {
        proc.cliBusy = true;
      } else if (message.type === 'result') {
        proc.cliBusy = false;
      }
      if (proc.turn) {
        proc.turn.onMessage(message);
      } else {
        handleIdleMessage(proc, message);
      }
    }
  } catch (error) {
    failure = error;
  }

  const wasRetired = proc.retired;
  proc.retired = true;
  clearProcessTimer(proc);
  // No process, no background work: anything still tracked died with it.
  unregisterProcess(proc);
  // Nothing reads the prompt stream any more; let it end too.
  proc.releaseInput();
  if (proc.key && exitingProcesses.get(proc.key) === proc.ended) {
    exitingProcesses.delete(proc.key);
  }
  const turn = proc.turn;
  proc.turn = null;
  if (turn) {
    await turn.onEnd(failure);
    return;
  }
  // A turn the CLI started on its own ends with its process.
  closeFollowUpRun(proc, 1);
  if (failure && !wasRetired) {
    console.warn(`[Claude SDK] Idle process for session ${proc.key} ended:`, errorMessage(failure));
  }
}

/**
 * Starts a Claude Code process for a turn. With a session id it stays
 * resident afterwards for the session's next turns.
 * @param {Object} init - Launch options, the first prompt and the turn's sinks
 * @returns {Object} Process record
 */
function spawnClaudeProcess({ sdkOptions, signature, promptMessage, resident, turn, writer, sessionSummary, appSessionId, providerSessionId, contextWindow, normalizeMessage, startFollowUpRun, unattended = false, createQuery = (input) => query({ prompt: input.prompt as AsyncIterable<SDKUserMessage>, options: input.options }) }: ClaudeProcessInit): ClaudeProcess {
  const proc: ClaudeProcess = {
    key: null,
    // Bound before this record is published or its pump starts.
    instance: null!,
    inputReleased: false,
    pendingNativeSideQuestions: 0,
    releaseDeferred: false,
    signature,
    resident,
    status: 'active',
    // When the process started: background agents launched before it belong
    // to a process that has exited (see getClaudeSDKSessionStartTime).
    startedAt: Date.now(),
    turn,
    writer,
    sessionSummary,
    appSessionId,
    providerSessionId,
    // The managed catalog's window for the model, when there is one.
    contextWindow,
    // The window the SDK reported for the session (a resumed session starts
    // from the one its last run reported) and the main thread's model it was
    // reported for; see trackReportedContextWindow.
    reportedContextWindow: getReportedClaudeContextWindow(providerSessionId) ?? null,
    mainThreadModel: null,
    // The session's requests counted from its transcript when the process
    // started (null while that read runs), and the ones made since by id;
    // see sessionTokenTotal.
    sessionTokenLedger: null,
    liveRequestTokens: new Map(),
    normalizeMessage,
    // Opens a run for a turn the CLI starts on its own; see openFollowUpRun.
    startFollowUpRun,
    // True while such a turn runs in a run of its own.
    followUpRun: false,
    // True from the CLI's `system init` until its `result`: it is running a turn.
    cliBusy: true,
    // Set when a turn starts background work, moved to `heldForBackgroundWork`
    // by the next `result`: only work still outstanding holds a process open.
    backgroundWorkPending: false,
    // Set when the stream reports a task starting during the CLI's turn; the
    // task events then decide the hold (see noteCliTurnEnded).
    sawTaskEventThisTurn: false,
    heldForBackgroundWork: false,
    // The tasks the session has scheduled for itself, as the last Stop hook
    // reported them; null until one has (see noteScheduledTasks).
    scheduledTasks: null,
    // The CLI moved to another session (a typed /clear), so the process no
    // longer continues the one Codey maps; it exits after the turn.
    retireAfterTurn: false,
    timer: null,
    retired: false,
    lastActiveAt: Date.now(),
    push: () => false,
    releaseInput: () => {},
    ended: Promise.resolve()
  };
  bindProcessCallbacks(proc, sdkOptions, unattended);
  loadSessionTokenLedger(proc, sdkOptions);

  // `createQuery` is the SDK's own `query` unless the caller supplies one
  // (tests script the stream to drive the process logic without a CLI).
  let heldPrompt = createHeldPromptStream([promptMessage]);
  try {
    proc.instance = createQuery({
      prompt: heldPrompt.stream,
      options: sdkOptions
    });
  } catch (hookError) {
    // Older/newer SDK versions may not accept hook shapes yet.
    // Keep notification behavior operational via runtime events even if hook registration fails.
    console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', errorMessage(hookError));
    delete sdkOptions.hooks;
    // Discard the abandoned stream and build a fresh one for the retry.
    heldPrompt.release();
    heldPrompt = createHeldPromptStream([promptMessage]);
    proc.instance = createQuery({
      prompt: heldPrompt.stream,
      options: sdkOptions
    });
  }
  proc.push = heldPrompt.push;
  proc.releaseInput = () => {
    proc.inputReleased = true;
    heldPrompt.release();
  };

  console.log('Starting async generator loop for session:', providerSessionId || 'NEW');
  proc.ended = pumpProcess(proc);
  return proc;
}

/**
 * Retires every process no turn is running in, e.g. before tests end or the
 * server stops.
 * @returns {Promise<void>}
 */
export function retireIdleClaudeProcesses() {
  return Promise.all([...activeSessions.values()]
    .filter((proc) => proc.status !== 'active')
    .map((proc) => retireProcess(proc))).then(() => {});
}

/**
 * Retires the idle process Codey keeps for a session that Claude Desktop or a
 * terminal has opened since. It holds the conversation as it was and would
 * never be reused, but keeps its memory until the idle timeout. A process
 * still running a turn, or waiting for background work, is left alone. One
 * held only for the tasks its session scheduled is not: the other process
 * took them over when it resumed the session, and both would run them.
 *
 * Used by the sessions watcher (sessions-watcher.service.ts) when another
 * process registers for the session.
 * @param {string} providerSessionId - Claude Code's session id
 */
export function retireClaudeProcessesOpenedElsewhere(providerSessionId: string) {
  for (const proc of [...activeSessions.values()]) {
    if (proc.providerSessionId === providerSessionId && proc.status === 'idle'
      && (!proc.heldForBackgroundWork || (hasScheduledWork(proc) && !hasOutstandingBackgroundWork(proc)))) {
      retireProcess(proc);
    }
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>} Settles when the turn is over, which can be before
 *   its process exits
 */
export async function queryClaudeSDK(
  command: string,
  options: AnyRecord = {},
  ws: ClaudeRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  // The process running this turn: started for it, or the session's resident one.
  let proc: ClaudeProcess | null = null;
  // True while the client-facing turn is running and can take steering input.
  let acceptsSteering = false;
  // Steering written to stdin that the CLI has not taken up yet, by SDK uuid.
  // The CLI folds each into the running turn at its next tool boundary, or runs
  // it as a follow-up turn when none comes; its replay marks it consumed.
  const pendingSteerIds = new Set<string>();
  // Direct upstream clients wait for the CLI echo; Codey queued steering echoes at acceptance.
  const directSteerIds = new Set<string>();
  let steerFollowUpTimer: ReturnType<typeof setTimeout> | null = null;
  // The client is told the turn is over as soon as `result` lands.
  let turnCompleteSent = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // The budget last published, re-sent with the right total when the turn's
  // `result` is the first to state the window it is measured against.
  let lastSentTokenBudget: TokenBudget | null = null;
  // Rows a compaction kept, which the CLI streams a second time after it.
  const preservedByCompaction = new Set();
  // The managed catalog's window for the run's model, when there is one.
  let contextWindow: number | undefined;
  // Until the CLI takes up this turn's prompt, the turn it may already be
  // running (background work reporting back) is not this one: 'start' waits
  // for the next `system init`, 'replay' for the prompt's replay, and becomes
  // 'start' when the running turn ends without taking the prompt up.
  let awaitingPrompt: 'start' | 'replay' | null = null;
  let promptUuid: string | null = null;
  let finishTurn: () => void = () => {};
  const turnDone = new Promise<void>((resolve) => { finishTurn = resolve; });

  const steering = {
    canSteer: () => acceptsSteering,

    /**
     * Writes the input to the running CLI without interrupting it. Model,
     * effort and permissions stay those of the run.
     * @returns {Promise<{ clientMessageId: string }>} The uuid the transcript keeps
     */
    async steer(command: string, steerOptions: AnyRecord = {}) {
      // The CLI runs a slash command as a turn of its own once this one ends
      // and never echoes it back, so the turn would sit out the follow-up
      // grace waiting for it. Left queued, it simply runs as the next turn.
      if (SLASH_COMMAND_INPUT.test(String(command ?? '').trimStart())) {
        throw new AppError('A slash command runs as its own turn. Keep it queued for the next turn.', {
          code: 'STEER_UNAVAILABLE', statusCode: 409
        });
      }
      let message;
      try {
        [message] = await buildPromptMessages(command, steerOptions.images, steerOptions.files, options.cwd);
      } catch (error) {
        // Nothing reached the CLI, so this is a refusal the queue can keep,
        // not an uncertain delivery that has to be held for review.
        throw new AppError(`The steering input could not be prepared: ${errorMessage(error)}`, {
          code: 'STEER_UNAVAILABLE', statusCode: 409
        });
      }
      const directId = typeof steerOptions.messageId === 'string' && UUID_PATTERN.test(steerOptions.messageId)
        ? steerOptions.messageId : null;
      const uuid = directId ?? crypto.randomUUID();
      if (directId) directSteerIds.add(uuid);
      pendingSteerIds.add(uuid);
      // 'next' folds the input into the running turn at its next tool boundary.
      if (!acceptsSteering || !proc?.push({ ...message, uuid, priority: 'next' })) {
        pendingSteerIds.delete(uuid);
        directSteerIds.delete(uuid);
        throw new AppError('This turn cannot be steered now. Keep the draft or queue it for the next turn.', {
          code: 'STEER_UNAVAILABLE', statusCode: 409
        });
      }
      return { clientMessageId: uuid };
    },

    // Stop must not let queued steering start a new turn after the interrupt.
    cancelPending: () => Promise.all([...pendingSteerIds].map((uuid) => (
      Promise.resolve(proc?.instance?.cancelAsyncMessage?.(uuid)).catch(() => {})
    )))
  };

  const clearSteerFollowUp = () => {
    if (steerFollowUpTimer) {
      clearTimeout(steerFollowUpTimer);
      steerFollowUpTimer = null;
    }
  };

  // Ends the client-facing turn once its `result` is in: reports completion
  // and hands the process back to its session, where it stays resident, waits
  // for background work to report back, or exits.
  const settleTurn = () => {
    acceptsSteering = false;
    clearSteerFollowUp();
    if (sessionKey() && abortedSessionIds.has(sessionKey()!)) {
      // The abort sent the terminal complete and is closing the process;
      // its end finishes the turn.
      return;
    }
    if (!turnCompleteSent) {
      turnCompleteSent = true;
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: 'completed'
      });
    }
    if (proc?.turn === turn) {
      proc.turn = null;
      proc.status = 'idle';
      proc.lastActiveAt = Date.now();
      scheduleIdleProcess(proc);
    }
    finishTurn();
  };

  const reportFailure = async (error: unknown) => {
    console.error('SDK query error:', error);

    if (proc && supersededInstances.has(proc.instance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()!) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error. It
      // is still a cancelled run, reported the same way as when the stream
      // ends after the interrupt.
      if (!turnCompleteSent) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: 'aborted'
        });
      }
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : (error as Error).message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion still surfaces the error, but must not emit a
    // second terminal complete.
    // A session open in a terminal names the process, and the send it refused,
    // so the client that sent it can offer to take the session over and resend.
    const takeOver = error instanceof AppError && error.code === 'CLAUDE_SESSION_OPEN_ELSEWHERE'
      ? { code: error.code, takeOver: { ...readObjectRecord(error.details), messageId: options.clientMessageId ?? null } }
      : {};
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, ...takeOver, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  };

  const turn: ClaudeTurn = {
    steering,

    onMessage(message) {
      if (!proc) return;
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {
        capturedSessionId = message.session_id;
        proc.providerSessionId = capturedSessionId;
        if (!sessionId) {
          addSession(capturedSessionId!, proc);
        }

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId!);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      }

      if (message.type === 'system' && message.subtype === 'init'
        && message.session_id && message.session_id !== capturedSessionId) {
        proc.retireAfterTurn = true;
      }

      trackBackgroundWork(proc, message);
      const turnContextWindow = trackReportedContextWindow(proc, message);

      if (awaitingPrompt && ((message.isReplay === true && message.uuid === promptUuid)
        || (awaitingPrompt === 'start' && message.type === 'system' && message.subtype === 'init'))) {
        awaitingPrompt = null;
      }

      if (message.isReplay === true) {
        // The CLI took up input this run wrote. The prompt is already on screen
        // and accepted steering echoes its own row, so this only settles it.
        pendingSteerIds.delete(message.uuid);
        if (directSteerIds.delete(message.uuid)) {
          for (const echo of context.normalizeMessage(transformMessage(message), capturedSessionId || sessionId || null)) {
            delete echo.transcriptAnchorId;
            ws.send(echo);
          }
        }
        if (!isLocalCommandOutput(message)) {
          return;
        }
      }

      if (preservedByCompaction.has(message.uuid)) {
        return;
      }
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        for (const uuid of readPreservedMessageIds(message)) {
          preservedByCompaction.add(uuid);
        }
      }

      if (message.type === 'system' && message.subtype === 'status' && !turnCompleteSent
        && (message.status === 'compacting' || message.compact_result)) {
        // Compacting a large context can take a minute: name it instead of
        // the generic activity label, and hand the label back once it is done.
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: message.status === 'compacting' ? 'Compacting conversation' : '',
          canInterrupt: true,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'claude'
        }));
      }

      if (steerFollowUpTimer && message.type === 'system' && message.subtype === 'init') {
        // The CLI started the follow-up turn for steering that missed the last one.
        clearSteerFollowUp();
      }

      forwardMessage(proc, message);

      // Extract and send token budget updates from assistant usage payloads,
      // falling back to the turn's cumulative bill only for SDK builds that
      // report no per-assistant usage at all.
      trackRequestTokens(proc, message);
      const budgetContextWindow = knownContextWindow(proc);
      let tokenBudgetData = extractTokenBudget(message, budgetContextWindow)
        || (assistantBudgetSent || awaitingPrompt ? null : extractCumulativeTokenBudget(message, budgetContextWindow));
      const budgetTotal = resolveContextWindow(budgetContextWindow);
      if (!tokenBudgetData && turnContextWindow && lastSentTokenBudget && lastSentTokenBudget.total !== budgetTotal) {
        // The reading stands; only the window it is measured against was wrong.
        tokenBudgetData = { ...lastSentTokenBudget, total: budgetTotal };
      }
      if (tokenBudgetData) {
        if (message.type === 'assistant') {
          assistantBudgetSent = true;
        }
        lastSentTokenBudget = tokenBudgetData;
        publishTokenBudget(proc, ws, tokenBudgetData, capturedSessionId || sessionId || null);
      }

      if (startsBackgroundWork(message)) {
        proc.backgroundWorkPending = true;
      }

      if (message.type !== 'result') {
        return;
      }
      if (awaitingPrompt) {
        // The turn the CLI was already running ended without taking up this
        // prompt, which it runs next.
        noteCliTurnEnded(proc, true);
        awaitingPrompt = 'start';
        return;
      }
      noteCliTurnEnded(proc, false);
      const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()) : false;
      if (pendingSteerIds.size > 0 && acceptsSteering && !abortPending) {
        // Steering that missed this turn's last tool boundary runs as a
        // follow-up turn in the same process, so the client's turn goes on.
        clearSteerFollowUp();
        steerFollowUpTimer = setTimeout(() => {
          steerFollowUpTimer = null;
          pendingSteerIds.clear();
          settleTurn();
        }, STEER_FOLLOW_UP_GRACE_MS);
        steerFollowUpTimer.unref?.();
      } else {
        // The turn is done as far as the client is concerned.
        settleTurn();
      }
    },

    // The process ended while this turn was running in it.
    async onEnd(error) {
      if (!proc) return;
      acceptsSteering = false;
      clearSteerFollowUp();
      if (error) {
        await reportFailure(error);
        finishTurn();
        return;
      }

      // A superseded run winds down silently: the map entry, the abort flag,
      // and all client-facing events belong to the run that replaced it.
      const superseded = supersededInstances.has(proc.instance);

      // Send the terminal completion event — skipped for aborted runs, whose
      // terminal `complete` (aborted: true) was already sent by abort-session.
      const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
      if (!turnCompleteSent && !superseded) {
        turnCompleteSent = true;
        if (!wasAborted) {
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
        }
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'claude',
          sessionId: sessionId || capturedSessionId || null,
          sessionName: sessionSummary,
          stopReason: wasAborted ? 'aborted' : 'completed'
        });
      }
      finishTurn();
    }
  };

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      if (codeyClaudeGateway.isManaged()) throw error;
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const managedModel = codeyClaudeGateway.isManaged()
      ? effortModels.OPTIONS.find(({ value }) => value === (resolvedModel || options.model))
      : null;
    if (codeyClaudeGateway.isManaged() && !managedModel) {
      throw new Error('This Claude model is not available through the Codey Messages API.');
    }
    contextWindow = managedModel?.contextWindow;

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
      contextWindow,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    const bypassNotice = withdrawRefusedBypassMode(sdkOptions);
    if (bypassNotice) {
      ws.send(createNormalizedMessage({ kind: 'error', content: bypassNotice, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    }

    // The CLI echoes stdin input back when it takes it up. That echo is how a
    // turn recognises its prompt and steering learns its input was consumed;
    // it is never forwarded.
    sdkOptions.extraArgs = { ...sdkOptions.extraArgs, 'replay-user-messages': null };

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`, for steering, background work and the session's next turn.
    const [promptMessage] = await buildPromptMessages(command, options.images, options.files, options.cwd);
    // The transcript keeps the uuid a prompt is submitted with, so the client's
    // send receipt becomes the persisted row's identity and its optimistic
    // bubble is retired by that row rather than by matching text and time.
    // Claude Code only accepts a UUID; without one the turn names its prompt.
    promptUuid = typeof options.clientMessageId === 'string' && UUID_PATTERN.test(options.clientMessageId)
      ? options.clientMessageId
      : crypto.randomUUID();
    promptMessage.uuid = promptUuid;

    const signature = launchSignature({ ...sdkOptions, unattended: options.unattended === true });
    const resident = sessionId ? getSession(sessionId) : undefined;
    if (sdkOptions.resume) {
      const owner = await findForeignSessionProcess(sdkOptions.resume);
      if (owner) {
        // Whatever the other process adds, this one would not know about.
        if (resident && resident.status !== 'active') {
          retireProcess(resident);
        }
        const waitKey = sessionKey();
        const wait = new AbortController();
        if (waitKey) {
          foreignTurnWaits.set(waitKey, wait);
        }
        try {
          await takeOverSession(owner, {
            providerSessionId: sdkOptions.resume,
            cwd: options.cwd,
            confirmed: options.takeOver === true,
            writer: ws,
            normalizeMessage: context.normalizeMessage,
            signal: wait.signal,
          });
        } finally {
          if (waitKey && foreignTurnWaits.get(waitKey) === wait) {
            foreignTurnWaits.delete(waitKey);
          }
        }
      }
    }
    let reusable = Boolean(resident && resident.status === 'idle' && !resident.retired
      && !resident.retireAfterTurn && resident.signature === signature
      && sdkOptions.resume && !sdkOptions.resumeSessionAt
      && resident.providerSessionId === providerSessionId);
    // Claude Desktop or a terminal may have continued the session, and exited,
    // while the resident process sat idle with the conversation as it was.
    if (reusable && await isTranscriptContinuedElsewhere(providerSessionId!, options.cwd)) {
      reusable = false;
    }

    if (reusable && resident && resident.push(promptMessage)) {
      proc = resident;
      clearProcessTimer(proc);
      // A turn the CLI started on its own and still runs streams to this
      // turn from here on, so the run it had is over for its clients.
      closeFollowUpRun(proc, 0);
      Object.assign(proc, {
        status: 'active', turn, writer: ws, sessionSummary, contextWindow,
        normalizeMessage: context.normalizeMessage, startFollowUpRun: context.startFollowUpRun, lastActiveAt: Date.now(),
      });
      // A CLI already running a turn (background work reporting back) takes
      // the prompt up later; its replay tells when. A slash command is never
      // replayed, so it is recognised as the next turn the CLI starts.
      const replayed = !SLASH_COMMAND_INPUT.test(command.trimStart());
      awaitingPrompt = proc.cliBusy || (proc.heldForBackgroundWork && replayed) ? 'replay' : 'start';
    } else {
      if (resident && resident.status !== 'active') {
        // The turn needs a process launched differently (another model,
        // effort or permissions, or an edit), or one that reloads a
        // transcript another process continued.
        retireProcess(resident);
      }
      // A process of this session that is still exiting (retired just now, or
      // stopped by an abort) must stop writing the transcript before another
      // one resumes it.
      const exiting = sessionId ? exitingProcesses.get(sessionId) : undefined;
      if (exiting) {
        let timer;
        await Promise.race([exiting, new Promise((resolve) => { timer = setTimeout(resolve, RETIRE_WAIT_MS); })]);
        clearTimeout(timer);
      }
      awaitingPrompt = 'start';
      proc = spawnClaudeProcess({
        sdkOptions,
        signature,
        promptMessage,
        resident: Boolean(sessionId),
        turn,
        writer: ws,
        sessionSummary,
        appSessionId: sessionId || null,
        providerSessionId,
        contextWindow,
        normalizeMessage: context.normalizeMessage,
        startFollowUpRun: context.startFollowUpRun,
        createQuery: context.createQuery,
        unattended: options.unattended === true,
      });
      if (sessionKey()) {
        addSession(sessionKey(), proc);
      }
    }

    // Track the turn for abort and steering capability
    acceptsSteering = true;
    if (sessionKey()) {
      ws.send(createNormalizedMessage({ kind: 'status', canSteer: true, canInterrupt: true, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    }
  } catch (error) {
    if (proc?.turn === turn) {
      // The turn failed after reaching a process, which is now in an unknown state.
      proc.turn = null;
      retireProcess(proc);
    }
    await reportFailure(error);
    return;
  }

  await turnDone;
}

/**
 * Aborts the turn running in a session's process and closes the process.
 *
 * A turn the CLI started on its own is interrupted and the process left
 * running. A turn still waiting for Claude Desktop or a terminal to finish
 * theirs is cancelled without touching that process. A turn of theirs that a
 * tab follows is interrupted with SIGINT, only on the user's explicit Stop.
 * @param {string} sessionId - Session identifier
 * @param {import('@/shared/types.js').ProviderAbortOptions} [options]
 * @returns {boolean} True if a running turn was aborted, false if none was found
 */
export async function abortClaudeSDKSession(sessionId: string, options: ProviderAbortOptions = {}) {
  const waiting = foreignTurnWaits.get(sessionId);
  if (waiting) {
    // The turn's failure report reads this and stays silent.
    abortedSessionIds.add(sessionId);
    waiting.abort();
    return true;
  }

  const observed = observedForeignTurns.get(sessionId);
  if (observed) {
    if (!options.allowExternalTurn) {
      return false;
    }
    const interrupted = await signalForeignSessionProcess(observed.owner, 'SIGINT');
    if (interrupted) {
      observed.following.abort();
    }
    return interrupted;
  }

  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  if (session.status !== 'active' && session.followUpRun) {
    // A turn the CLI started on its own: interrupt only the turn. The process
    // stays, with the background work it is still running; the caller ends
    // the run.
    try {
      await session.instance.interrupt();
    } catch (error) {
      console.error(`Error interrupting follow-up turn for session ${sessionId}:`, error);
      return false;
    }
    session.followUpRun = false;
    return true;
  }

  if (session.status !== 'active') {
    // A resident process between turns has nothing to stop.
    retireProcess(session);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the turn knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);

    // Interrupting alone would let queued steering run as a fresh turn.
    await session.turn?.steering.cancelPending();

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Close the process rather than keeping it for the next turn: its end
    // finishes the interrupted turn.
    session.status = 'aborted';
    retireProcess(session);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Whether the session's running turn takes steering input right now.
 * @param {string} sessionId - Session identifier
 * @returns {boolean}
 */
function canSteerClaudeSDKSession(sessionId: string) {
  const session = getSession(sessionId);
  return Boolean(session?.status === 'active' && session.turn?.steering.canSteer());
}

/**
 * Appends input to the session's running turn without interrupting it.
 * @param {string} sessionId - Session identifier
 * @param {string} command - Steering text
 * @param {Object} options - Validated { images, files } attachments
 * @returns {Promise<{ clientMessageId: string }>} Identity the transcript keeps
 */
export function steerClaudeSDKSession(sessionId: string, command: string, options: AnyRecord & { messageId: string }): Promise<boolean>;
export function steerClaudeSDKSession(sessionId: string, command: string, options?: AnyRecord): Promise<{ clientMessageId: string }>;
export async function steerClaudeSDKSession(sessionId: string, command: string, options: AnyRecord = {}) {
  if (!canSteerClaudeSDKSession(sessionId)) {
    if (typeof options.messageId === 'string') return false;
    throw new AppError('This turn cannot be steered now. Keep the draft or queue it for the next turn.', {
      code: 'STEER_UNAVAILABLE', statusCode: 409
    });
  }
  const receipt = await getSession(sessionId)!.turn!.steering.steer(command, options);
  return typeof options.messageId === 'string' ? true : receipt;
}

/**
 * Sessions whose background tasks are still outstanding, with the tasks, and
 * sessions with tasks scheduled to wake them later, with those.
 *
 * A session stays here after its turn's `result` for as long as its process
 * is held for the work — which is exactly the window in which nothing else
 * (the chat run registry marks the run completed at `result`) knows the
 * session is still busy.
 * @returns {Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary>, scheduled?: Array<import('@/shared/types.js').ScheduledTaskSummary> }>}
 */
export function listClaudeSDKBackgroundWork() {
  const work = new Map<string, { sessionId: string; tasks: BackgroundTaskSummary[]; scheduled?: ScheduledTaskSummary[] }>(backgroundWork.list().map((entry) => [entry.sessionId, entry]));
  for (const [sessionId, proc] of activeSessions) {
    if (!proc.retired && hasScheduledWork(proc)) {
      work.set(sessionId, { sessionId, tasks: work.get(sessionId)?.tasks ?? [], scheduled: proc.scheduledTasks ?? undefined });
    }
  }
  return [...work.values()];
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 *
 * The CLI acknowledges `stop_task` even when it stops nothing (seen with a
 * Monitor task, CLI 2.1.318), so the stop only counts once the task has left
 * the tracker; otherwise this throws and the user hears the stop failed.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @param {number} confirmMs - How long to wait for the task to settle
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
// A repeated ✕ joins the stop under way instead of sending stop_task again.
const pendingTaskStops = new Map<string, Promise<boolean>>();

export function stopClaudeSDKTask(sessionId: string, taskId: string, confirmMs = 5000): Promise<boolean> {
  const key = `${sessionId}\u0000${taskId}`;
  const pending = pendingTaskStops.get(key);
  if (pending) return pending;
  const stop = runClaudeSDKTaskStop(sessionId, taskId, confirmMs)
    .finally(() => pendingTaskStops.delete(key));
  pendingTaskStops.set(key, stop);
  return stop;
}

async function runClaudeSDKTaskStop(sessionId: string, taskId: string, confirmMs: number): Promise<boolean> {
  const session = getSession(sessionId);
  const stopTask = session?.instance?.stopTask;
  if (!session || !stopTask || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  // Not awaited: the CLI may answer late or never, and the task leaving the
  // tracker is what counts, so one deadline covers both waits.
  let answered = false;
  let failed = false;
  let failure: unknown;
  stopTask.call(session.instance, taskId).then(
    () => { answered = true; },
    (error: unknown) => { answered = true; failed = true; failure = error; },
  );
  const deadline = Date.now() + confirmMs;
  while (backgroundWork.has(sessionId, taskId)) {
    if (failed) {
      throw failure;
    }
    if (Date.now() >= deadline) {
      throw new Error(answered
        ? `Claude Code acknowledged the stop, but background task "${taskId}" is still running.`
        : `Claude Code did not answer the stop of background task "${taskId}".`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/**
 * Checks if a turn is running in a session's SDK process
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
export function isClaudeSDKSessionActive(sessionId: string) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * When the Claude Code process serving a session started, or null when none
 * is up.
 *
 * The history reader uses this to tell a background agent launched by the
 * live process (still able to report back) from one launched by an earlier
 * process that has since exited (never will): a launch row older than the
 * live process cannot belong to it. A process resident between turns, or held
 * for background work, is still live, so this does not require a running turn.
 * @param {string} sessionId - Session identifier
 * @returns {number|null} Epoch milliseconds the live process started, or null
 */
export function getClaudeSDKSessionStartTime(sessionId: string) {
  const session = getSession(sessionId);
  return session && !session.retired ? session.startedAt : null;
}

/**
 * Gets the ids of sessions with a turn running
 * @returns {Array<string>} Array of active session IDs
 */
export function getActiveClaudeSDKSessions() {
  return [...activeSessions.entries()]
    .filter(([, session]) => session.status === 'active')
    .map(([sessionId]) => sessionId);
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
export function getPendingApprovalsForSession(sessionId: string) {
  const pending: AnyRecord[] = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
export function reconnectSessionWriter(sessionId: string, newRawWs: unknown) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

/**
 * SDK 0.3.311 ships `Query.prototype.askSideQuestion` without it in the SDK's
 * own typings (checked in node_modules/@anthropic-ai/claude-agent-sdk) — hence
 * the local types below rather than an imported one.
 */
type NativeSideQuestionResult = {
  response: string;
  synthetic: boolean;
  refusalFallback?: AnyRecord;
};

type NativeSideQuestionCapableInstance = {
  askSideQuestion: (
    question: string,
    options?: { signal?: AbortSignal },
  ) => Promise<NativeSideQuestionResult | null>;
};

/**
 * Asks a side question on the live query of `request.appSessionId`, when one
 * is up and ships the method, or on a read-only fork otherwise.
 *
 * Measured 2026-10-27 (`claude-measurement`, SDK 0.3.311, five calls each,
 * alternating): median response time, native vs the fork —
 *   mid-turn (process mid-generation):        native 1504 ms, fork 7476 ms
 *   background (held only for background work): native 2141 ms, fork 5016 ms
 * Native wins in both busy states, so the path taken here does not depend on
 * which one the process is in: any live query with the method answers
 * natively. Caveat: the CLI refused a foreground `sleep 240` during
 * measurement, so most "mid-turn" calls likely ran after the turn ended too
 * — the gap there may be narrower than measured, not wider.
 *
 * `liveTasks` for the fork path comes from this runtime's own background
 * work tracker, keyed by the app session id, so the fork's prompt can say
 * which of the session's own tasks are still running.
 */
async function askSideQuestion(
  request: SideQuestionRequest,
  sink: SideQuestionSink,
  context: ProviderRuntimeContext,
): Promise<SideQuestionOutcome> {
  const session = getSession(request.appSessionId);
  // The SDK does not type this method (see above), so the instance is read
  // through the local type rather than `ClaudeQuery`. Kept alongside the
  // original (`session.instance`, typed `ClaudeQuery`) so the `finally`
  // below can compare identity without comparing through this cast — the
  // cast's structural type and `ClaudeQuery` share no members TS can see,
  // so a `===` between two values of those two types reads as a mistake.
  const instance = session?.instance as NativeSideQuestionCapableInstance | undefined;

  // A session whose stdin was already released (turn ended with no
  // background work, or the idle ceiling) still has `instance` around, but
  // a write into its input stream is silently dropped rather than answered.
  // The fork path below spawns its own process instead, so it is the only
  // one that can still reach this session's transcript.
  // `session &&` (not just `instance &&`) narrows `session` itself for the
  // rest of this block, since `instance` was read off it through a cast TS
  // cannot trace back.
  if (session && instance && typeof instance.askSideQuestion === 'function' && !session.inputReleased) {
    // Counted on the session entry so `queryClaudeSDK`'s
    // `maybeReleasePromptStream` defers a release requested while this is
    // still above zero, instead of closing stdin under the question.
    session.pendingNativeSideQuestions = (session.pendingNativeSideQuestions || 0) + 1;
    try {
      const result = await instance.askSideQuestion(request.question, { signal: request.signal });
      const response = result?.response;
      if (typeof response === 'string' && response.length > 0) {
        sink.delta(response);
        return { status: 'done', answer: response };
      }
      return { status: 'error', error: 'Claude returned no answer.', answer: '' };
    } catch (error) {
      // `request.signal` is what `dismiss` aborts to end this ask at once —
      // a deliberate drop, never retried. A session whose stdin was
      // released while this ask was still outstanding (a new turn
      // superseding this one via `releaseHeldSession`, which lets the old
      // process go directly and does not consult the pending count above)
      // is the CLI cancelling the question for a reason that was not that
      // signal — most of all "Side question cancelled" — so it gets one
      // more try on the read-only fork instead of surfacing the CLI's own
      // error. A plain failure with the session still live is not retried.
      // `session` (not a fresh lookup) so a map entry replaced meanwhile by
      // a new turn's own registration does not hide this very query's
      // release, which `releaseHeldSession` sets on this same object.
      // Cast through `unknown`: the `if` above narrowed `session.inputReleased`
      // to the literal `false`, but that narrowing does not survive the
      // `await` above in reality — `releaseHeldSession` can flip it from
      // other code while this call is in flight — so TS's belief that this
      // comparison can never be true is the stale part, not the check.
      if (!request.signal?.aborted && (session.inputReleased as unknown) === true) {
        return askClaudeSideQuestion(request, sink, {
          createQuery: context.createQuery,
          liveTasks: backgroundWork.outstanding(request.appSessionId),
        });
      }
      return { status: 'error', error: errorMessage(error), answer: '' };
    } finally {
      // Re-fetched: a mid-run re-registration (`addSession`, once the
      // provider session id lands) carries this count onto a new entry
      // object for the same instance, so the one to decrement is whichever
      // is current now — but only when it is still the entry for the
      // instance this question was asked on. A turn that superseded this
      // run while the question was in flight replaced the map entry with
      // the new run's own (a different `instance`, a `pendingNativeSideQuestions`
      // count that was never incremented for this question), and must not
      // be decremented or released on this question's account.
      const entry = getSession(request.appSessionId);
      // Compared through `unknown`, not through the `NativeSideQuestionCapableInstance`
      // cast above: `entry.instance` is `ClaudeQuery` and `instance` is that
      // cast's type, and the two share no member TS can see, so a direct
      // `===` between them reads as unintentional even though both sides
      // are (or were) the very same object.
      if (entry && (entry.instance as unknown) === (instance as unknown)) {
        entry.pendingNativeSideQuestions = Math.max(0, (entry.pendingNativeSideQuestions || 0) - 1);
        if (entry.pendingNativeSideQuestions === 0 && entry.releaseDeferred) {
          entry.releaseDeferred = false;
          scheduleIdleProcess(entry);
        }
      }
    }
  }

  return askClaudeSideQuestion(request, sink, {
    createQuery: context.createQuery,
    liveTasks: backgroundWork.outstanding(request.appSessionId),
  });
}

/** Provider registry dispatches Claude runs, controls and side questions through this adapter. */
export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  prepareObservation: prepareClaudeObservation,
  canSteer: canSteerClaudeSDKSession,
  steer: steerClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
  askSideQuestion,
};
