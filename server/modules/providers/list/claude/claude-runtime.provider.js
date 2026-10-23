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
import {
  buildClaudeContextLaunch,
  claudeCodeRefusesBypassPermissions,
  codeyClaudeGateway
} from '@/modules/providers/services/codey-claude-gateway.service.js';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  CLAUDE_ULTRACODE_EFFORT
} from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  CODEY_CLAUDE_ENTRYPOINT,
  findForeignSessionProcess,
  isTranscriptContinuedElsewhere
} from '@/modules/providers/list/claude/claude-session-owner.service.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
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
  rememberClaudeContextWindow
} from '@/modules/providers/services/provider-token-usage.service.js';
import { AppError, createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

// Session key -> the Claude Code process serving it, whether a turn is
// running in it ('active') or it is resident between turns ('idle').
const activeSessions = new Map();
// Session key -> exit of a retired process that may still be writing its transcript.
const exitingProcesses = new Map();
// Outstanding background tasks per live session, keyed like activeSessions. An
// entry lives exactly as long as the process registered under the key: cleared
// when that process is retired or ends, and reset when another one takes the
// key over.
const backgroundWork = createBackgroundWorkTracker();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

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

function readNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
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

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ultracode is a session-scoped setting rather than an SDK effort level: it pairs xhigh
// effort with standing dynamic-workflow orchestration, and the CLI only honours it when
// Workflows are enabled. The catalog offers it as an effort choice for the picker, so the
// selection is translated back into the two options the SDK actually understands here.
const ULTRACODE_SDK_EFFORT = 'xhigh';

/**
 * The effort to launch with, or undefined to leave it to Claude Code.
 * @param {string} model - Catalog model id
 * @param {string|undefined} effort - The run's selection; 'default' or missing means none
 * @param {Object} [modelsDefinition] - Catalog the selection is validated against
 * @param {{ useCatalogDefault?: boolean }} [options] - Managed nodes send the
 *   catalog's default instead of none: Codex reads its default from the config
 *   Codey manages, but Claude Code has no such config, so the runtime applies it
 * @returns {string|undefined}
 */
function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS, { useCatalogDefault = false } = {}) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  if (typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)) {
    return effort;
  }
  const catalogDefault = selectedModel?.effort?.default;
  return useCatalogDefault && allowedEfforts.includes(catalogDefault) ? catalogDefault : undefined;
}

/**
 * Writes the resolved effort choice onto the SDK options, expanding `ultracode` into the
 * xhigh effort level plus the session-scoped settings it requires.
 * @param {Object} sdkOptions - SDK options being built
 * @param {string|undefined} resolvedEffort - Catalog-validated effort selection
 */
function applyClaudeEffort(sdkOptions, resolvedEffort) {
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

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

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

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
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
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
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

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort, resumeAnchorId, resumeFromScratch } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = {
    ...codeyClaudeGateway.buildEnvironment(),
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS),
    // What tells Codey's processes from Claude Desktop's or a terminal's
    // (see findForeignSessionProcess); never inherited from the node's shell.
    CLAUDE_CODE_ENTRYPOINT: CODEY_CLAUDE_ENTRYPOINT,
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
function withdrawRefusedBypassMode(sdkOptions, uid = process.getuid?.()) {
  if (sdkOptions.permissionMode !== 'bypassPermissions'
    || !claudeCodeRefusesBypassPermissions(sdkOptions.env || {}, uid)) {
    return null;
  }
  delete sdkOptions.permissionMode;
  return BYPASS_REFUSED_NOTICE;
}

/**
 * Refusal for a turn whose session another Claude Code process has open.
 * @param {{ pid: number, entrypoint: string }} owner - From findForeignSessionProcess
 * @returns {AppError}
 */
