import { sessionsDb } from '@/modules/database/index.js';
import { codexSharedRuntime } from '@/modules/providers/list/codex/codex-shared-runtime.provider.js';
import { formatCodexGoalResult, parseCodexGoalCommand } from '@/modules/providers/list/codex/codex-goal.service.js';
import { AppError } from '@/shared/index.js';
import type { CodexGoalCommandResult } from '@/shared/index.js';

type Dependencies = {
  getSession(id: string): { provider: string; provider_session_id: string | null; isArchived?: number } | null | undefined;
  controlGoal: typeof codexSharedRuntime.controlGoal;
};

/** Used by Commands and provider tests to resolve app ids before any native goal read/write. */
export function createCodexCommandsService(dependencies: Dependencies = {
  getSession: (id) => sessionsDb.getSessionById(id),
  controlGoal: (...args) => codexSharedRuntime.controlGoal(...args),
}) {
  return {
    async goal(sessionId: string | null, argumentsText: string): Promise<CodexGoalCommandResult> {
      const command = parseCodexGoalCommand(argumentsText);
      if (command.action === 'set' || command.action === 'resume') {
        throw new AppError('Start/resume a goal through the chat composer, not the control endpoint.', {
          code: 'GOAL_RUN_REQUIRED', statusCode: 409,
        });
      }
      const session = sessionId ? dependencies.getSession(sessionId) : null;
      if (sessionId && !session) {
        throw new AppError('The requested Codey session was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      }
      if (session && session.provider !== 'codex') {
        throw new AppError('/goal is only available for Codex sessions.', { code: 'GOAL_PROVIDER_UNSUPPORTED', statusCode: 400 });
      }
      if (session?.isArchived) {
        throw new AppError('Restore the archived session before managing its goal.', { code: 'GOAL_SESSION_ARCHIVED', statusCode: 409 });
      }
      if (!sessionId || !session?.provider_session_id) {
        if (command.action === 'pause' || command.action === 'budget') {
          throw new AppError('This session has no goal. Use /goal <objective> first.', { code: 'GOAL_NOT_FOUND', statusCode: 409 });
        }
        return formatCodexGoalResult(null, command);
      }
      const goal = command.action === 'help' ? null
        : await dependencies.controlGoal(sessionId, session.provider_session_id, command);
      return formatCodexGoalResult(goal, command);
    },
  };
}

/** Commands uses this service rather than accepting provider-native thread ids from the browser. */
export const codexCommandsService = createCodexCommandsService();
