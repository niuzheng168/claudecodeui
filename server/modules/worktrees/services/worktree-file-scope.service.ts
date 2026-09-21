import path from 'node:path';

import { parseWorktreeListPorcelain } from '@/modules/worktrees/services/worktree-git.service.js';
import { isPathInsideDirectory } from '@/shared/index.js';
import type { GitCommandRunner } from '@/shared/index.js';

type WorktreeFileScopeDependencies = {
  runGit: GitCommandRunner;
  realpath(candidatePath: string): Promise<string>;
};

function readGitPath(output: string): string {
  // Remove only Git's record terminator, not whitespace belonging to the path.
  const value = output.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
  if (!path.isAbsolute(value) || value.includes('\0')) {
    throw new Error('Git returned an invalid absolute path');
  }
  return value;
}

/**
 * Worktrees composition and tests use this read-only file-scope resolver.
 * Only a checkout listed by the source repository AND sharing its canonical
 * Git common directory can extend File Tree's single-file access boundary.
 * Fail closed on stale registrations, non-Git directories, or query failures.
 */
export async function findRelatedWorktreeFileRoot(
  projectPath: string,
  filePath: string,
  dependencies: WorktreeFileScopeDependencies,
): Promise<string | null> {
  if (!path.isAbsolute(filePath)) return null;

  const { runGit, realpath } = dependencies;
  const gitPath = async (args: string[], cwd: string) =>
    realpath(readGitPath((await runGit(args, cwd)).stdout));
  const topLevelArgs = ['rev-parse', '--show-toplevel'];
  const commonDirectoryArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];

  try {
    const projectRoot = await realpath(projectPath);
    const sourceRoot = await gitPath(topLevelArgs, projectRoot);
    if (!isPathInsideDirectory(sourceRoot, projectRoot, true)) return null;

    // A project registered at repo/src must not acquire access to repo/secrets
    // merely because a file link points at a different checkout of that repo.
    const projectSuffix = path.relative(sourceRoot, projectRoot);
    const [sourceCommonDirectory, inventory] = await Promise.all([
      gitPath(commonDirectoryArgs, projectRoot),
      runGit(['worktree', 'list', '--porcelain', '-z'], projectRoot),
    ]);
    const candidates = parseWorktreeListPorcelain(inventory.stdout, true)
      .filter((entry) => !entry.isPrunable && entry.headSha && path.isAbsolute(entry.path))
      .map((entry) => ({
        worktreePath: entry.path,
        fileRoot: path.resolve(entry.path, projectSuffix),
      }))
      .filter(({ fileRoot }) => isPathInsideDirectory(fileRoot, filePath))
      .sort((left, right) => right.fileRoot.length - left.fileRoot.length);

    for (const { worktreePath, fileRoot } of candidates) {
      const [worktreeRoot, actualRoot, commonDirectory, canonicalFileRoot] = await Promise.all([
        realpath(worktreePath),
        gitPath(topLevelArgs, worktreePath),
        gitPath(commonDirectoryArgs, worktreePath),
        realpath(fileRoot),
      ]);
      if (path.relative(worktreeRoot, actualRoot) !== ''
        || path.relative(sourceCommonDirectory, commonDirectory) !== ''
        || !isPathInsideDirectory(worktreeRoot, canonicalFileRoot, true)) {
        continue;
      }
      return fileRoot;
    }
  } catch {
    // Never fall back to a common parent or a separately registered Home project.
  }

  return null;
}
