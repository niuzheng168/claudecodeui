import { sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import {
  findForeignSessionProcess,
  providerCapabilitiesService,
  providerModelsService,
  readLastPermissionMode,
} from '@/modules/providers/index.js';
import {
  crossSessionMessage,
  senderModeFor,
  sendToClaudeProcess,
} from '@/modules/session-messages/services/claude-peer-message.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/index.js';

/**
 * Delivers a message one agent sent to another session: the agent in that
 * session receives it as a new turn, the way it would receive the user's.
 * The Portal calls this through `POST /api/codey/session-messages` once it
 * has checked that the sender may reach this node (codey/src/session-messages.mjs).
 *
 * - An idle session starts a turn at once, through the same detached path a
 *   scheduled message takes; its open tabs pick the run up and show it live.
 * - A busy session (a turn running, or background work it still waits for)
 *   gets the message at the end of its queue, the composer's own FIFO; the
 *   dispatcher sends it once the session is idle.
 * - A Claude session that Claude Desktop or a terminal `claude` holds open
 *   cannot take a turn from Codey (it would fork the transcript), so the
 *   message goes to that process instead, as a message from another session.
 */

const TAG = 'codey-session-message';
const ADDRESS = /^codey:\/\/(n-[a-f0-9]{24})\/([A-Za-z0-9._:-]{1,160})$/;
// Long enough for a provider to refuse a turn it cannot start (an unknown
// model, a session another process holds); a turn that has really started
// is reported as started without waiting for it.
const START_WATCH_MS = 2_000;
const START_POLL_MS = 100;

export type SessionMessageInput = {
  /** CloudCLI's session id, or the provider's own (what a sender knows about itself). */
  sessionId: string;
  message: string;
  messageId: string;
  from: {
    /** `codey://<node>/<session>`, or null when the sender's session could not be identified. */
    address: string | null;
    machine: string;
    provider: string | null;
  };
};

export type SessionMessageResult = {
  status: 'started' | 'queued' | 'delivered';
  sessionId: string;
  provider: string;
  title: string | null;
};

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', opencode: 'OpenCode' };

function attribute(value: string): string {
  return value.replace(/["<>\r\n]/g, '').slice(0, 120);
}

/** What the receiving agent reads: who sent it, the message, and how to answer. */
export function sessionMessageContent(input: SessionMessageInput): string {
  const from = input.from.address ?? 'unknown';
  const agent = input.from.provider ? PROVIDER_NAMES[input.from.provider] ?? input.from.provider : null;
  const attributes = [`from="${attribute(from)}"`, `machine="${attribute(input.from.machine)}"`];
  if (agent) attributes.push(`agent="${attribute(agent)}"`);
  const body = input.message.replace(new RegExp(`</${TAG}`, 'gi'), `<\\/${TAG}`);
  const reply = input.from.address
    ? `To reply, call the Codey send_message tool with to="${input.from.address}".`
    : 'It carries no reply address.';
  return `<${TAG} ${attributes.join(' ')}>\n${body}\n</${TAG}>\n`
    + `The agent in another Codey session sent this; your user did not type it. ${reply}`;
}

function sessionTitle(session: { custom_name: string | null }): string | null {
  const title = session.custom_name?.trim();
  return title ? title.slice(0, 200) : null;
}

function findSession(sessionId: string) {
  return sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
}

/**
 * The options a turn this message starts runs with: the model and effort the
 * composer would send for this session, including one Codey never ran (a
 * managed node only runs a model it can name).
 */
async function turnOptions(provider: LLMProvider, sessionId: string): Promise<Record<string, unknown>> {
  const options: Record<string, unknown> = {};
  try {
    const selection = await providerModelsService.resolveSessionModel(provider, { sessionId });
    if (selection.model) options.model = selection.model;
    if (selection.effort) options.effort = selection.effort;
  } catch {
    // The runtime reports a model it cannot run when the turn starts.
  }
  // A Claude turn left on `default` stalls on its first tool call when nobody
  // is watching; the managed default is what the composer would send.
  if (provider === 'claude') {
    options.permissionMode = providerCapabilitiesService.getProviderCapabilities('claude').defaultPermissionMode;
  }
  return options;
}

function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork?.(sessionId) === true;
}

function queueMessage(userId: number, sessionId: string, input: SessionMessageInput, content: string, options: Record<string, unknown>): void {
  sessionDraftsDb.appendQueuedMessage(userId, sessionId, { id: input.messageId, content, options, attachments: [] });
}

/** Errors a run reported before it got going, or null while it runs or once it finished cleanly. */
async function watchStart(sessionId: string, startedAt: number): Promise<string | null> {
  const deadline = Date.now() + START_WATCH_MS;
  while (Date.now() < deadline) {
    const run = chatRunRegistry.getRun(sessionId);
    if (run && run.startedAt >= startedAt) {
      const failure = run.events.find((event) => event.kind === 'error');
      if (failure) return typeof failure.content === 'string' && failure.content ? failure.content : 'The turn failed to start.';
      if (run.status !== 'running') return null;
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
  return null;
}

export async function deliverSessionMessage(
  input: SessionMessageInput,
  { userId, runtime, nodeId }: { userId: number; runtime: ProviderRuntimeGateway; nodeId: string },
): Promise<SessionMessageResult> {
  const session = findSession(input.sessionId);
  if (!session) {
    throw new AppError('No such session on this machine.', { code: 'SESSION_MESSAGE_NO_SESSION', statusCode: 404 });
  }
  const sessionId = session.session_id;
  const provider = session.provider as LLMProvider;
  const providerSessionId = session.provider_session_id ?? sessionId;
  const result = { sessionId, provider, title: sessionTitle(session) };
  const self = new Set([`codey://${nodeId}/${sessionId}`, `codey://${nodeId}/${providerSessionId}`]);
  if (input.from.address && self.has(input.from.address)) {
    throw new AppError('A session cannot send a message to itself.', { code: 'SESSION_MESSAGE_SELF', statusCode: 400 });
  }
  if (!runtime.hasRuntime(provider)) {
    throw new AppError(`This machine cannot run ${provider} sessions.`, { code: 'SESSION_MESSAGE_UNDELIVERABLE', statusCode: 409 });
  }

  if (provider === 'claude') {
    const holder = await findForeignSessionProcess(providerSessionId);
    if (holder) {
      if (!holder.messagingSocketPath) {
        throw new AppError(`This Claude session is open in ${holder.entrypoint} (pid ${holder.pid}), which does not take messages from other sessions. Send it once that process has exited.`, {
          code: 'SESSION_MESSAGE_UNDELIVERABLE', statusCode: 409,
        });
      }
      const mode = senderModeFor(await readLastPermissionMode(providerSessionId, holder.cwd ?? session.project_path));
      await sendToClaudeProcess({
        pid: holder.pid,
        socketPath: holder.messagingSocketPath,
        providerSessionId,
        from: input.from.address ?? `codey://${nodeId}/unknown`,
        content: crossSessionMessage({
          from: input.from.address ?? `codey://${nodeId}/unknown`,
          name: `Codey ${input.from.machine}`,
          mode,
          body: input.from.address
            ? `${input.message}\n\n(Sent from a Codey session. SendMessage cannot reach it; to reply, call the Codey send_message tool with to="${input.from.address}".)`
            : input.message,
        }),
      });
      return { ...result, status: 'delivered' };
    }
  }

  const content = sessionMessageContent(input);
  const options = await turnOptions(provider, sessionId);
  if (isSessionBusy(sessionId, runtime)) {
    queueMessage(userId, sessionId, input, content, options);
    return { ...result, status: 'queued' };
  }

  const startedAt = Date.now();
  const outcome: { refused: string | null } = { refused: null };
  const run = runDetachedChatTurn({ sessionId, userId, content, options }, { runtime })
    .then((value) => { if (!value.started) outcome.refused = value.error; })
    .catch((error: unknown) => { outcome.refused = error instanceof Error ? error.message : String(error); });
  // A refusal is settled synchronously enough to be seen right away; only a
  // started run is left to finish on its own.
  await Promise.race([run, new Promise((resolve) => setTimeout(resolve, START_POLL_MS))]);
  if (outcome.refused === 'A run was already in progress for this session.') {
    queueMessage(userId, sessionId, input, content, options);
    return { ...result, status: 'queued' };
  }
  if (outcome.refused) {
    throw new AppError(outcome.refused, { code: 'SESSION_MESSAGE_UNDELIVERABLE', statusCode: 409 });
  }
  const failure = await watchStart(sessionId, startedAt);
  if (failure) {
    throw new AppError(failure, { code: 'SESSION_MESSAGE_UNDELIVERABLE', statusCode: 409 });
  }
  return { ...result, status: 'started' };
}

export function parseSessionAddress(value: unknown): { nodeId: string; sessionId: string } | null {
  const match = typeof value === 'string' ? ADDRESS.exec(value) : null;
  return match ? { nodeId: match[1], sessionId: match[2] } : null;
}
