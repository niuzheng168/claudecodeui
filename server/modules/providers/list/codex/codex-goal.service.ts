import { AppError, readObjectRecord } from '@/shared/index.js';
import type { CodexGoal, CodexGoalCommand, CodexGoalCommandResult, ICodexRpcClient } from '@/shared/index.js';

const GOAL_HELP = [
  '`/goal <objective>` — start a persistent goal (up to 4,000 characters).',
  '`/goal --tokens 40000 <objective>` — start with an explicit token budget.',
  '`/goal` — show native status and usage.',
  '`/goal pause` / `/goal resume` / `/goal clear` — control the goal.',
  '`/goal edit [objective]` — prefill or replace the objective (replacement resets usage).',
  '`/goal budget <tokens|off>` — change the budget without resetting usage.',
  'Pause/clear prevents further automatic turns; the current turn may finish. The Stop button also interrupts the current goal turn.',
].join('\n\n');

function invalid(message: string): never {
  throw new AppError(message, { code: 'INVALID_GOAL_COMMAND', statusCode: 400 });
}

function tokenBudget(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return invalid('The goal token budget must be a positive safe integer.');
  }
  return Number(value);
}

/** Used by native runtime and goal-control service to parse explicit commands, not inferred user intent. */
export function parseCodexGoalCommand(argumentsText: string): CodexGoalCommand {
  const text = argumentsText.trim();
  if (!text || text === 'status') return { action: 'get' };
  if (text === 'help') return { action: 'help' };
  if (text === 'edit') return { action: 'edit' };
  for (const action of ['pause', 'resume', 'clear'] as const) {
    if (text === action) return { action };
    if (text.startsWith(action) && /^\s/.test(text.slice(action.length))) {
      return invalid(`Use /goal ${action} without additional arguments.`);
    }
  }
  if (/^budget(?:\s|$)/.test(text)) {
    const value = text.slice('budget'.length).trim();
    return { action: 'budget', tokenBudget: value === 'off' ? null : tokenBudget(value) };
  }
  let objective = text.replace(/^edit\s+/, '');
  let budget: number | undefined;
  if (objective.startsWith('--')) {
    const match = objective.match(/^--tokens\s+(\S+)\s+([\s\S]+)$/);
    if (!match) return invalid('Use /goal --tokens <positive integer> <objective>.');
    budget = tokenBudget(match[1]);
    objective = match[2].trim();
  }
  if (!objective || Array.from(objective).length > 4000) {
    return invalid('A goal objective must contain 1–4,000 characters.');
  }
  return { action: 'set', objective, ...(budget !== undefined ? { tokenBudget: budget } : {}) };
}

/** Used by the runtime monitor and control service to reject malformed or cross-thread goal replies. */
export function readCodexGoal(value: unknown, threadId: string): CodexGoal | null {
  if (value === null) return null;
  const goal = readObjectRecord(value);
  if (!goal || goal.threadId !== threadId || typeof goal.objective !== 'string'
    || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goal.status)
    || !(goal.tokenBudget === null || (Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0))
    || !Number.isFinite(goal.tokensUsed) || goal.tokensUsed < 0
    || !Number.isFinite(goal.timeUsedSeconds) || goal.timeUsedSeconds < 0) {
    throw new AppError('Codex returned an invalid goal snapshot. No operation was retried.', {
      code: 'CODEX_GOAL_INVALID_RESPONSE', statusCode: 502,
    });
  }
  return {
    threadId, objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds,
  };
}

/** Used by the goal monitor/control service; reads persisted state without resuming a thread. */
export async function getCodexGoal(client: ICodexRpcClient, threadId: string): Promise<CodexGoal | null> {
  const response = await client.request('thread/goal/get', { threadId });
  return readCodexGoal(response.goal, threadId);
}

/** Used by runtime-owned and short-lived goal-control connections. Never starts/resumes work. */
export async function controlCodexGoal(
  client: ICodexRpcClient, threadId: string, command: CodexGoalCommand,
): Promise<CodexGoal | null> {
  if (command.action === 'set' || command.action === 'resume') {
    throw new AppError('Start/resume a goal from the chat composer so Codey can track its run.', {
      code: 'GOAL_RUN_REQUIRED', statusCode: 409,
    });
  }
  if (command.action === 'clear') {
    const response = await client.request('thread/goal/clear', { threadId });
    if (typeof response.cleared !== 'boolean') {
      throw new AppError('Codex did not acknowledge clearing the goal. Check /goal before retrying.', {
        code: 'CODEX_GOAL_INVALID_RESPONSE', statusCode: 502,
      });
    }
    return null;
  }
  if (command.action === 'pause' || command.action === 'budget') {
    const response = await client.request('thread/goal/set', {
      threadId,
      ...(command.action === 'budget' ? { tokenBudget: command.tokenBudget } : { status: 'paused' }),
    });
    return readCodexGoal(response.goal, threadId);
  }
  return getCodexGoal(client, threadId);
}

/** Used by the control endpoint and live goal monitor to display native accounting without exposing native ids. */
export function formatCodexGoalResult(
  goal: CodexGoal | null, command: CodexGoalCommand = { action: 'get' },
): CodexGoalCommandResult {
  const publicGoal = goal ? {
    objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds,
  } : null;
  const message = goal
    ? `Goal: **${goal.status}**\n\n${goal.objective}\n\nTokens: ${goal.tokensUsed.toLocaleString('en-US')} / ${goal.tokenBudget?.toLocaleString('en-US') ?? 'no limit'} · Time: ${goal.timeUsedSeconds}s`
    : 'No goal is set for this session.';
  return {
    goal: publicGoal,
    message: command.action === 'help' || !goal ? `${message}\n\n${GOAL_HELP}` : message,
    ...(command.action === 'edit' && goal ? { draft: `/goal edit ${goal.objective}` } : {}),
  };
}