function sessionOpenElsewhereError(owner) {
  const where = owner.entrypoint.startsWith('claude-desktop')
    ? `Claude Desktop (process ${owner.pid})`
    : `another Claude Code process (${owner.entrypoint}, process ${owner.pid})`;
  return new AppError(`This session is open in ${where}. Continue it there; Codey can send to it again once `
    + 'that process has exited. Two processes continuing one session split the conversation, '
    + 'so your message was not sent.', { code: 'CLAUDE_SESSION_OPEN_ELSEWHERE', statusCode: 409 });
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
function addSession(sessionId, proc) {
  const existing = activeSessions.get(sessionId);
  if (existing && existing !== proc) {
    if (existing.status === 'active') {
      supersededInstances.add(existing.instance);
      Promise.resolve()
        .then(() => existing.turn?.steering.cancelPending())
        .then(() => existing.instance.interrupt())
        .catch((error) => {
          console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
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
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

function clearProcessTimer(proc) {
  if (proc.timer) {
    clearTimeout(proc.timer);
    proc.timer = null;
  }
}

function armProcessTimer(proc, delayMs) {
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
function isRegisteredProcess(proc) {
  return Boolean(proc.key) && activeSessions.get(proc.key) === proc;
}

/**
 * Forgets a process as the one serving its session: its outstanding
 * background work goes with it, and a history page cached while it was up
 * (which still says `running` for any agent that never reported back) is
 * dropped.
 * @param {Object} proc - Process record
 */
function unregisterProcess(proc) {
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
function retireProcess(proc) {
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
 * used first and those still waiting on background work last.
 * @param {Object} proc - Process record
 */
function scheduleIdleProcess(proc) {
  if (proc.retired || proc.status !== 'idle') {
    return;
  }
  if (proc.heldForBackgroundWork) {
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
    .filter((candidate) => candidate.status === 'idle' && !candidate.retired)
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
function hasOutstandingBackgroundWork(proc) {
  return isRegisteredProcess(proc) && backgroundWork.hasOutstanding(proc.key);
}

/**
 * Folds one SDK message into the process's background-work bookkeeping: the
 * tracker of outstanding tasks (only for the process registered for its
 * session — a retired one's late events must not touch its successor's), and
 * whether the CLI turn under way reported any task starting.
 * @param {Object} proc - Process record
 * @param {Object} message - SDK stream message
 */
function trackBackgroundWork(proc, message) {
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
 * @param {Object} proc - Process record
 * @param {boolean} reportsBack - The turn was the CLI's own follow-up, not a Codey turn
 */
function noteCliTurnEnded(proc, reportsBack) {
  const stillOutstanding = hasOutstandingBackgroundWork(proc);
  if (reportsBack && proc.heldForBackgroundWork && !stillOutstanding) {
    // The last of the work the process was held for has reported back.
    notifyBackgroundWorkCompleted({
      userId: proc.writer?.userId || null,
      provider: 'claude',
      sessionId: proc.appSessionId || proc.providerSessionId || null,
      sessionName: proc.sessionSummary
    });
  }
  proc.heldForBackgroundWork = proc.sawTaskEventThisTurn
    ? stillOutstanding
    : proc.backgroundWorkPending || stillOutstanding;
  proc.backgroundWorkPending = false;
  proc.sawTaskEventThisTurn = false;
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
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
export function isSubagentPromptEcho(message) {
  return Boolean(message?.parentToolUseId) && message.role === 'user' && message.kind === 'text';
}

function readNumber(value) {
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
function isEmptyTokenBudget(budget) {
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
 * @property {{ input: number, output: number }} breakdown
 */

/**
 * The window a budget is measured against: the one the run knows for its
 * model (the managed catalog's, else the one the SDK reported for the
 * session), else the server-wide CONTEXT_WINDOW setting.
 * @param {number|null|undefined} contextWindow - Known window of the run's model
 * @returns {number} Context window in tokens
 */
function resolveContextWindow(contextWindow) {
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    return contextWindow;
  }
  return parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;
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
function readReportedContextWindow(sdkMessage, mainModel) {
  const modelUsage = sdkMessage?.type === 'result' ? sdkMessage.modelUsage : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return null;
  }

  const reported = Object.entries(modelUsage).filter(
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
function knownContextWindow(proc) {
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
function trackReportedContextWindow(proc, message) {
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
 * Builds a context-window budget from an Anthropic-shaped usage payload.
 *
 * `input_tokens + cache_read + cache_creation` is one request's whole prompt,
 * which is exactly what the context window holds at that moment.
 * @param {Object} messageUsage - Anthropic usage payload
 * @param {number|null} [contextWindow] - Known window of the run's model (see resolveContextWindow)
 * @returns {TokenBudget} Token budget object
 */
function buildTokenBudget(messageUsage, contextWindow) {
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
function extractTokenBudget(sdkMessage, contextWindow) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // Subagent traffic (parent_tool_use_id set) reports the subagent's own
  // context window, not this session's — surfacing it makes the counter drop
  // to the subagent's number and bounce back on the next main-thread event.
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  // Only assistant messages carry Anthropic-shaped usage. System
  // task_progress/task_notification events have a top-level `usage` too, but
  // shaped {total_tokens, tool_uses, duration_ms} — reading Anthropic keys
  // off it yields an all-zero budget that flashes "0" in the composer.
  if (sdkMessage.type !== 'assistant') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage;
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
function extractCumulativeTokenBudget(sdkMessage, contextWindow) {
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
export function startsBackgroundWork(sdkMessage) {
  const content = sdkMessage?.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
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
 * @returns {{
 *   apply: (sessionKey: string, message: Object) => void,
 *   hasOutstanding: (sessionKey: string) => boolean,
 *   has: (sessionKey: string, taskId: string) => boolean,
 *   outstanding: (sessionKey: string) => Array<import('@/shared/types.js').BackgroundTaskSummary>,
 *   clear: (sessionKey: string) => void,
 *   list: () => Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>
 * }}
 */
export function createBackgroundWorkTracker() {
  /** @type {Map<string, Map<string, import('@/shared/types.js').BackgroundTaskSummary>>} */
  const sessions = new Map();
  /**
   * Tool-use ids the session's own turns issued. A task started for a call an
   * agent made inside its own transcript — a workflow agent's backgrounded
   * command, say — reaches this stream too, and nothing in the parent
   * transcript could show it; it is kept for stopping but flagged `nested`.
   * @type {Map<string, Set<string>>}
   */
  const ownToolUseIds = new Map();

  const remove = (sessionKey, taskId) => {
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
    apply(sessionKey, message) {
      if (message?.type === 'assistant' && !message.parent_tool_use_id) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string') {
              let ids = ownToolUseIds.get(sessionKey);
              if (!ids) {
                ids = new Set();
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
          const task = {
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
            tasks = new Map();
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

    hasOutstanding(sessionKey) {
      return sessions.has(sessionKey);
    },

    has(sessionKey, taskId) {
      return Boolean(sessions.get(sessionKey)?.has(taskId));
    },

    outstanding(sessionKey) {
      return Array.from(sessions.get(sessionKey)?.values() ?? []);
    },

    clear(sessionKey) {
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
function isLocalCommandOutput(sdkMessage) {
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
function readPreservedMessageIds(sdkMessage) {
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
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
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
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void, push: (message: Object) => boolean }}
 *   Stream, its closer, and an appender that refuses once the stream is released
 */
function createHeldPromptStream(messages) {
  const queued = [...messages];
  let released = false;
  let wake = null;
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
      await new Promise((resolve) => { wake = resolve; });
    }
  })();

  return {
    stream,
    release: () => {
      released = true;
      notify();
    },
    push: (message) => {
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
async function loadMcpConfig(cwd) {
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
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

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
    console.error('Error loading MCP config:', error.message);
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
function launchSignature(sdkOptions) {
  const { resume, resumeSessionAt, hooks, canUseTool, ...launch } = sdkOptions;
  // The SDK stamps its version into the server's own environment on first use,
  // which the next turn's copy then carries.
  const { CLAUDE_AGENT_SDK_VERSION, ...env } = launch.env || {};
  return crypto.createHash('sha256').update(JSON.stringify({ ...launch, env })).digest('hex');
}

function emitProcessNotification(proc, event) {
  notifyUserIfEnabled({
    userId: proc.writer?.userId || null,
    writer: proc.writer,
    event
  });
}

/**
 * Binds the SDK callbacks of a process. They outlive the turn that launched
 * it, so they address whichever turn is running now through the record.
 * @param {Object} proc - Process record
 * @param {Object} sdkOptions - SDK options the process is launched with
 */
function bindProcessCallbacks(proc, sdkOptions) {
  // Notifications are app-facing, so they carry the app session id.
  const appSessionId = () => proc.appSessionId || proc.providerSessionId || null;
  const streamSessionId = () => proc.providerSessionId || proc.appSessionId || null;

  sdkOptions.hooks = {
    Notification: [{
      matcher: '',
      hooks: [async (input) => {
        const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
        emitProcessNotification(proc, createNotificationEvent({
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
    }]
  };

  // AskUserQuestion and ExitPlanMode reach this callback in 'auto' and
  // 'bypassPermissions' modes too: Claude Code returns their "ask" before
  // either mode can approve them (checked against Claude Code 2.1.165), so
  // questions and plan approvals still wait for the user.
  sdkOptions.canUseTool = async (toolName, input, context) => {
    const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

    if (!requiresInteraction) {
      if (sdkOptions.permissionMode === 'bypassPermissions') {
        return { behavior: 'allow', updatedInput: input };
      }

      const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isDisallowed) {
        return { behavior: 'deny', message: 'Tool disallowed by settings' };
      }

      const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
        matchesToolPermission(entry, toolName, input)
      );
      if (isAllowed) {
        return { behavior: 'allow', updatedInput: input };
      }
    }

    const requestId = createRequestId();
    proc.writer.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: streamSessionId(), provider: 'claude' }));
    emitProcessNotification(proc, createNotificationEvent({
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
          sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
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
function forwardMessage(proc, message) {
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
 * Handles what the CLI sends while no Codey turn runs in the process:
 * background work reporting back in a follow-up turn. It goes to the last
 * turn's writer, as it did when the process was held open only for that work.
 * @param {Object} proc - Process record
 * @param {Object} message - SDK stream message
 */
function handleIdleMessage(proc, message) {
  trackBackgroundWork(proc, message);
  trackReportedContextWindow(proc, message);
  if (message.isReplay === true && !isLocalCommandOutput(message)) {
    return;
  }
  forwardMessage(proc, message);
  const tokenBudget = extractTokenBudget(message, knownContextWindow(proc));
  if (tokenBudget) {
    proc.writer.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget, sessionId: proc.providerSessionId, provider: 'claude' }));
  }
  if (startsBackgroundWork(message)) {
    proc.backgroundWorkPending = true;
  }
  if (message.type === 'result') {
    noteCliTurnEnded(proc, true);
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
    // different: the CLI relays its result in a turn of its own.
    proc.heldForBackgroundWork = false;
    scheduleIdleProcess(proc);
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
async function pumpProcess(proc) {
  let failure = null;
  try {
    for await (const message of proc.instance) {
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
  if (exitingProcesses.get(proc.key) === proc.ended) {
    exitingProcesses.delete(proc.key);
  }
  const turn = proc.turn;
  proc.turn = null;
  if (turn) {
    await turn.onEnd(failure);
  } else if (failure && !wasRetired) {
    console.warn(`[Claude SDK] Idle process for session ${proc.key} ended:`, failure?.message || failure);
  }
}

/**
 * Starts a Claude Code process for a turn. With a session id it stays
 * resident afterwards for the session's next turns.
 * @param {Object} init - Launch options, the first prompt and the turn's sinks
 * @returns {Object} Process record
 */
function spawnClaudeProcess({ sdkOptions, signature, promptMessage, resident, turn, writer, sessionSummary, appSessionId, providerSessionId, contextWindow, normalizeMessage, createQuery = query }) {
  const proc = {
    key: null,
    instance: null,
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
    normalizeMessage,
    // True from the CLI's `system init` until its `result`: it is running a turn.
    cliBusy: true,
    // Set when a turn starts background work, moved to `heldForBackgroundWork`
    // by the next `result`: only work still outstanding holds a process open.
    backgroundWorkPending: false,
    // Set when the stream reports a task starting during the CLI's turn; the
    // task events then decide the hold (see noteCliTurnEnded).
    sawTaskEventThisTurn: false,
    heldForBackgroundWork: false,
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
  bindProcessCallbacks(proc, sdkOptions);

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
    console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
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
  proc.releaseInput = heldPrompt.release;

  console.log('Starting async generator loop for session:', providerSessionId || 'NEW');
  proc.ended = pumpProcess(proc);
  return proc;
}

/**
 * Retires every process no turn is running in, e.g. before tests end or the
 * server stops.
 * @returns {Promise<void>}
 */
function retireIdleClaudeProcesses() {
  return Promise.all([...activeSessions.values()]
    .filter((proc) => proc.status !== 'active')
    .map((proc) => retireProcess(proc))).then(() => {});
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
async function queryClaudeSDK(command, options = {}, ws, context) {
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
  let proc = null;
  // True while the client-facing turn is running and can take steering input.
  let acceptsSteering = false;
  // Steering written to stdin that the CLI has not taken up yet, by SDK uuid.
  // The CLI folds each into the running turn at its next tool boundary, or runs
  // it as a follow-up turn when none comes; its replay marks it consumed.
  const pendingSteerIds = new Set();
  let steerFollowUpTimer = null;
  // The client is told the turn is over as soon as `result` lands.
  let turnCompleteSent = false;
  // Set once a turn publishes a budget read from an assistant message, so the
  // turn-ending `result` is only mined for usage when nothing better arrived.
  let assistantBudgetSent = false;
  // The budget last published, re-sent with the right total when the turn's
  // `result` is the first to state the window it is measured against.
  let lastSentTokenBudget = null;
  // Rows a compaction kept, which the CLI streams a second time after it.
  const preservedByCompaction = new Set();
  // The managed catalog's window for the run's model, when there is one.
  let contextWindow;
  // Until the CLI takes up this turn's prompt, the turn it may already be
  // running (background work reporting back) is not this one: 'start' waits
  // for the next `system init`, 'replay' for the prompt's replay, and becomes
  // 'start' when the running turn ends without taking the prompt up.
  let awaitingPrompt = null;
  let promptUuid = null;
  let finishTurn;
  const turnDone = new Promise((resolve) => { finishTurn = resolve; });

  const steering = {
    canSteer: () => acceptsSteering,

    /**
     * Writes the input to the running CLI without interrupting it. Model,
     * effort and permissions stay those of the run.
     * @returns {Promise<{ clientMessageId: string }>} The uuid the transcript keeps
     */
    async steer(command, steerOptions = {}) {
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
        throw new AppError(`The steering input could not be prepared: ${error?.message || error}`, {
          code: 'STEER_UNAVAILABLE', statusCode: 409
        });
      }
      const uuid = crypto.randomUUID();
      pendingSteerIds.add(uuid);
      // 'next' folds the input into the running turn at its next tool boundary.
      if (!acceptsSteering || !proc?.push({ ...message, uuid, priority: 'next' })) {
        pendingSteerIds.delete(uuid);
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
    if (sessionKey() && abortedSessionIds.has(sessionKey())) {
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
    if (proc.turn === turn) {
      proc.turn = null;
      proc.status = 'idle';
      proc.lastActiveAt = Date.now();
      scheduleIdleProcess(proc);
    }
    finishTurn();
  };

  const reportFailure = async (error) => {
    console.error('SDK query error:', error);

    if (proc && supersededInstances.has(proc.instance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion still surfaces the error, but must not emit a
    // second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
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

  const turn = {
    steering,

    onMessage(message) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {
        capturedSessionId = message.session_id;
        proc.providerSessionId = capturedSessionId;
        if (!sessionId) {
          addSession(capturedSessionId, proc);
        }

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
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
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
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

    const signature = launchSignature(sdkOptions);
    const resident = sessionId ? getSession(sessionId) : undefined;
    if (sdkOptions.resume) {
      const owner = await findForeignSessionProcess(sdkOptions.resume);
      if (owner) {
        // Whatever the other process adds, this one would not know about.
        if (resident && resident.status !== 'active') {
          retireProcess(resident);
        }
        throw sessionOpenElsewhereError(owner);
      }
    }
    let reusable = Boolean(resident && resident.status === 'idle' && !resident.retired
      && !resident.retireAfterTurn && resident.signature === signature
      && sdkOptions.resume && !sdkOptions.resumeSessionAt
      && resident.providerSessionId === providerSessionId);
    // Claude Desktop or a terminal may have continued the session, and exited,
    // while the resident process sat idle with the conversation as it was.
    if (reusable && await isTranscriptContinuedElsewhere(providerSessionId, options.cwd)) {
      reusable = false;
    }

    if (reusable && resident.push(promptMessage)) {
      proc = resident;
      clearProcessTimer(proc);
      Object.assign(proc, {
        status: 'active', turn, writer: ws, sessionSummary, contextWindow,
        normalizeMessage: context.normalizeMessage, lastActiveAt: Date.now(),
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
        createQuery: context.createQuery,
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
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if a running turn was aborted, false if none was found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
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
function canSteerClaudeSDKSession(sessionId) {
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
async function steerClaudeSDKSession(sessionId, command, options = {}) {
  if (!canSteerClaudeSDKSession(sessionId)) {
    throw new AppError('This turn cannot be steered now. Keep the draft or queue it for the next turn.', {
      code: 'STEER_UNAVAILABLE', statusCode: 409
    });
  }
  return getSession(sessionId).turn.steering.steer(command, options);
}

/**
 * Sessions whose background tasks are still outstanding, with the tasks.
 *
 * A session stays here after its turn's `result` for as long as its process
 * is held for the work — which is exactly the window in which nothing else
 * (the chat run registry marks the run completed at `result`) knows the
 * session is still busy.
 * @returns {Array<{ sessionId: string, tasks: Array<import('@/shared/types.js').BackgroundTaskSummary> }>}
 */
function listClaudeSDKBackgroundWork() {
  return backgroundWork.list();
}

/**
 * Stops one outstanding background task through the SDK, which then emits a
 * `task_notification` with status `stopped` — the same event that drops the
 * task from the tracker and settles its card.
 * @param {string} sessionId - Session identifier
 * @param {string} taskId - The task's `task_id` as reported on `task_started`
 * @returns {Promise<boolean>} False when no live process is tracking the task
 */
async function stopClaudeSDKTask(sessionId, taskId) {
  const session = getSession(sessionId);
  if (!session || !backgroundWork.has(sessionId, taskId)) {
    return false;
  }
  await session.instance.stopTask(taskId);
  return true;
}

/**
 * Checks if a turn is running in a session's SDK process
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
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
function getClaudeSDKSessionStartTime(sessionId) {
  const session = getSession(sessionId);
  return session && !session.retired ? session.startedAt : null;
}

/**
 * Gets the ids of sessions with a turn running
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return [...activeSessions.entries()]
    .filter(([, session]) => session.status === 'active')
    .map(([sessionId]) => sessionId);
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
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
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  canSteer: canSteerClaudeSDKSession,
  steer: steerClaudeSDKSession,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
  listBackgroundWork: listClaudeSDKBackgroundWork,
  stopBackgroundTask: stopClaudeSDKTask,
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  stopClaudeSDKTask,
  isClaudeSDKSessionActive,
  getClaudeSDKSessionStartTime,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  retireIdleClaudeProcesses,
  extractTokenBudget,
  extractCumulativeTokenBudget
};
