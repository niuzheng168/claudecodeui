import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';

import { projectsDb } from '@/modules/database/index.js';
import {
  createProject,
  deleteOrArchiveProject,
  restoreArchivedProject,
} from '@/modules/projects/index.js';
import type {
  WorktreeFileSystem,
  WorktreeProjectGateway,
  WorktreeServices,
} from '@/shared/index.js';
import { AppError, validateWorkspacePath } from '@/shared/index.js';
import { createWorktree } from '@/modules/worktrees/services/worktree-create.service.js';
import { createAndOpenWorktree } from '@/modules/worktrees/services/worktree-create-and-open.service.js';
import { runGitCommand } from '@/modules/worktrees/services/worktree-git.service.js';
import { findRelatedWorktreeFileRoot } from '@/modules/worktrees/services/worktree-file-scope.service.js';
import { listWorktrees } from '@/modules/worktrees/services/worktree-list.service.js';
import { discoverWorktreeDirectories } from '@/modules/worktrees/services/worktree-directories.service.js';
import { mergeWorktree } from '@/modules/worktrees/services/worktree-merge.service.js';
import { openWorktreeAsProject } from '@/modules/worktrees/services/worktree-open.service.js';
import { removeWorktree } from '@/modules/worktrees/services/worktree-remove.service.js';
import { createTaskWorktree } from '@/modules/worktrees/services/worktree-task.service.js';
import { createWorktreesRouter } from '@/modules/worktrees/worktrees.routes.js';

/**
 * Real filesystem adapter used only by Worktrees production composition.
 *
 * Services depend on the shared capability type and therefore cannot touch a
 * developer's filesystem unless this adapter is explicitly supplied.
 */
const worktreeFileSystem: WorktreeFileSystem = {
  async pathExists(candidatePath: string): Promise<boolean> {
    try {
      await access(candidatePath);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Projects boundary for Worktrees production workflows.
 *
 * Imports are deliberately restricted to the Database and Projects barrel
 * files. No Worktrees service knows which repository or project service backs
 * these operations.
 */
const worktreeProjects: WorktreeProjectGateway = {
  getProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  getProjectByPath: (projectPath) => projectsDb.getProjectPath(projectPath),
  createProject: (input) => createProject(input),
  restoreProject: (projectId) => restoreArchivedProject(projectId),
  archiveProject: (projectId) => deleteOrArchiveProject(projectId, false),
};

const remove: WorktreeServices['remove'] = (input) => removeWorktree(input, {
  runGit: runGitCommand,
  projects: worktreeProjects,
});

const create: WorktreeServices['create'] = (input) => createWorktree(input, {
  runGit: runGitCommand,
  fileSystem: worktreeFileSystem,
});

const open: WorktreeServices['open'] = (input) => openWorktreeAsProject(input, {
  runGit: runGitCommand,
  projects: worktreeProjects,
});

/**
 * Production Worktrees application-service surface.
 *
 * This is the module's composition root: it is the only location that combines
 * concrete adapters with the independently testable workflow functions.
 */
const worktreeServices: WorktreeServices = {
  resolveProjectPath(projectId) {
    const projectPath = worktreeProjects.getProjectPathById(projectId);
    if (!projectPath) {
      throw new AppError(`Unable to resolve project path for "${projectId}"`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }

    return projectPath;
  },
  list: (input) => listWorktrees(input, {
    runGit: runGitCommand,
    getProjectByPath: worktreeProjects.getProjectByPath,
  }),
  directories: (projectPath) => discoverWorktreeDirectories(projectPath, {
    runGit: (args, cwd) => runGitCommand(args, cwd, { readOnly: true }),
    validatePath: validateWorkspacePath,
    realpath,
  }),
  create,
  createAndOpen: (input) => createAndOpenWorktree(input, {
    createWorktree: create,
    openWorktree: open,
    removeWorktree: remove,
  }),
  open,
  merge: (input) => mergeWorktree(input, {
    runGit: runGitCommand,
    removeWorktree: remove,
  }),
  remove,
};

/**
 * File Tree uses this Git-verified boundary for linked files in other worktrees.
 * Metadata queries are bounded and read-only; no project rows are created.
 */
export function resolveRelatedWorktreeRoot(
  projectPath: string,
  filePath: string,
): Promise<string | null> {
  return findRelatedWorktreeFileRoot(projectPath, filePath, {
    runGit: (args, cwd) => runGitCommand(args, cwd, { readOnly: true }),
    realpath,
  });
}

/** `git fetch origin` that never prompts for credentials and gives up after a minute. */
function fetchOrigin(repositoryRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['fetch', '--quiet', '--no-tags', 'origin'], {
      cwd: repositoryRoot, timeout: 60_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Used by the Codey session start (session-messages module): a worktree on a
 * new branch from the remote's default branch, registered as a project.
 */
export function createTaskWorktreeProject(input: { projectPath: string; branch: string }) {
  return createTaskWorktree(input, { runGit: runGitCommand, fetchOrigin, createAndOpen: worktreeServices.createAndOpen });
}

/**
 * Worktrees router mounted by the server entrypoint at `/api/worktrees`.
 *
 * It is assembled here so other modules consume only the Worktrees barrel and
 * cannot depend on route or service implementation files.
 */
export const worktreesRoutes = createWorktreesRouter(worktreeServices);
