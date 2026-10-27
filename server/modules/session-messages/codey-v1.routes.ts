import express from 'express';
import type { Request, Response } from 'express';

import { codeyInboundMessagesDb, sessionsDb } from '@/modules/database/index.js';
import { applyClaudeArchiveChanges } from '@/modules/providers/index.js';
import { deliverSessionMessage } from '@/modules/session-messages/services/session-message-delivery.service.js';
import type { SessionMessageResult } from '@/modules/session-messages/services/session-message-delivery.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

/** The internal API version the Portal checks before using these routes. */
export const CODEY_NODE_CONTRACT = 1;
const MAX_TEXT_CHARS = 32_000;
const MAX_ARCHIVE_SESSIONS = 100;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const ADDRESS = /^codey:\/\/n-[a-f0-9]{24}\/[A-Za-z0-9._:-]{1,160}$/;
const PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini', 'opencode']);
const STATUS: Record<SessionMessageResult['status'], string> = { started: 'started', queued: 'queued', delivered: 'handed_off' };

function invalid(message: string): AppError {
  return new AppError(message, { code: 'SESSION_MESSAGE_INVALID', statusCode: 400 });
}

function optionalText(value: unknown, name: string, pattern?: RegExp): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || (pattern && !pattern.test(value))) {
    throw invalid(`${name} is invalid.`);
  }
  return value.trim();
}

/**
 * `/api/codey/v1`: what the Portal calls on this machine for its session
 * messages API (codey/docs/codey-api-v1.md). Only the Portal reaches it, with
 * the same signed assertion as any proxied request.
 */
export function createCodeyV1Routes({ runtime, environment = process.env }: {
  runtime: ProviderRuntimeGateway;
  environment?: NodeJS.ProcessEnv;
}) {
  const router = express.Router();

  router.get('/info', (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({ contract: CODEY_NODE_CONTRACT, features: ['messages', 'sessions', 'session-archive'] }));
  });

  /**
   * Archives or restores Claude sessions by Claude Code's session ID, for an
   * archive Claude Desktop made on another of the owner's machines that runs
   * them here over SSH. Says which ones this machine lists, which tells the
   * Portal the change has reached the session.
   */
  router.post(
    '/sessions/archive',
    asyncHandler(async (req: Request, res: Response) => {
      const invalidArchive = (message: string) => new AppError(message, { code: 'SESSION_ARCHIVE_INVALID', statusCode: 400 });
      const sessions = ((req.body ?? {}) as Record<string, unknown>).sessions;
      if (!Array.isArray(sessions) || !sessions.length || sessions.length > MAX_ARCHIVE_SESSIONS) {
        throw invalidArchive(`sessions must list 1–${MAX_ARCHIVE_SESSIONS} sessions.`);
      }
      const changes = sessions.map((value) => {
        const entry = (value ?? {}) as Record<string, unknown>;
        if (entry.provider !== 'claude') throw invalidArchive('Only Claude sessions can be archived this way.');
        if (typeof entry.sessionId !== 'string' || !SESSION_ID.test(entry.sessionId)) throw invalidArchive('sessionId is invalid.');
        if (typeof entry.archived !== 'boolean') throw invalidArchive('archived must be true or false.');
        const lastActivityAt = entry.lastActivityAt === undefined ? null : Date.parse(String(entry.lastActivityAt));
        if (lastActivityAt !== null && !Number.isFinite(lastActivityAt)) throw invalidArchive('lastActivityAt is invalid.');
        return { providerSessionId: entry.sessionId, archived: entry.archived, lastActivityAt };
      });
      const result = await applyClaudeArchiveChanges(changes);
      res.json(createApiSuccessResponse({
        sessions: result.sessions.map(({ providerSessionId, sessionId }) => ({
          provider: 'claude', sessionId: providerSessionId, listed: sessionId !== null,
        })),
      }));
    }),
  );

  /** A session by its CloudCLI or provider session ID, as the Portal records it for a grant. */
  router.get('/sessions/:sessionId', (req: Request, res: Response) => {
    const id = String(req.params.sessionId ?? '');
    if (!SESSION_ID.test(id)) throw invalid('sessionId is invalid.');
    const session = sessionsDb.getSessionById(id) ?? sessionsDb.getSessionByProviderSessionId(id);
    if (!session) throw new AppError('No such session on this machine.', { code: 'SESSION_MESSAGE_NO_SESSION', statusCode: 404 });
    res.json(createApiSuccessResponse({
      sessionId: session.session_id,
      providerSessionId: session.provider_session_id ?? null,
      provider: session.provider,
      title: session.custom_name?.trim() ? session.custom_name.trim().slice(0, 200) : null,
    }));
  });

  /** Delivers a message once per message ID; a repeated request gets the first result. */
  router.post(
    '/messages',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = Number((req as AuthenticatedRequest).user?.id);
      const nodeId = environment.CODEY_PORTAL_NODE_ID ?? '';
      if (!Number.isInteger(userId) || !nodeId) {
        throw new AppError('Session messages need a Codey-managed node.', { code: 'SESSION_MESSAGE_UNAVAILABLE', statusCode: 403 });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const from = (body.from ?? {}) as Record<string, unknown>;
      if (typeof body.messageId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.messageId)) throw invalid('messageId is invalid.');
      if (typeof body.sessionId !== 'string' || !SESSION_ID.test(body.sessionId)) throw invalid('sessionId is invalid.');
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_TEXT_CHARS) {
        throw invalid(`text must be 1–${MAX_TEXT_CHARS} characters.`);
      }
      if (!from || typeof from !== 'object' || Array.isArray(from)) throw invalid('from is invalid.');
      const relation = body.relation ?? 'owner';
      if (relation !== 'owner' && relation !== 'other_user') throw invalid('relation is invalid.');
      if (body.approved !== undefined && typeof body.approved !== 'boolean') throw invalid('approved is invalid.');
      if (body.reply !== undefined && typeof body.reply !== 'boolean') throw invalid('reply is invalid.');
      const provider = optionalText(from.provider, 'from.provider');
      if (provider && !PROVIDERS.has(provider)) throw invalid('from.provider is invalid.');
      const input = {
        sessionId: body.sessionId,
        message: body.text,
        messageId: body.messageId,
        from: {
          address: optionalText(from.address, 'from.address', ADDRESS),
          machine: optionalText(from.machine, 'from.machine'),
          provider,
          user: optionalText(from.user, 'from.user'),
        },
        relation,
        approved: body.approved === true,
        reply: body.reply === true,
      } as const;

      const claim = codeyInboundMessagesDb.claim(input.messageId, input.sessionId);
      if (claim.state === 'done') {
        res.json(createApiSuccessResponse(claim.result));
        return;
      }
      if (claim.state === 'in_progress') {
        throw new AppError('This message is being delivered.', { code: 'SESSION_MESSAGE_IN_PROGRESS', statusCode: 409 });
      }
      if (claim.state === 'unconfirmed') {
        throw new AppError('This machine stopped while delivering this message; it may or may not have reached the session.', {
          code: 'SESSION_MESSAGE_UNCONFIRMED', statusCode: 409,
        });
      }
      let result: SessionMessageResult;
      try {
        result = await deliverSessionMessage(input, { userId, runtime, nodeId });
      } catch (error) {
        codeyInboundMessagesDb.release(input.messageId);
        throw error;
      }
      const reported = { ...result, status: STATUS[result.status] };
      codeyInboundMessagesDb.complete(input.messageId, reported);
      res.json(createApiSuccessResponse(reported));
    }),
  );
  return router;
}
