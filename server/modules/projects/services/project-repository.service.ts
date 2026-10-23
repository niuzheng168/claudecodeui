import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What Git says about a project directory, for clients that group projects
 * by repository (the Codey Workbench folds worktrees into their main checkout).
 */
export type ProjectRepository = {
  /** The main checkout. For a linked worktree, the checkout it was added from; null when Git does not record one. */
  root: string | null;
  /** The top of the checkout that contains the project directory. */
  checkout: string;
  /** True for a linked worktree (`git worktree add`, Claude/Codex/Cursor worktrees). */
  worktree: boolean;
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null;
};

type RepositoryFileSystem = {
  stat(target: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  readFile(target: string, encoding: 'utf8'): Promise<string>;
};

const CACHE_TTL_MS = 60_000;
const MAX_PARENT_DEPTH = 64;
const cache = new Map<string, { expiresAt: number; value: ProjectRepository | null }>();

async function statOrNull(fileSystem: RepositoryFileSystem, target: string) {
  try {
    return await fileSystem.stat(target);
  } catch {
    return null;
  }
}

async function readTrimmed(fileSystem: RepositoryFileSystem, target: string): Promise<string | null> {
  try {
    return (await fileSystem.readFile(target, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readBranch(fileSystem: RepositoryFileSystem, gitDirectory: string): Promise<string | null> {
  const head = await readTrimmed(fileSystem, path.join(gitDirectory, 'HEAD'));
  const match = head ? /^ref:\s*refs\/heads\/(.+)$/.exec(head) : null;
  return match ? match[1] : null;
}

/**
 * Reads the `.git` entry of the project or its nearest parent. Only files Git
 * itself maintains are read; no git process is started, so listing projects
 * stays cheap. Returns null when the directory no longer exists (a removed
 * worktree), letting the client fall back to the path layout.
 */
export async function readProjectRepository(
  projectPath: string,
  fileSystem: RepositoryFileSystem = fs,
): Promise<ProjectRepository | null> {
  const start = path.resolve(projectPath);
  if (!(await statOrNull(fileSystem, start))?.isDirectory()) return null;

  let directory = start;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const marker = path.join(directory, '.git');
    const entry = await statOrNull(fileSystem, marker);
    if (entry?.isDirectory()) {
      return { root: directory, checkout: directory, worktree: false, branch: await readBranch(fileSystem, marker) };
    }
    if (entry?.isFile()) {
      const pointer = await readTrimmed(fileSystem, marker);
      const match = pointer ? /^gitdir:\s*(.+)$/.exec(pointer) : null;
      if (!match) return null;
      const gitDirectory = path.resolve(directory, match[1]);
      const branch = await readBranch(fileSystem, gitDirectory);
      // Linked worktrees record their shared repository in `commondir`;
      // submodules and --separate-git-dir checkouts do not.
      const common = await readTrimmed(fileSystem, path.join(gitDirectory, 'commondir'));
      if (!common) return { root: directory, checkout: directory, worktree: false, branch };
      const commonDirectory = path.resolve(gitDirectory, common);
      const root = path.basename(commonDirectory) === '.git' ? path.dirname(commonDirectory) : null;
      return { root, checkout: directory, worktree: true, branch };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/** Cached for a minute per path: a project list may be requested on every page load. */
export async function describeProjectRepository(projectPath: string, now = Date.now()): Promise<ProjectRepository | null> {
  const cached = cache.get(projectPath);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await readProjectRepository(projectPath).catch(() => null);
  cache.set(projectPath, { expiresAt: now + CACHE_TTL_MS, value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value as string);
  return value;
}
