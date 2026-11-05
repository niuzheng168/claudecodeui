import { stat } from 'node:fs/promises';

import { projectsDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { turnOptions, watchStart } from '@/modules/session-messages/services/session-message-delivery.service.js';
import { runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { createTaskWorktreeProject } from '@/modules/worktrees/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/index.js';

/**
 * Starts a new session in a directory with a first message, for work the
 * Portal starts without a browser (codey/docs/codey-ado-intake.md §7): an
 * ADO work item the user chose to start. With a branch, the session runs in a
 * new worktree on that branch from the remote's default branch.
 *
 * The first message is the user's own request, not a message from another
 * session, so it goes to the agent as typed. The turn runs with the options
 * a session message's turn gets, and resolves once it has started.
 */

const START_POLL_MS = 100;

export type SessionStartInput = {
  path: string;
  provider: LLMProvider;
  text: string;
  /** A worktree branch to create, or null to run in `path` itself. */
  branch: string | null;
  /** The Codey project the session is for, so it gets the project's memory brief. */
  workbenchProjectId: string | null;
};

export type SessionStartResult = { sessionId: string; provider: string; path: string; branch: string | null };

type Dependencies = {
  directory: (requested: string) => Promise<string>;
  register: (projectPath: string) => Promise<void>;
  createWorktree: typeof createTaskWorktreeProject;
  runTurn: typeof runDetachedChatTurn;
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

const defaults: Dependencies = { directory, register, createWorktree: createTaskWorktreeProject, runTurn: runDetachedChatTurn };

export async function startSession(
  input: SessionStartInput,
  { userId, runtime }: { userId: number; runtime: ProviderRuntimeGateway },
  dependencies: Dependencies = defaults,
): Promise<SessionStartResult> {
  if (!runtime.hasRuntime(input.provider)) {
    throw new AppError(`This machine cannot run ${input.provider} sessions.`, { code: 'SESSION_START_UNAVAILABLE', statusCode: 409 });
  }
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
    ...(input.workbenchProjectId ? { workbenchProjectId: input.workbenchProjectId } : {}),
  };
  const startedAt = Date.now();
  const outcome: { refused: string | null } = { refused: null };
  const run = dependencies.runTurn({ sessionId, userId, content: input.text, options }, { runtime })
    .then((value) => { if (!value.started) outcome.refused = value.error; })
    .catch((error: unknown) => { outcome.refused = error instanceof Error ? error.message : String(error); });
  await Promise.race([run, new Promise((resolve) => setTimeout(resolve, START_POLL_MS))]);
  const failure = outcome.refused ?? await watchStart(sessionId, startedAt);
  if (failure) throw new AppError(failure, { code: 'SESSION_START_FAILED', statusCode: 409 });
  return { sessionId, provider: input.provider, path, branch };
}
