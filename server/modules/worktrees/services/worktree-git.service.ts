import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution (same choice as routes/git.js).
import spawn from 'cross-spawn';

import type { GitCommandResult, GitCommandRunner, WorktreePorcelainEntry } from '@/shared/index.js';
import { AppError, normalizeProjectPath } from '@/shared/index.js';

/**
 * Worktrees composition's `GitCommandRunner`: spawns git in cwd and captures output.
 * Rejects with an `AppError` carrying git's stderr when the command fails, so
 * callers (and ultimately the API client) see the real git diagnostic.
 * Read-only metadata callers opt into bounded output/time and an environment
 * that cannot redirect repository discovery through inherited GIT_* values.
 * The caller remains responsible for supplying only read-only commands.
 */
export function runGitCommand(
  args: string[],
  cwd: string,
  options: { readOnly?: boolean } = {},
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const env = options.readOnly
      ? {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
          GIT_OPTIONAL_LOCKS: '0',
        }
      : process.env;
    const child = spawn('git', args, {
      cwd,
      shell: false,
      env,
      ...(options.readOnly ? { timeout: 5_000, killSignal: 'SIGKILL' as const } : {}),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;

    const collect = (chunks: Buffer[], data: Buffer) => {
      if (outputExceeded) return;
      outputBytes += data.length;
      if (options.readOnly && outputBytes > 1024 * 1024) {
        outputExceeded = true;
        child.kill('SIGKILL');
        reject(new AppError('Git metadata output exceeds the size limit', {
          code: 'GIT_OUTPUT_TOO_LARGE',
          statusCode: 500,
        }));
        return;
      }
      chunks.push(data);
    };

    child.stdout?.on('data', (data: Buffer) => {
      collect(stdoutChunks, data);
    });

    child.stderr?.on('data', (data: Buffer) => {
      collect(stderrChunks, data);
    });

    child.on('error', (error) => {
      reject(
        new AppError(`Failed to run git: ${error.message}`, {
          code: 'GIT_SPAWN_FAILED',
          statusCode: 500,
        }),
      );
    });

    child.on('close', (code) => {
      if (outputExceeded) return;
      // Decode once so Unicode paths split across stream chunks remain intact.
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new AppError(`git ${args.join(' ')} failed`, {
          code: 'GIT_COMMAND_FAILED',
          statusCode: 500,
          details: (stderr || stdout).trim(),
        }),
      );
    });
  });
}

/**
 * Defense-in-depth branch-name validation (mirrors routes/git.js), tightened to
 * also reject the leading-dash / lone-dot forms git itself refuses.
 */
export function validateWorktreeBranchName(branch: string): string {
  const trimmed = branch.trim();
  const components = trimmed.split('/');
  if (
    !trimmed ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.') ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('..') ||
    trimmed.includes('//') ||
    components.some((component) =>
      component.startsWith('.') || component.toLowerCase().endsWith('.lock')) ||
    !/^[a-zA-Z0-9._/-]+$/.test(trimmed)
  ) {
    throw new AppError('Invalid branch name', {
      code: 'INVALID_BRANCH_NAME',
      statusCode: 400,
    });
  }
  return trimmed;
}

/**
 * Used by worktree listing and file-scope resolution to parse Git's porcelain.
 * The default retains the listing API's legacy line-based normalization.
 * nullTerminated parses --porcelain -z without trimming or unquoting filesystem
 * paths, so whitespace, newlines, and Unicode cannot change access decisions.
 */
export function parseWorktreeListPorcelain(
  output: string,
  nullTerminated = false,
): WorktreePorcelainEntry[] {
  const entries: WorktreePorcelainEntry[] = [];
  let current: WorktreePorcelainEntry | null = null;

  const flush = () => {
    if (current) {
      entries.push(current);
      current = null;
    }
  };

  for (const rawLine of output.split(nullTerminated ? '\0' : '\n')) {
    const line = nullTerminated ? rawLine : rawLine.trimEnd();
    if (!line) {
      flush();
      continue;
    }

    if (line.startsWith('worktree ')) {
      flush();
      current = {
        path: nullTerminated
          ? path.normalize(line.slice('worktree '.length))
          : normalizeProjectPath(line.slice('worktree '.length)),
        headSha: null,
        branch: null,
        isDetached: false,
        isLocked: false,
        isPrunable: false,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.headSha = line.slice('HEAD '.length).trim() || null;
    } else if (line.startsWith('branch ')) {
      // Porcelain reports the full ref, e.g. "branch refs/heads/feature/x".
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim() || null;
    } else if (line === 'detached') {
      current.isDetached = true;
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.isLocked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.isPrunable = true;
    }
  }

  flush();
  return entries;
}

/**
 * Lists the repository's worktrees (main worktree first) for the repo that
 * contains `projectPath`. Throws a 400 `AppError` when the directory is not
 * inside a git repository.
 */
export async function listWorktreePorcelainEntries(
  projectPath: string,
  runGit: GitCommandRunner,
): Promise<WorktreePorcelainEntry[]> {
  let output: string;
  try {
    const result = await runGit(['worktree', 'list', '--porcelain'], projectPath);
    output = result.stdout;
  } catch (error) {
    throw new AppError('Not a git repository', {
      code: 'NOT_A_GIT_REPOSITORY',
      statusCode: 400,
      details: error instanceof AppError ? error.details : String(error),
    });
  }

  const entries = parseWorktreeListPorcelain(output);
  if (entries.length === 0) {
    throw new AppError('No worktrees found for repository', {
      code: 'WORKTREE_LIST_EMPTY',
      statusCode: 500,
    });
  }

  return entries;
}

/**
 * Finds the worktree entry matching `worktreePath` (normalized comparison).
 * Throws a 404 `AppError` when the path is not a registered worktree of the
 * repository — this is the guard that stops arbitrary paths reaching git.
 */
export function findWorktreeEntryByPath(
  entries: WorktreePorcelainEntry[],
  worktreePath: string,
): WorktreePorcelainEntry {
  const normalized = normalizeProjectPath(worktreePath);
  const comparable = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;

  const match = entries.find((entry) => comparable(entry.path) === comparable(normalized));
  if (!match) {
    throw new AppError('Path is not a worktree of this repository', {
      code: 'WORKTREE_NOT_FOUND',
      statusCode: 404,
    });
  }

  return match;
}

/**
 * Counts dirty paths (`git status --porcelain`) inside one worktree. Status
 * failures propagate so callers never mistake an unreadable worktree for clean.
 */
export async function countChangedFiles(
  worktreePath: string,
  runGit: GitCommandRunner,
): Promise<number> {
  const { stdout } = await runGit(['status', '--porcelain'], worktreePath);
  return stdout.split('\n').filter((line) => line.trim().length > 0).length;
}
