import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { ChatRunOrigin, ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { AppError, readObjectRecord } from '@/shared/index.js';

/**
 * What the Portal reads and does for another user who watches a session
 * shared with them (codey/docs/codey-shared-sessions.md §4): the session's
 * run as pages of its live events, and stopping or answering a run that one
 * of that user's messages started. The Portal checks the message is theirs;
 * this checks the run is the one that message started.
 */

/** Events per read; the reader asks again while `more` is set. */
const MAX_LIVE_EVENTS = 500;
/**
 * And their size per read, well under the 16 MB the Portal reads (codey
 * src/message-service.mjs): a page it cannot read would be the same page on
 * every poll. A single larger event still goes, on a page of its own.
 */
const MAX_LIVE_EVENT_BYTES = 8 * 1024 * 1024;

/** How many of `events` fit in one read. */
function eventsWithinBudget(events: unknown[]): number {
  let bytes = 0;
  for (let index = 0; index < events.length; index += 1) {
    bytes += Buffer.byteLength(JSON.stringify(events[index]) ?? '');
    if (bytes > MAX_LIVE_EVENT_BYTES && index > 0) return index;
  }
  return events.length;
}

export type SessionLivePermission = {
  requestId: string;
  toolName: string;
  input: unknown;
  receivedAt: number | null;
};

export type SessionLive = {
  sessionId: string;
  provider: string;
  run: {
    id: string;
    status: 'running' | 'completed';
    startedAt: number;
    completedAt: number | null;
    outcome: 'completed' | 'failed' | 'interrupted' | null;
    lastSeq: number;
    canInterrupt: boolean;
    origin: ChatRunOrigin | null;
  } | null;
  events: unknown[];
  reset: boolean;
  more: boolean;
  background: boolean;
  pendingPermissions: SessionLivePermission[];
};

/** Only CloudCLI's own session ID: the Portal records that one for a grant. */
function findSession(sessionId: string) {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    throw new AppError('No such session on this machine.', { code: 'SESSION_MESSAGE_NO_SESSION', statusCode: 404 });
  }
  return session;
}

/** When a request arrived, in epoch milliseconds; the runtimes keep a Date. */
function epochMs(value: unknown): number | null {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  return typeof time === 'number' && Number.isFinite(time) ? time : null;
}

function pendingPermissions(sessionId: string, runtime: ProviderRuntimeGateway): SessionLivePermission[] {
  return runtime.getPendingApprovalsForSession(sessionId).flatMap((value) => {
    const request = readObjectRecord(value);
    if (!request || typeof request.requestId !== 'string' || !request.requestId) return [];
    return [{
      requestId: request.requestId,
      toolName: typeof request.toolName === 'string' ? request.toolName : 'UnknownTool',
      input: request.input ?? null,
      receivedAt: epochMs(request.receivedAt),
    }];
  });
}

/**
 * The session's current or recently finished run and its events after
 * `afterSeq` — from the run's start when `runId` names an earlier run or none.
 */
export function readSessionLive(
  sessionId: string,
  { afterSeq, runId }: { afterSeq: number; runId: string | null },
  runtime: ProviderRuntimeGateway,
): SessionLive {
  const session = findSession(sessionId);
  const run = chatRunRegistry.getRun(session.session_id) ?? null;
  const page = run
    ? chatRunRegistry.readEvents(session.session_id, run.id === runId ? afterSeq : 0, MAX_LIVE_EVENTS)
    : { events: [], more: false, reset: false };
  const fits = eventsWithinBudget(page.events);
  return {
    sessionId: session.session_id,
    provider: session.provider,
    run: run && {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      outcome: run.outcome,
      lastSeq: run.lastSeq,
      // As `chat_subscribed` reports it: a run can be stopped unless its runtime says otherwise.
      canInterrupt: run.status === 'running' && (runtime.canInterrupt?.(run.provider, session.session_id) ?? true),
      origin: run.origin,
    },
    events: page.events.slice(0, fits),
    reset: page.reset,
    more: page.more || fits < page.events.length,
    background: runtime.hasBackgroundWork?.(session.session_id) === true,
    pendingPermissions: pendingPermissions(session.session_id, runtime),
  };
}

/** The session's running run, if it is `runId` and message `messageId` started it. */
function messageRun(sessionId: string, runId: string, messageId: string) {
  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    throw new AppError(`Session "${sessionId}" has no active run.`, { code: 'NO_ACTIVE_RUN', statusCode: 409 });
  }
  if (run.id !== runId) {
    throw new AppError('The running turn changed. Review the current session first.', { code: 'ABORT_STALE_RUN', statusCode: 409 });
  }
  if (run.origin?.messageId !== messageId) {
    throw new AppError('This turn was not started by that message.', { code: 'ABORT_FORBIDDEN', statusCode: 403 });
  }
  return run;
}

/** Stops run `runId` the way `chat.abort` does, when message `messageId` started it. */
export async function abortSessionRun(
  sessionId: string,
  { runId, messageId }: { runId: string; messageId: string },
  runtime: ProviderRuntimeGateway,
): Promise<{ stopped: true }> {
  const session = findSession(sessionId);
  const run = messageRun(session.session_id, runId, messageId);
  // Only the turn Codey started for the message, never one Claude Desktop or
  // the Codex app is running in the same session.
  const stopped = await runtime.abort(run.provider, session.session_id, { allowExternalTurn: false });
  if (!stopped) {
    throw new AppError('The provider has not confirmed stopping this turn. Its running state has been preserved.', {
      code: 'ABORT_UNCONFIRMED', statusCode: 409,
    });
  }
  // A late Stop acknowledgement must only finish THIS run, not a successor.
  chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
  return { stopped: true };
}

/**
 * Answers one waiting approval of run `runId`, when message `messageId`
 * started it. Never remembers the answer for later calls, and edits only an
 * AskUserQuestion's input (its answers): edited input for any other tool
 * would approve something other than what was asked.
 */
export function answerSessionPermission(
  sessionId: string,
  requestId: string,
  decision: { runId: string; messageId: string; allow: boolean; updatedInput?: Record<string, unknown>; message?: string },
  runtime: ProviderRuntimeGateway,
): { resolved: true } {
  const session = findSession(sessionId);
  messageRun(session.session_id, decision.runId, decision.messageId);
  const pending = pendingPermissions(session.session_id, runtime).find((request) => request.requestId === requestId);
  if (!pending) {
    throw new AppError('This session has no such request waiting.', { code: 'PERMISSION_NOT_PENDING', statusCode: 404 });
  }
  if (decision.updatedInput !== undefined && pending.toolName !== 'AskUserQuestion') {
    throw new AppError('Only an AskUserQuestion answer can change the input.', { code: 'SESSION_LIVE_INVALID', statusCode: 400 });
  }
  runtime.resolveToolApproval(requestId, {
    allow: decision.allow,
    ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}),
    ...(decision.message !== undefined ? { message: decision.message } : {}),
  });
  return { resolved: true };
}
