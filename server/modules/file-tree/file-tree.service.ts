import path from 'node:path';

import ignore from 'ignore';

import type {
  FileTreeDirectoryEntry,
  FileTreeNode,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/index.js';
import {
  AppError, FORBIDDEN_WORKSPACE_PATHS, isPathInsideDirectory, normalizeProjectPath,
} from '@/shared/index.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// File Tree consumes this guard when recursively listing a project so a very
// broad workspace (for example, a user's home directory) cannot exhaust the
// server heap before the browser has a chance to switch to a narrower project.
const MAXIMUM_FILE_TREE_ENTRIES = 10_000;

// File search lists no more than this many files of a project (or files and
// folders, when it walks one). A larger project is searched in those listed
// first. Only paths are kept, so this is far cheaper than a file tree entry.
const MAXIMUM_SEARCHED_ENTRIES = 250_000;
// Searches reuse a project's list until this long after the last one, and only
// this many projects keep a list.
const SEARCH_LISTING_IDLE_MS = 2 * 60_000;
const MAXIMUM_SEARCH_LISTINGS = 4;

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => boolean;

/** A project's files for search: `/`-separated relative paths, with their lower-case forms and depths. */
type SearchListing = {
  paths: string[];
  lowerPaths: string[];
  depths: Uint16Array;
  truncated: boolean;
};

function createSearchListing(paths: string[], truncated: boolean): SearchListing {
  const depths = new Uint16Array(paths.length);
  paths.forEach((filePath, index) => {
    let depth = 0;
    for (let position = filePath.indexOf('/'); position !== -1; position = filePath.indexOf('/', position + 1)) {
      depth += 1;
    }
    depths[index] = depth;
  });
  return { paths, lowerPaths: paths.map((filePath) => filePath.toLowerCase()), depths, truncated };
}

/**
 * How well a lower-case relative path matches a lower-case query, lower is
 * better: 0 the file name starts with it, 1 the file name contains it, 2 only
 * the folders contain it (or the query spans a `/`). -1 for no match.
 */
function rankSearchMatch(lowerPath: string, query: string): number {
  const nameStart = lowerPath.lastIndexOf('/') + 1;
  const nameIndex = lowerPath.indexOf(query, nameStart);
  if (nameIndex !== -1) return nameIndex === nameStart ? 0 : 1;
  return lowerPath.includes(query) ? 2 : -1;
}

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): boolean {
  return !isDirectory || !HARD_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath));
}

