import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { WebSocket } from 'ws';

import { sessionDraftsDb, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderAbortOptions,
  ProviderRuntimeObservation,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { AppError, createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';
import { generateMessageId, readObjectRecord } from '@/shared/index.js';
import type { QueuedSessionMessageRecord } from '@/shared/index.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/** Application boundary for dispatching provider runs and approvals. */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string, options?: ProviderAbortOptions): Promise<boolean>;
  canInterrupt?(provider: LLMProvider, sessionId: string): boolean;
  prepareObservation?(provider: LLMProvider, sessionId: string): Promise<ProviderRuntimeObservation | null>;
  canSteer?(provider: LLMProvider, sessionId: string): boolean;
  steer?(provider: LLMProvider, sessionId: string, command: string, options: AnyRecord): Promise<void>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.send');
  if (!resolved) {
    return;
  }

  await dispatchRun(ws, userId, resolved.sessionId, resolved.session, data, dependencies);
}

/**
 * Adds a correction to the existing run. Its acknowledgement is deliberately
 * separate from protocol_error: a refused steer must not stop the live UI or
 * discard the composer's draft, and must never fall back to chat.send/abort.
 */
async function handleChatSteer(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<void> {
  sendJson(ws, await performChatSteer(ws, userId, data, dependencies));
}

function queuedSnapshot(value: unknown) {
  const record = readObjectRecord(value);
  if (!record || typeof record.content !== 'string') return null;
  return {
    id: typeof record.id === 'string' ? record.id : null,
    content: record.content,
    options: readObjectRecord(record.options) ?? {},
    attachments: Array.isArray(record.attachments) ? record.attachments
      : Array.isArray(record.images) ? record.images : [],
    steerHold: record.steerHold ?? null,
  };
}

/**
 * User's authenticated queue endpoint uses the same ownership/run guards and
 * native steering as WebSocket clients, but requires an exact queued receipt.
 * HTTP 404 on older nodes is safe: it cannot accidentally steer while leaving
 * the original queue waiting to be dispatched.
 */
export async function steerQueuedChatMessage(
  userId: number,
  input: unknown,
  dependencies: ChatWebSocketDependencies,
): Promise<AnyRecord> {
  const data = readObjectRecord(input) ?? {};
  return performChatSteer(null, userId, { ...data, queuedMessage: data.queuedMessage ?? null }, dependencies);
}

async function performChatSteer(
  ws: WebSocket | null,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
): Promise<AnyRecord> {
  const sessionId = readRequiredSessionId(data);
  const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
  const result = { kind: 'chat_steer_result', sessionId, requestId };
  let queued: QueuedSessionMessageRecord | null = null;
  let claimed = false;
  try {
    if (!sessionId || !requestId || requestId.length > 128) {
      throw new AppError('chat.steer requires a sessionId and requestId.', {
        code: 'INVALID_STEER_REQUEST', statusCode: 400,
      });
    }
    const session = sessionsDb.getSessionById(sessionId);
    const run = chatRunRegistry.getRun(sessionId);
    if (!session || !run || run.status !== 'running') {
      throw new AppError('The turn has already ended. Your draft was not sent; send it as a new message if needed.', {
        code: 'NO_ACTIVE_RUN', statusCode: 409,
      });
    }
    if (String(run.writer.userId ?? '') !== String(userId ?? '')) {
      throw new AppError('You cannot steer a run owned by another user.', {
        code: 'STEER_FORBIDDEN', statusCode: 403,
      });
    }
    if (data.expectedRunId !== run.id) {
      throw new AppError('The running turn changed while you were composing or uploading. Your draft was not sent; review the current turn before retrying.', {
        code: 'STEER_STALE_RUN', statusCode: 409,
      });
    }
    if (!dependencies.runtime.steer || !dependencies.runtime.canSteer?.(run.provider, sessionId)) {
      throw new AppError('This run does not support steering now. Keep the draft or queue it for the next turn.', {
        code: 'STEER_UNAVAILABLE', statusCode: 409,
      });
    }
    let command = typeof data.content === 'string' ? data.content : '';
    const options = data.options && typeof data.options === 'object' ? data.options : {};
    let attachmentInput = options.attachments;
    if (Object.hasOwn(data, 'queuedMessage')) {
      const expected = queuedSnapshot(data.queuedMessage);
      if (!expected || !Number.isSafeInteger(Number(userId)) || Number(userId) < 1) {
        throw new AppError('A queued steering request requires a valid owner and queued message.', {
          code: 'INVALID_STEER_REQUEST', statusCode: 400,
        });
      }
      queued = sessionDraftsDb.getQueuedMessage(Number(userId), sessionId);
      const stored = queuedSnapshot(queued?.queuedMessage);
      if (!queued || !stored || !isDeepStrictEqual(stored, expected)) {
        throw new AppError('This queued message changed or was already sent. The current queue was not modified.', {
          code: 'STEER_QUEUE_CHANGED', statusCode: 409,
        });
      }
      if (stored.steerHold) {
        throw new AppError('Check the previous delivery before editing and submitting this message again.', {
          code: 'STEER_REVIEW_REQUIRED', statusCode: 409,
        });
      }
      command = stored.content;
      attachmentInput = stored.attachments;
    }
    const attachments = filterAttachmentsToUploadStore(attachmentInput).filter(
      (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
    );
    if (!command.trim() && attachments.length === 0) {
      throw new AppError('A steering message must contain text or an uploaded attachment.', {
        code: 'STEER_EMPTY', statusCode: 400,
      });
    }
    const images = attachments.filter(isImageAttachmentDescriptor);
    const files = attachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor));
    // Subscribe the requester, but keep the same run, writer, event sequence,
    // model and permissions. Only validated attachment inputs reach the runtime.
    if (ws) chatRunRegistry.attachConnection(sessionId, ws);
    if (queued) {
      claimed = sessionDraftsDb.claimQueuedMessage(queued);
      if (!claimed) {
        throw new AppError('This queued message changed or was already sent.', {
          code: 'STEER_QUEUE_CHANGED', statusCode: 409,
        });
      }
    }
    // Distinct from the HTTP/WebSocket request id: every native submission has
    // its own persisted identity, including intentionally repeated text.
    const clientMessageId = generateMessageId('codey_user');
    await dependencies.runtime.steer(run.provider, sessionId, command, { images, files, clientMessageId });
    // The daemon owns persistence. This accepted echo goes to every watching
    // Codey tab and is replayable without a duplicate optimistic client row.
    try {
      run.writer.send(createNormalizedMessage({
        id: `steer_${requestId}`, provider: run.provider, sessionId,
        kind: 'text', role: 'user', content: command, images, files, clientMessageId,
      }));
    } catch (error) {
      // Acceptance already happened. A broken observer must not turn this
      // into a refusal that invites resubmitting the same instruction.
      console.warn('[Chat] Accepted steering input could not be echoed:', error instanceof Error ? error.message : String(error));
    }
    if (queued) {
      try {
        sessionDraftsDb.deleteEmptyDraft(queued.userId, queued.sessionId);
      } catch {
        // Native acceptance already happened; housekeeping must not invite a duplicate retry.
        console.warn('[Chat] Could not clean up the empty queued-message row after acceptance.');
      }
    }
    return { ...result, accepted: true };
  } catch (error) {
    let queueRestored: boolean | undefined;
    let queueHeld: boolean | undefined;
    if (claimed && queued) {
      const refused = error instanceof AppError
        && ['STEER_UNAVAILABLE', 'CODEX_DAEMON_RPC_ERROR'].includes(error.code);
      queueHeld = !refused;
      const replacement = refused ? queued : {
        ...queued,
        claimToken: JSON.stringify({ ...readObjectRecord(queued.queuedMessage), steerHold: 'unconfirmed' }),
      };
      // An uncertain native acknowledgement must never become an automatic
      // second send. Keep it visible for review, without overwriting a newer queue.
      try {
        queueRestored = sessionDraftsDb.restoreQueuedMessage(replacement);
      } catch {
        queueRestored = false;
        queueHeld = true;
        console.error('[Chat] Could not restore the queued message after a failed native append.');
      }
    }
    return {
      ...result, accepted: false,
      code: error instanceof AppError ? error.code : 'STEER_FAILED',
      error: error instanceof Error ? error.message : String(error),
      queueRestored, queueHeld,
    };
  }
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return null;
  }

  return { sessionId, session, provider };
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 */
async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>) => void | Promise<void>,
): Promise<{ started: boolean; error: string | null }> {
  const provider = session.provider as LLMProvider;

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
  });

  if (!run) {
    if (ws) {
      sendProtocolError(
        ws,
        'RUN_IN_PROGRESS',
        `Session "${sessionId}" already has a run in progress.`,
        sessionId
      );
    }
    return { started: false, error: 'A run is already in progress for this session.' };
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = typeof data.content === 'string' ? data.content : '';

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    ...extraRuntimeOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    // Only the top-level send receipt reaches native input metadata. Do not
    // trust a same-named field hidden inside arbitrary execution options.
    clientMessageId: typeof data.clientMessageId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.clientMessageId)
      ? data.clientMessageId : undefined,
    sessionId,
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
  };

  let failure: string | null = null;
  try {
    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run);
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }

  return { started: true, error: failure };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  const rewinds = sessionsService.providerRewindsForEdit(sessionId);

  await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(sessionId, resumeThroughId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      }
    },
  );
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  try {
    if (String(run.writer.userId ?? '') !== String(userId ?? '')) {
      throw new AppError('You cannot stop a run owned by another user.', { code: 'ABORT_FORBIDDEN', statusCode: 403 });
    }
    if (data.expectedRunId !== undefined && data.expectedRunId !== run.id) {
      throw new AppError('The running turn changed. Review the current session before stopping it.', {
        code: 'ABORT_STALE_RUN', statusCode: 409,
      });
    }
    const success = await dependencies.runtime.abort(run.provider, sessionId, {
      allowExternalTurn: data.expectedRunId === run.id,
    });
    if (!success) {
      throw new AppError('The provider has not confirmed stopping this turn. Its running state has been preserved.', {
        code: 'ABORT_UNCONFIRMED', statusCode: 409,
      });
    }
    // A late Stop acknowledgement must only finish THIS run, not a successor.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 0, aborted: true });
  } catch (error) {
    // A refusal/timeout is not a completion signal and must not flush the queue.
    sendJson(ws, {
      kind: 'chat_abort_result', sessionId, accepted: false,
      code: error instanceof AppError ? error.code : 'ABORT_FAILED',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Coalesces concurrent phone/tab subscriptions without reserving an idle
// session while its native status is being probed.
const pendingObservations = new Map<string, Promise<void>>();

async function attachExternalRun(
  sessionId: string, userId: string | number | null, dependencies: ChatWebSocketDependencies,
): Promise<void> {
  if (!dependencies.runtime.prepareObservation || chatRunRegistry.isProcessing(sessionId)) return;
  const pending = pendingObservations.get(sessionId);
  if (pending) return pending;
  const attaching = (async () => {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) return;
    const observation = await dependencies.runtime.prepareObservation!(session.provider as LLMProvider, sessionId);
    if (!observation) return;
    const run = chatRunRegistry.startRun({
      appSessionId: sessionId, provider: session.provider as LLMProvider,
      providerSessionId: session.provider_session_id, connection: null, userId,
    });
    if (!run) {
      await observation.dispose();
      return;
    }
    // Keep following after the phone disconnects, so its durable queue waits
    // for the actual native completion rather than a browser lifecycle event.
    void observation.start(run.writer)
      .catch((error: unknown) => console.warn('[Chat] Desktop observation ended:', error instanceof Error ? error.message : String(error)))
      .finally(() => chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 }));
  })();
  pendingObservations.set(sessionId, attaching);
  try {
    await attaching;
  } finally {
    if (pendingObservations.get(sessionId) === attaching) pendingObservations.delete(sessionId);
  }
}

