import { stat } from 'node:fs/promises';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/index.js';
import { codexThreadStatus, providerCapabilitiesService, providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { turnOptions, watchStart } from '@/modules/session-messages/services/session-message-delivery.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { createTaskWorktreeProject } from '@/modules/worktrees/index.js';
import type { LLMProvider, NormalizedMessage, ProviderModelsDefinition } from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/index.js';

/**
 * Starts a new session in a directory with a first message, for work the
 * Portal starts without a browser (codey/docs/codey-ado-intake.md §7): an
 * ADO work item the user chose to start. With a branch, the session runs in a
 * new worktree on that branch from the remote's default branch.
 *
 * The first message is the user's own request, not a message from another
 * session, so it goes to the agent as typed. The turn runs with the options
 * a session message's turn gets, or the model, effort and permission mode the
 * user chose from `startOptions`, and resolves once it has started.
 */

const START_POLL_MS = 100;
export const START_PROVIDERS = ['claude', 'codex'] as const;
export type StartProvider = typeof START_PROVIDERS[number];

/** One agent's choices on this machine. */
export type StartAgentOptions = {
  available: boolean;
  models: { value: string; label: string; description: string; efforts: string[]; defaultEffort: string | null }[];
  defaultModel: string | null;
  permissionModes: string[];
  /** The mode a start gets when none is chosen; null keeps the agent's own (Codex: the thread's configured permissions). */
  defaultPermissionMode: string | null;
};
export type StartOptions = Record<StartProvider, StartAgentOptions>;

/** The models with their efforts and the permission modes a start may choose, per agent (codey/docs/codey-ado-intake.md §7). */
export async function startOptions(hasRuntime: (provider: string) => boolean = () => true): Promise<StartOptions> {
  const agents = {} as StartOptions;
  for (const provider of START_PROVIDERS) {
    let catalog: ProviderModelsDefinition | null = null;
    try {
      catalog = await providerModelsService.getProviderModels(provider);
    } catch {
      // Listed without models: a start then runs the agent's default.
    }
    const capabilities = providerCapabilitiesService.getProviderCapabilities(provider);
    agents[provider] = {
      available: hasRuntime(provider),
      models: (catalog?.OPTIONS ?? []).slice(0, 50).map((option) => ({
        value: option.value, label: option.label.slice(0, 200), description: (option.description ?? '').slice(0, 300),
        efforts: (option.effort?.values ?? []).map((entry) => entry.value), defaultEffort: option.effort?.default ?? null,
      })),
      defaultModel: catalog?.DEFAULT || null,
      permissionModes: capabilities.permissionModes,
      // Matches turnOptions: only a Claude turn is given a mode.
      defaultPermissionMode: provider === 'claude' ? capabilities.defaultPermissionMode : null,
    };
  }
  return agents;
}

export type SessionStartInput = {
  path: string;
  provider: LLMProvider;
  text: string;
  /** A worktree branch to create, or null to run in `path` itself. */
  branch: string | null;
  /** The Codey project the session is for, so it gets the project's memory brief. */
  workbenchProjectId: string | null;
  /** Chosen from `startOptions`; null keeps what a session message's turn would get. */
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
};

/** `model` and `effort` are what the first turn runs with, the machine's defaults included; null when the turn names none. */
export type SessionStartResult = { sessionId: string; provider: string; path: string; branch: string | null; model: string | null; effort: string | null };

/** The model and effort a turn's options name. */
function ranWith(options: Record<string, unknown>): { model: string | null; effort: string | null } {
  return {
    model: typeof options.model === 'string' && options.model ? options.model : null,
    effort: typeof options.effort === 'string' && options.effort ? options.effort : null,
  };
}

type Dependencies = {
  directory: (requested: string) => Promise<string>;
  register: (projectPath: string) => Promise<void>;
  createWorktree: typeof createTaskWorktreeProject;
  runTurn: typeof runDetachedChatTurn;
  options?: () => Promise<StartOptions>;
};

/** The existing directory a request names, inside this machine's workspace. */
async function directory(requested: string): Promise<string> {
  const validation = await validateWorkspacePath(requested);
  if (!validation.valid || !validation.resolvedPath) {
    throw new AppError('The directory is outside this machine\'s workspace.', { code: 'SESSION_START_INVALID_PATH', statusCode: 400 });
  }
  const resolved = normalizeProjectPath(validation.resolvedPath);
  if (!(await stat(resolved).then((entry) => entry.isDirectory(), () => false))) {
    throw new AppError('The directory does not exist on this machine.', { code: 'SESSION_START_NO_DIRECTORY', statusCode: 404 });
  }
  return resolved;
}

/** Sessions list under a registered project; a directory sessions ran in is one already. */
async function register(projectPath: string): Promise<void> {
  if (projectsDb.getProjectPath(projectPath)) return;
  try {
    await createProject({ projectPath });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'PROJECT_ALREADY_EXISTS') throw error;
  }
}