function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): boolean {
  return includeEntryByHardExclusions(entryPath, isDirectory)
    && (!isDirectory || !IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)));
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  if (!isPathInsideDirectory(projectRoot, resolvedPath)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

function createGitignoreEntryFilter(
  projectRoot: string,
  gitignoreContent: string,
): FileTreeEntryFilter {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    if (!includeEntryByHardExclusions(entryPath, isDirectory)) return false;

    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    return !gitignore.ignores(matchPath);
  };
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, worktree, workspace, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  async function resolveSingleFilePath(
    projectRoot: string,
    filePath: string,
    allowMissingFile = false,
  ): Promise<{ requestedPath: string; canonicalPath: string }> {
    const requestedPath = path.resolve(projectRoot, filePath);
    let allowedRoot = projectRoot;
    if (!isPathInsideDirectory(projectRoot, requestedPath)) {
      // Relative traversal never expands scope. Absolute transcript links may
      // point at a verified sibling checkout, without registering a new project.
      const worktreeRoot = path.isAbsolute(filePath)
        ? await dependencies.worktrees.resolveRoot(projectRoot, requestedPath)
        : null;
      if (!worktreeRoot || !isPathInsideDirectory(worktreeRoot, requestedPath)) {
        throw createFileTreeError(
          'Path must be under the project root or a related Git worktree',
          403,
          'PATH_OUTSIDE_PROJECT',
        );
      }
      allowedRoot = worktreeRoot;
    }

    const canonicalRoot = await fileSystem.realpath(allowedRoot);
    if (allowedRoot !== projectRoot) {
      const validation = await dependencies.workspace.validatePath(canonicalRoot);
      if (!validation.valid) {
        throw createFileTreeError(
          validation.error ?? 'Worktree is outside the allowed workspace root',
          403,
          'INVALID_WORKSPACE_PATH',
        );
      }
      // The workspace validator also normalizes user-entered paths. Check the
      // exact canonical boundary so a real directory ending in whitespace, or
      // a symlinked workspace root, cannot turn a sibling into an allowed root.
      const canonicalWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      if (!isPathInsideDirectory(canonicalWorkspaceRoot, canonicalRoot, true)) {
        throw createFileTreeError(
          'Worktree is outside the allowed workspace root',
          403,
          'INVALID_WORKSPACE_PATH',
        );
      }
    }

    let canonicalPath: string;
    try {
      canonicalPath = await fileSystem.realpath(requestedPath);
    } catch (error) {
      if (!allowMissingFile || readErrorCode(error) !== 'ENOENT') throw error;
      // Preserve saving new files, but do not follow a dangling symlink when
      // realpath failed: writing it could create a file outside the project.
      try {
        await fileSystem.lstat(requestedPath);
        throw createFileTreeError('Cannot save through an unresolved symlink', 403, 'PATH_OUTSIDE_PROJECT');
      } catch (statError) {
        if (readErrorCode(statError) !== 'ENOENT') throw statError;
      }
      const canonicalParent = await fileSystem.realpath(path.dirname(requestedPath));
      canonicalPath = path.join(canonicalParent, path.basename(requestedPath));
    }
    if (!isPathInsideDirectory(canonicalRoot, canonicalPath)) {
      throw createFileTreeError(
        'Symlink target must stay under the project root or the permitted worktree root',
        403,
        'PATH_OUTSIDE_PROJECT',
      );
    }
    return { requestedPath, canonicalPath };
  }

  /**
   * Streams one directory and keeps only the entries the tree will show.
   *
   * Entries are filtered and charged against the shared budget one at a time,
   * so a pathologically large directory stops the walk at the cap instead of
   * being read into memory in full first.
   */
  async function collectVisibleEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    remainingEntries: { value: number },
  ): Promise<FileTreeDirectoryEntry[]> {
    const visibleEntries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        const isDirectory = entry.isDirectory();
        if (!includeEntry(path.join(directoryPath, entry.name), isDirectory)) {
          continue;
        }

        // Charged after visibility filtering so ignored entries never consume
        // the budget. Every recursive branch shares one counter, so the cap
        // applies to the whole tree rather than per directory.
        if (remainingEntries.value <= 0) {
          throw createFileTreeError(
            `Project file tree exceeds the ${MAXIMUM_FILE_TREE_ENTRIES.toLocaleString()} entry limit. Choose a narrower project directory or add ignore rules.`,
            413,
            'FILE_TREE_TOO_LARGE',
          );
        }
        remainingEntries.value -= 1;
        visibleEntries.push(entry);
      }
    } catch (error) {
      // The entry cap is a caller-visible outcome, not an unreadable directory.
      if (error instanceof AppError) {
        throw error;
      }
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return [];
    } finally {
      release();
    }

    return visibleEntries;
  }

  async function buildFileTree(
    directoryPath: string,
    maximumDepth: number,
    currentDepth = 0,
    includeEntry: FileTreeEntryFilter = includeEntryByFallbackDirectoryNames,
    remainingEntries = { value: MAXIMUM_FILE_TREE_ENTRIES },
  ): Promise<FileTreeNode[]> {
    const visibleEntries = await collectVisibleEntries(directoryPath, includeEntry, remainingEntries);

    const items = await Promise.all(visibleEntries.map(async (entry): Promise<FileTreeNode> => {
      const itemPath = path.join(directoryPath, entry.name);
      const item: FileTreeNode = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: 0,
        modified: null,
        permissions: '000',
        permissionsRwx: '---------',
      };

      try {
        await acquire();
        try {
          const stats = await fileSystem.lstat(itemPath);
          const ownerPermissions = (stats.mode >> 6) & 7;
          const groupPermissions = (stats.mode >> 3) & 7;
          const otherPermissions = stats.mode & 7;

          item.size = stats.size;
          item.modified = stats.mtime.toISOString();
          item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
          item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
            + permissionBitsToRwx(groupPermissions)
            + permissionBitsToRwx(otherPermissions);
          if (stats.isSymbolicLink()) {
            item.isSymlink = true;
          }
        } finally {
          release();
        }
      } catch {
        // Metadata failures should not hide an otherwise readable tree entry.
      }

      // Skip recursing into pseudo-filesystems and other system-critical
      // directories (e.g. /proc, /sys) — they're never valid project roots,
      // and /proc in particular can contain thousands of virtual entries
      // that make traversal from a broad root (e.g. "/") pathologically slow.
      const isForbiddenSystemDir = FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(itemPath));

      if (entry.isDirectory() && currentDepth < maximumDepth && !isForbiddenSystemDir) {
        item.children = await buildFileTree(
          itemPath,
          maximumDepth,
          currentDepth + 1,
          includeEntry,
          remainingEntries,
        );
      }

      return item;
    }));

    return items.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  /**
   * Which entries a project listing shows: everything but version-control and
   * dependency folders, or, when gitignore is respected and the project has a
   * root `.gitignore`, what that file does not ignore. Undefined means the
   * former, which is `buildFileTree`'s default.
   */
  async function readEntryFilter(projectRoot: string, respectGitignore: boolean): Promise<FileTreeEntryFilter | undefined> {
    if (!respectGitignore) return undefined;
    try {
      const gitignoreContent = await fileSystem.readTextFile(path.join(projectRoot, '.gitignore'));
      return createGitignoreEntryFilter(projectRoot, gitignoreContent);
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') {
        dependencies.logger.error(`Error reading .gitignore in "${projectRoot}"`, error);
      }
      return undefined;
    }
  }

  /**
   * Lists a project's files by walking it, for search where git lists none:
   * the files the file tree shows, without reading their metadata. Breadth
   * first, so a project over the limit is searched in its shallower files.
   */
  async function walkProjectFiles(projectRoot: string): Promise<{ paths: string[]; truncated: boolean }> {
    const includeEntry = await readEntryFilter(projectRoot, true) ?? includeEntryByFallbackDirectoryNames;
    const paths: string[] = [];
    let remainingEntries = MAXIMUM_SEARCHED_ENTRIES;
    let truncated = false;
    let directories = [projectRoot];
    while (directories.length > 0 && !truncated) {
      const subdirectories: string[] = [];
      await Promise.all(directories.map(async (directoryPath) => {
        await acquire();
        try {
          for await (const entry of fileSystem.openDirectory(directoryPath)) {
            const entryPath = path.join(directoryPath, entry.name);
            const isDirectory = entry.isDirectory();
            if (!includeEntry(entryPath, isDirectory)) continue;
            if (remainingEntries <= 0) {
              truncated = true;
              break;
            }
            remainingEntries -= 1;
            if (!isDirectory) {
              paths.push(path.relative(projectRoot, entryPath).split(path.sep).join('/'));
            } else if (!FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(entryPath))) {
              subdirectories.push(entryPath);
            }
          }
        } catch (error) {
          const errorCode = readErrorCode(error);
          if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
            dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
          }
        } finally {
          release();
        }
      }));
      directories = subdirectories;
    }
    return { paths, truncated };
  }

  // Each searched project's list, by project root: the listing, whether it
  // has finished, and the timer that drops it once searches stop.
  const searchListings = new Map<string, {
    listing: Promise<SearchListing>;
    settled: boolean;
    expiry: ReturnType<typeof setTimeout> | null;
  }>();

  /**
   * The project's file list for a search. Git lists it when the project is in
   * a work tree (all its `.gitignore` files apply, and tracked files count
   * even when ignored); otherwise, or when git lists nothing there, such as a
   * folder the repository ignores, it is walked.
   *
   * The list is reused by later searches, so typing a query lists the project
   * once. `refresh` lists it again, unless a listing is already under way,
   * which is as recent; searches made meanwhile wait for the new list.
   */
  function readSearchListing(projectRoot: string, refresh: boolean): Promise<SearchListing> {
    let cached = searchListings.get(projectRoot);
    if (!cached || (refresh && cached.settled)) {
      if (cached?.expiry) clearTimeout(cached.expiry);
      const created: NonNullable<typeof cached> = {
        listing: (async () => {
          const listed = await dependencies.git.listFiles(projectRoot, MAXIMUM_SEARCHED_ENTRIES);
          const { paths, truncated } = listed?.paths.length ? listed : await walkProjectFiles(projectRoot);
          return createSearchListing(paths, truncated);
        })(),
        settled: false,
        expiry: null,
      };
      created.listing.then(() => {
        created.settled = true;
      }, () => {
        // A listing that failed is not reused.
        if (searchListings.get(projectRoot) === created) {
          if (created.expiry) clearTimeout(created.expiry);
          searchListings.delete(projectRoot);
        }
      });
      cached = created;
    }

    const used = cached;
    // Kept in order of use, so the projects searched longest ago go first.
    searchListings.delete(projectRoot);
    searchListings.set(projectRoot, used);
    for (const [root, entry] of searchListings) {
      if (searchListings.size <= MAXIMUM_SEARCH_LISTINGS) break;
      if (entry.expiry) clearTimeout(entry.expiry);
      searchListings.delete(root);
    }
    if (used.expiry) clearTimeout(used.expiry);
    used.expiry = setTimeout(() => {
      if (searchListings.get(projectRoot) === used) searchListings.delete(projectRoot);
    }, SEARCH_LISTING_IDLE_MS);
    used.expiry.unref?.();
    return used.listing;
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a file the viewer may read but never write.
   *
   * A file reference in a transcript is normally inside the project or a
   * related worktree, but a background command's log lives in the system temp
   * directory and a background agent's output file is a link from there into
   * the Claude projects directory, and the transcript quotes those paths
   * verbatim. An absolute path outside the project therefore resolves through
   * the read-only root policy first (symlinks resolved before the comparison);
   * everything else goes through `resolveSingleFilePath`. The writing endpoints
   * never call this, so nothing outside the project can be changed.
   */
  async function resolveReadableFilePath(
    projectRoot: string,
    filePath: string,
  ): Promise<{ requestedPath: string; canonicalPath: string }> {
    const requestedPath = path.resolve(projectRoot, filePath);
    if (path.isAbsolute(filePath) && !isPathInsideDirectory(projectRoot, requestedPath)) {
      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(requestedPath);
      if (readOnlyPath) {
        return { requestedPath, canonicalPath: readOnlyPath };
      }
    }
    return resolveSingleFilePath(projectRoot, filePath);
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const fileTree = await buildFileTree(resolvedPath, 1);
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        const resolved = await resolveReadableFilePath(projectRoot, filePath);
        const content = await fileSystem.readTextFile(resolved.canonicalPath);
        return { content, path: resolved.requestedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EPERM: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        // Codex desktop keeps screenshots outside the checkout. Only this raw
        // read path may use the session-owned, raster-only artifact capability;
        // all text, worktree, listing and write boundaries remain unchanged.
        if (path.isAbsolute(filePath)
          && !isPathInsideDirectory(projectRoot, path.resolve(filePath))) {
          const image = await dependencies.transcriptImages.openImage(projectRoot, filePath);
          if (image) return image;
        }
        const resolved = await resolveReadableFilePath(projectRoot, filePath);
        await fileSystem.access(resolved.canonicalPath);
        return {
          contentType: dependencies.resolveMimeType(resolved.requestedPath),
          stream: fileSystem.createReadStream(resolved.canonicalPath),
        };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EPERM: { message: 'Permission denied', statusCode: 403 },
        });
      }
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        const resolved = await resolveSingleFilePath(projectRoot, filePath, true);
        await fileSystem.writeTextFile(resolved.canonicalPath, content);
        return { success: true, path: resolved.requestedPath, message: 'File saved successfully' };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EPERM: { message: 'Permission denied', statusCode: 403 },
        });
      }
    },

    async listProjectFiles(projectId, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      const includeEntry = await readEntryFilter(projectRoot, Boolean(options?.respectGitignore));
      return buildFileTree(projectRoot, 10, 0, includeEntry);
    },

    async searchProjectFiles(projectId, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      const listing = await readSearchListing(projectRoot, options.refresh);
      const query = options.query.toLowerCase().replace(/\\/g, '/');
      const limit = Math.max(1, Math.floor(options.limit));
      // Better first: rank, then shallower, shorter, and by name. Only the
      // best `limit` are kept while scanning, so nothing large is sorted.
      const isBefore = (left: { index: number; rank: number }, right: { index: number; rank: number }) => {
        const leftPath = listing.paths[left.index];
        const rightPath = listing.paths[right.index];
        return (left.rank - right.rank
          || listing.depths[left.index] - listing.depths[right.index]
          || leftPath.length - rightPath.length
          || (leftPath < rightPath ? -1 : 1)) < 0;
      };
      const best: Array<{ index: number; rank: number }> = [];
      listing.lowerPaths.forEach((lowerPath, index) => {
        const rank = rankSearchMatch(lowerPath, query);
        if (rank < 0) return;
        const match = { index, rank };
        if (best.length === limit && !isBefore(match, best[best.length - 1])) return;
        let position = best.length;
        while (position > 0 && isBefore(match, best[position - 1])) position -= 1;
        best.splice(position, 0, match);
        if (best.length > limit) best.pop();
      });

      return {
        files: best.map(({ index }) => {
          const filePath = listing.paths[index];
          return { name: filePath.slice(filePath.lastIndexOf('/') + 1), path: filePath };
        }),
        truncated: listing.truncated,
      };
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(projectRoot)
          : resolvePathInsideProject(projectRoot, input.targetPath);

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
