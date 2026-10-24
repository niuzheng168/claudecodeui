import express from 'express';
import type { Request, Response } from 'express';

import {
  deliverSessionMessage,
  parseSessionAddress,
} from '@/modules/session-messages/services/session-message-delivery.service.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

const MAX_MESSAGE_CHARS = 32_000;
const PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini', 'opencode']);

function invalid(message: string): AppError {
  return new AppError(message, { code: 'SESSION_MESSAGE_INVALID', statusCode: 400 });
}

/**
 * `POST /api/codey/session-messages`: the Portal hands over a message one of
 * the owner's sessions sent to a session on this machine. Only the Portal
 * reaches it, with the same signed assertion as any proxied request; the
 * Portal has already checked the sender (codey/src/session-messages.mjs).
 */
export function createSessionMessagesRoutes({ runtime, environment = process.env }: {
  runtime: ProviderRuntimeGateway;
  environment?: NodeJS.ProcessEnv;
}) {
  const router = express.Router();
  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = Number((req as AuthenticatedRequest).user?.id);
      const nodeId = environment.CODEY_PORTAL_NODE_ID ?? '';
      if (!Number.isInteger(userId) || !nodeId) {
        throw new AppError('Session messages need a Codey-managed node.', { code: 'SESSION_MESSAGE_UNAVAILABLE', statusCode: 403 });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const from = (body.from ?? {}) as Record<string, unknown>;
      if (typeof body.sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.sessionId)) throw invalid('sessionId is invalid.');
      if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > MAX_MESSAGE_CHARS) {
        throw invalid(`message must be 1–${MAX_MESSAGE_CHARS} characters.`);
      }
      if (typeof body.messageId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.messageId)) throw invalid('messageId is invalid.');
      const address = from.address === null || from.address === undefined ? null : from.address;
      if (address !== null && !parseSessionAddress(address)) throw invalid('from.address is invalid.');
      if (typeof from.machine !== 'string' || !from.machine.trim() || from.machine.length > 120) throw invalid('from.machine is invalid.');
      const provider = from.provider === null || from.provider === undefined ? null : from.provider;
      if (provider !== null && (typeof provider !== 'string' || !PROVIDERS.has(provider))) throw invalid('from.provider is invalid.');

      const result = await deliverSessionMessage({
        sessionId: body.sessionId,
        message: body.message,
        messageId: body.messageId,
        from: { address: address as string | null, machine: from.machine.trim(), provider: provider as string | null },
      }, { userId, runtime, nodeId });
      res.json(createApiSuccessResponse(result));
    }),
  );
  return router;
}