type Choice = { provider: LLMProvider; model?: string | null; effort?: string | null; permissionMode?: string | null };

/** The chosen model, effort and permission mode, checked against what this machine offers before anything is created. */
async function chosenOptions(input: Choice, options: () => Promise<StartOptions>): Promise<Record<string, string>> {
  if (!input.model && !input.effort && !input.permissionMode) return {};
  const agent = (await options())[input.provider as StartProvider];
  const refuse = (message: string) => new AppError(message, { code: 'SESSION_START_INVALID', statusCode: 400 });
  const model = input.model ?? agent?.defaultModel ?? null;
  const entry = agent?.models.find((option) => option.value === model);
  if (input.model && !entry) throw refuse(`This machine has no ${input.provider} model ${input.model}.`);
  if (input.effort && !entry?.efforts.includes(input.effort)) throw refuse(`The model does not offer effort ${input.effort}.`);
  if (input.permissionMode && !agent?.permissionModes.includes(input.permissionMode)) {
    throw refuse(`${input.provider} has no permission mode ${input.permissionMode}.`);
  }
  return {
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
  };
}

const defaults: Dependencies = { directory, register, createWorktree: createTaskWorktreeProject, runTurn: runDetachedChatTurn };

export async function startSession(
  input: SessionStartInput,
  { userId, runtime }: { userId: number; runtime: ProviderRuntimeGateway },
  dependencies: Dependencies = defaults,
): Promise<SessionStartResult> {
  if (!runtime.hasRuntime(input.provider)) {
    throw new AppError(`This machine cannot run ${input.provider} sessions.`, { code: 'SESSION_START_UNAVAILABLE', statusCode: 409 });
  }
  const chosen = await chosenOptions(input, dependencies.options ?? startOptions);
  const root = await dependencies.directory(input.path);
  let path = root;
  let branch: string | null = null;
  if (input.branch) {
    const worktree = await dependencies.createWorktree({ projectPath: root, branch: input.branch });
    path = worktree.worktreePath;
    branch = worktree.branch;
  } else await dependencies.register(root);

  const { sessionId } = sessionsService.createAppSession(input.provider, path, input.text);
  const options = {
    ...await turnOptions(input.provider, sessionId),
    ...chosen,
    ...(input.workbenchProjectId ? { workbenchProjectId: input.workbenchProjectId } : {}),
  };
  await runTurn(dependencies.runTurn, { sessionId, userId, content: input.text, options }, runtime, 'SESSION_START_FAILED');
  return { sessionId, provider: input.provider, path, branch, ...ranWith(options) };
}

/** Starts a turn and resolves once it runs; a turn that fails to get going is an error. */
async function runTurn(
  run: typeof runDetachedChatTurn, turn: Parameters<typeof runDetachedChatTurn>[0], runtime: ProviderRuntimeGateway, code: string,
): Promise<void> {
  const startedAt = Date.now();
  const outcome: { refused: string | null } = { refused: null };
  const running = run(turn, { runtime })
    .then((value) => { if (!value.started) outcome.refused = value.error; })
    .catch((error: unknown) => { outcome.refused = error instanceof Error ? error.message : String(error); });
  await Promise.race([running, new Promise((resolve) => setTimeout(resolve, START_POLL_MS))]);
  const failure = outcome.refused ?? await watchStart(turn.sessionId, startedAt);
  if (failure) throw new AppError(failure, { code, statusCode: 409 });
}

function isBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork?.(sessionId) === true;
}

export type SessionTurnInput = { sessionId: string; text: string; model?: string | null; effort?: string | null; permissionMode?: string | null };

/**
 * One more turn of an existing session, with the user's own message as typed:
 * carrying out a diagnosis in the session that made it, or diagnosing again
 * (codey/docs/codey-ado-intake.md §7.2). An idle session only.
 */
export async function continueSession(
  input: SessionTurnInput,
  { userId, runtime }: { userId: number; runtime: ProviderRuntimeGateway },
  dependencies: Pick<Dependencies, 'runTurn' | 'options'> = defaults,
): Promise<{ sessionId: string; provider: string; model: string | null; effort: string | null }> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) throw new AppError('No such session on this machine.', { code: 'SESSION_TURN_NO_SESSION', statusCode: 404 });
  const provider = session.provider as LLMProvider;
  if (!START_PROVIDERS.includes(provider as StartProvider) || !runtime.hasRuntime(provider)) {
    throw new AppError(`This machine cannot run ${provider} sessions.`, { code: 'SESSION_TURN_UNAVAILABLE', statusCode: 409 });
  }
  if (isBusy(input.sessionId, runtime)) {
    throw new AppError('The session is busy; try again when its turn has ended.', { code: 'SESSION_TURN_BUSY', statusCode: 409 });
  }
  const chosen = await chosenOptions({ provider, model: input.model, effort: input.effort, permissionMode: input.permissionMode },
    dependencies.options ?? startOptions);
  const options = { ...await turnOptions(provider, input.sessionId), ...chosen };
  await runTurn(dependencies.runTurn, { sessionId: input.sessionId, userId, content: input.text, options }, runtime, 'SESSION_TURN_FAILED');
  return { sessionId: input.sessionId, provider, ...ranWith(options) };
}

const MAX_REPLY_CHARS = 32_000;

/** How the session's last turn ended, while this machine still knows: as the activity report says it. */
function turnOutcome(sessionId: string): string | null {
  const session = sessionsDb.getSessionById(sessionId);
  if (session?.provider === 'codex' && session.provider_session_id && codexThreadStatus.outcomeOf(session.provider_session_id)) return 'failed';
  const run = chatRunRegistry.getRun(sessionId);
  return run?.status === 'completed' ? run.outcome : null;
}

/**
 * The session's reply to its last user message, as text, whether a turn is
 * running, and whether the turn failed: it ended in an error, or (Claude) no
 * model wrote any of the reply, as with the API-error and usage-limit notices
 * Claude Code writes itself. The end of a long reply is kept.
 */
export async function lastReply(
  sessionId: string, runtime: ProviderRuntimeGateway,
  history: (id: string) => Promise<{ messages: NormalizedMessage[] }> = (id) => sessionsService.fetchHistory(id, { limit: 100, offset: 0 }),
  outcome: (id: string) => string | null = turnOutcome,
): Promise<{ sessionId: string; busy: boolean; failed: boolean; text: string; at: string | null }> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    throw new AppError('No such session on this machine.', { code: 'SESSION_TURN_NO_SESSION', statusCode: 404 });
  }
  const busy = isBusy(sessionId, runtime);
  const { messages } = await history(sessionId);
  let lastUser = -1;
  messages.forEach((message, index) => { if (message.role === 'user' && message.kind === 'text') lastUser = index; });
  const reply = messages.slice(lastUser + 1).filter((message) => message.role === 'assistant' && message.kind === 'text' && message.content);
  const unanswered = session.provider === 'claude' && reply.length > 0 && reply.every((message) => !message.model);
  return {
    sessionId, busy, failed: !busy && (outcome(sessionId) === 'failed' || unanswered),
    text: reply.map((message) => message.content).join('\n\n').slice(-MAX_REPLY_CHARS),
    at: reply.at(-1)?.timestamp ?? null,
  };
}
