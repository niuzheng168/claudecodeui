import type {
  CreateAndOpenWorktreeResult,
  CreateWorktreeInput,
  GitCommandRunner,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { listWorktreePorcelainEntries, validateWorktreeBranchName } from '@/modules/worktrees/services/worktree-git.service.js';

/** Branch names tried after the requested one is taken: `<branch>-2` … `<branch>-9`. */
const MAX_SUFFIX = 9;

/**
 * A worktree for one task the Portal starts in the background
 * (codey/docs/codey-ado-intake.md §7): a new branch from the remote's default
 * branch, fetched first when the remote answers, in the usual sibling folder.
 * A branch name already used gets a numeric suffix instead of reusing that
 * branch, so the task never inherits an earlier attempt's commits.
 */
export async function createTaskWorktree(
  input: { projectPath: string; branch: string },
  dependencies: {
    runGit: GitCommandRunner;
    /** Best effort; a failed or slow fetch leaves the last fetched default branch. */
    fetchOrigin: (repositoryRoot: string) => Promise<void>;
    createAndOpen: (input: CreateWorktreeInput) => Promise<CreateAndOpenWorktreeResult>;
  },
): Promise<CreateAndOpenWorktreeResult> {
  const branch = validateWorktreeBranchName(input.branch);
  let entries;
  try {
    entries = await listWorktreePorcelainEntries(input.projectPath, dependencies.runGit);
  } catch {
    throw new AppError('This directory is not a Git repository; start without a worktree.', {
      code: 'SESSION_START_NOT_GIT', statusCode: 409,
    });
  }
  const repositoryRoot = entries[0].path;
  await dependencies.fetchOrigin(repositoryRoot).catch(() => {});

  let baseBranch: string | null = null;
  try {
    const { stdout } = await dependencies.runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repositoryRoot);
    baseBranch = stdout.trim() || null;
  } catch {
    for (const candidate of ['origin/main', 'origin/master']) {
      try {
        await dependencies.runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`], repositoryRoot);
        baseBranch = candidate;
        break;
      } catch { /* Not this one. */ }
    }
  }

  const taken = new Set(entries.map((entry) => entry.branch).filter(Boolean));
  for (let attempt = 1; attempt <= MAX_SUFFIX; attempt += 1) {
    const name = attempt === 1 ? branch : `${branch}-${attempt}`;
    if (taken.has(name)) continue;
    try {
      await dependencies.runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], repositoryRoot);
      continue; // An earlier attempt's branch: leave it alone.
    } catch { /* Free. */ }
    try {
      return await dependencies.createAndOpen({ projectPath: repositoryRoot, branch: name, baseBranch });
    } catch (error) {
      if (error instanceof AppError && ['BRANCH_ALREADY_CHECKED_OUT', 'WORKTREE_FOLDER_EXISTS'].includes(String(error.code))) continue;
      throw error;
    }
  }
  throw new AppError(`Branches ${branch} to ${branch}-${MAX_SUFFIX} are all taken.`, { code: 'SESSION_START_BRANCH_TAKEN', statusCode: 409 });
}
