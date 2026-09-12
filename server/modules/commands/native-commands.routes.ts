import express from 'express';

import { AppError, readObjectRecord } from '@/shared/index.js';
import type { CodexGoalCommandResult } from '@/shared/index.js';

/** Used by the authenticated Commands mount and route tests; all native work stays in Providers. */
export function createNativeCommandsRouter(
  goal: (sessionId: string | null, argumentsText: string) => Promise<CodexGoalCommandResult>,
): express.Router {
  const router = express.Router();
  router.post('/goal', async (req, res) => {
    try {
      const body = readObjectRecord(req.body);
      if (!body || typeof body.arguments !== 'string' || body.arguments.length > 20_000
        || (body.sessionId != null && (typeof body.sessionId !== 'string' || !body.sessionId.trim() || body.sessionId.length > 256))) {
        throw new AppError('Expected arguments text and an optional Codey sessionId.', {
          code: 'INVALID_GOAL_REQUEST', statusCode: 400,
        });
      }
      const result = await goal(body.sessionId ?? null, body.arguments);
      res.json(result);
    } catch (error) {
      res.status(error instanceof AppError ? error.statusCode : 500).json({
        code: error instanceof AppError ? error.code : 'GOAL_COMMAND_FAILED',
        error: error instanceof Error ? error.message : 'Goal command failed.',
      });
    }
  });
  return router;
}