/**
 * Handles `chat.subscribe`: joins a verified external turn when needed,
 * reports capabilities, replays missed events and restores pending approvals.
 * No prompt is required to expose queue/steer/Stop after changing devices.
 */
async function handleChatSubscribe(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }
    try {
      await attachExternalRun(sessionId, userId, dependencies);
    } catch (error) {
      console.warn('[Chat] Could not observe native activity:', error instanceof Error ? error.message : String(error));
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);
    const canSteer = isProcessing && Boolean(run && dependencies.runtime.canSteer?.(run.provider, sessionId));

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      canInterrupt: isProcessing && Boolean(run && (dependencies.runtime.canInterrupt?.(run.provider, sessionId) ?? true)),
      canSteer,
      canSteerQueued: canSteer,
      runId: isProcessing ? run?.id : undefined,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, lastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.steer`               { sessionId, requestId, expectedRunId, content, options?: { attachments } }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `chat_steer_result`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
/**
 * Runs a turn for a session with no client attached.
 *
 * Used by scheduled messages, which fire from a timer: there is no socket to
 * report errors to and no audience to stream to. The run is registered exactly
 * like an interactive one, so anyone who opens the session while it is going
 * subscribes and replays it from the start, and the session shows as busy
 * everywhere in the meantime.
 *
 * Resolves when the provider run settles. Returns false when the session has
 * gone away or is busy without `interruptActiveRun`, which the caller reports
 * on the schedule.
 */
export async function runDetachedChatTurn(
  input: {
    sessionId: string;
    userId: string | number | null;
    content: string;
    options?: AnyRecord;
    /**
     * Aborts a run already in progress instead of refusing to start. A
     * scheduled message sets this: the user picked the time knowing it might
     * land mid-run, so the timer outranks whatever is running.
     */
    interruptActiveRun?: boolean;
  },
  dependencies: ChatWebSocketDependencies,
): Promise<{ started: boolean; error: string | null }> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    return { started: false, error: 'The session no longer exists.' };
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    return { started: false, error: `Provider "${provider}" is not available.` };
  }

  const activeRun = chatRunRegistry.getRun(input.sessionId);
  if (activeRun && activeRun.status === 'running') {
    if (!input.interruptActiveRun) {
      return { started: false, error: 'A run was already in progress for this session.' };
    }
    // Same shape as `chat.abort`: cancel the provider run and emit the
    // terminal `complete` on its behalf, so every watching client sees the
    // interrupted run end before this turn's stream begins. The interrupted
    // run's own dispatch settles later through completeRunIfCurrent, which is
    // scoped to that run and cannot touch the one started here.
    const aborted = await dependencies.runtime.abort(activeRun.provider, input.sessionId);
    chatRunRegistry.completeRun(input.sessionId, {
      exitCode: aborted ? 0 : 1,
      aborted: true,
    });
  }

  return dispatchRun(
    null,
    input.userId,
    input.sessionId,
    session,
    { sessionId: input.sessionId, content: input.content, options: input.options ?? {} },
    dependencies,
  );
}

export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.steer':
          await handleChatSteer(ws, userId, data, dependencies);
          return;
        case 'chat.edit-send':
          await handleChatEditSend(ws, userId, data, dependencies);
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, userId, data, dependencies);
          return;
        case 'chat.subscribe':
          await handleChatSubscribe(ws, userId, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
