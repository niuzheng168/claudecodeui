import { api } from '@/shared/api';
import type { FileTreeNode } from '@/shared/types';

/** One folder's entries, without their children; `truncated` when the server stopped at its entry limit. */
export type FolderListing = {
  entries: FileTreeNode[];
  truncated: boolean;
};

export type FolderListingResult =
  | { kind: 'listed'; listing: FolderListing }
  // The node is from before folders were listed one at a time, and serves its
  // app page for the route; the tree is then loaded whole, as it used to be.
  | { kind: 'unsupported' }
  | { kind: 'failed'; error: string };

/** A file the server search found: `path` relative to the project, `absolutePath` as the tree keys it. */
export type FileSearchResult = {
  name: string;
  path: string;
  absolutePath: string;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

function isFolderListing(body: unknown): body is FolderListing {
  return typeof body === 'object' && body !== null
    && Array.isArray((body as FolderListing).entries)
    && typeof (body as FolderListing).truncated === 'boolean';
}

// The API reports refusals such as FILE_TREE_TOO_LARGE as { error: message }.
// Surfacing that message tells the user why the tree is missing and what to do
// about it, instead of leaving them with an unexplained empty tree.
export function readResponseErrorMessage(body: unknown): string | null {
  const message = typeof body === 'object' && body !== null && 'error' in body
    ? (body as { error: unknown }).error
    : null;
  return typeof message === 'string' && message.trim() ? message : null;
}

/** Lists one folder of the project, or its root when `folderPath` is null. */
export async function fetchFolderListing(
  projectId: string,
  folderPath: string | null,
  signal?: AbortSignal,
): Promise<FolderListingResult> {
  const response = await api.listDirectory(projectId, folderPath, { signal });
  const body = (await response.json().catch(() => null)) as unknown;
  if (signal?.aborted) {
    // An abort while the body was read is not an old node's app page.
    throw new DOMException('The folder listing was aborted.', 'AbortError');
  }
  if (response.ok && isFolderListing(body)) {
    return { kind: 'listed', listing: body };
  }
  const error = readResponseErrorMessage(body);
  if (response.ok || (response.status === 404 && !error)) {
    return { kind: 'unsupported' };
  }
  return { kind: 'failed', error: error ?? DEFAULT_LOAD_ERROR };
}

/** The tree with every loaded folder's entries attached as its `children`. */
export function attachFolderListings(
  entries: FileTreeNode[],
  listings: ReadonlyMap<string, FolderListing>,
): FileTreeNode[] {
  return entries.map((entry) => {
    if (entry.type !== 'directory') {
      return entry;
    }
    const children = listings.get(entry.path)?.entries ?? entry.children;
    return children ? { ...entry, children: attachFolderListings(children, listings) } : entry;
  });
}

/** The folders that are open and showing, but whose entries have not been loaded, outermost first. */
export function findUnloadedOpenFolders(entries: FileTreeNode[], expandedDirs: ReadonlySet<string>): string[] {
  const unloaded: string[] = [];
  const visit = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'directory' || !expandedDirs.has(node.path)) continue;
      if (node.children) {
        visit(node.children);
      } else {
        unloaded.push(node.path);
      }
    }
  };
  visit(entries);
  return unloaded;
}

function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
  nodes.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  nodes.forEach((node) => node.children && sortTree(node.children));
  return nodes;
}

/**
 * The files a search found, inside the folders that hold them, ordered like
 * the tree. A folder's path is its file's absolute path less the segments
 * below it, so it matches the folder's node in the tree whatever separator
 * the server's platform uses.
 */
export function buildSearchTree(results: FileSearchResult[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const folders = new Map<string, FileTreeNode>();
  for (const result of results) {
    const segments = result.path.split('/');
    let level = roots;
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const relativePath = segments.slice(0, depth + 1).join('/');
      let folder = folders.get(relativePath);
      if (!folder) {
        const below = segments.slice(depth + 1).reduce((length, segment) => length + segment.length + 1, 0);
        folder = {
          type: 'directory',
          name: segments[depth],
          path: result.absolutePath.slice(0, result.absolutePath.length - below),
          children: [],
        };
        folders.set(relativePath, folder);
        level.push(folder);
      }
      level = folder.children!;
    }
    level.push({ type: 'file', name: result.name, path: result.absolutePath });
  }
  return sortTree(roots);
}
