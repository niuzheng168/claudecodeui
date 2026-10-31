import path from 'node:path';

import { parseWorktreeListPorcelain } from '@/modules/worktrees/services/worktree-git.service.js';
import { AppError } from '@/shared/index.js';
import type { GitCommandRunner, WorkspacePathValidationResult } from '@/shared/index.js';

type DirectoryDiscoveryDependencies = {
  runGit: GitCommandRunner;
  validatePath(candidate: string): Promise<WorkspacePathValidationResult>;
  realpath(candidate: string): Promise<string>;
};

// Workbench directory keys cannot represent control characters or trimmed paths.
function usablePath(value: string): boolean {
  return path.isAbsolute(value) && value === value.trim()
    && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Worktrees composition uses this read-only discovery for Workbench's "add
 * directory". No CloudCLI project is registered and no checkout is created.
 * Only checkout roots expand; adding repo/src must not add the entire repo.
 */
export async function discoverWorktreeDirectories(
  projectPath: string,
  dependencies: DirectoryDiscoveryDependencies,
): Promise<{ paths: string[] }> {
  const { runGit, validatePath, realpath } = dependencies;
  if (!usablePath(projectPath)) {
    throw new AppError('An absolute directory path is required', {
      code: 'INVALID_PROJECT_PATH', statusCode: 400,
    });
  }
  const validation = await validatePath(projectPath);
  if (!validation.valid || !validation.resolvedPath) {
    throw new AppError('Invalid project path', {
      code: 'INVALID_PROJECT_PATH', statusCode: 400, details: validation.error,
    });
  }

  const gitPath = async (args: string[], cwd: string) => {
    const output = (await runGit(args, cwd)).stdout;
    const value = output.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '');
    if (!usablePath(value)) throw new Error('Invalid Git directory');
    return realpath(value);
  };
  const topLevelArgs = ['rev-parse', '--show-toplevel'];
  const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  let source: string;
  try {
    source = await realpath(validation.resolvedPath);
    if (path.relative(source, await gitPath(topLevelArgs, source)) !== '') return { paths: [] };
  } catch {
    // Ordinary folders (including paths not created yet) remain ordinary folders.
    return { paths: [] };
  }

  const [common, inventory] = await Promise.all([
    gitPath(commonArgs, source),
    runGit(['worktree', 'list', '--porcelain', '-z'], source),
  ]);
  const candidates = parseWorktreeListPorcelain(inventory.stdout, true)
    .filter((entry) => entry.headSha && !entry.isPrunable && usablePath(entry.path));
  const results: Array<string | null> = new Array(candidates.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length) {
      const index = next++;
      const candidate = candidates[index].path;
      try {
        const allowed = await validatePath(candidate);
        if (!allowed.valid || !allowed.resolvedPath) continue;
        const canonical = await realpath(allowed.resolvedPath);
        if (path.relative(source, canonical) === '') continue;
        // Stale registrations may now point to an unrelated repository.
        const [root, candidateCommon] = await Promise.all([
          gitPath(topLevelArgs, canonical), gitPath(commonArgs, canonical),
        ]);
        if (path.relative(canonical, root) === '' && path.relative(common, candidateCommon) === '') {
          results[index] = candidate;
        }
      } catch {
        // Missing or unreadable worktrees must not prevent adding the live ones.
      }
    }
  }));
  return { paths: [...new Set(results.filter((value): value is string => value !== null))] };
}
