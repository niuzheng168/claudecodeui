import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { FileTreeDirectoryStatus, FileTreeNode, Project } from '@/shared/types';
import {
  attachFolderListings,
  fetchFolderListing,
  findUnloadedOpenFolders,
  readResponseErrorMessage,
} from '@/modules/file-tree/utils/folderListing';
import type { FolderListing } from '@/modules/file-tree/utils/folderListing';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
  // Whether folders load as they are opened. False for a node from before
  // that, which sends the whole tree at once, so it is searched here.
  loadsFolders: boolean;
  // By folder path, the project root's under ROOT_FOLDER_KEY.
  directoryStatuses: ReadonlyMap<string, FileTreeDirectoryStatus>;
  // A folder's entries, listed now unless they are loaded, for downloading it.
  readFolderEntries: (folderPath: string) => Promise<FileTreeNode[]>;
};

/** The key of the project root's status in `directoryStatuses`. */
export const ROOT_FOLDER_KEY = '';

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

type LoadedTree = {
  projectId: string;
  // 'folders': `root` lists the project root, and each folder loads when it
  // is opened. 'whole': `root` is the whole tree an older node sent.
  mode: 'folders' | 'whole';
  root: FolderListing;
  // Aborted once the tree is replaced, which drops its folder loads.
  controller: AbortController;
  // Folders being listed for this tree, so each is asked for once.
  listing: Set<string>;
};

const NO_LISTINGS: ReadonlyMap<string, FolderListing> = new Map();
const NO_FAILURES: ReadonlyMap<string, string> = new Map();

/**
 * The project's file tree, loaded a folder at a time: the root when the
 * project is shown, and each folder the first time it is open and showing.
 * Listing only what is looked at keeps a project of any size, such as a home
 * folder, within the server's per-listing limit. A refresh lists the root and
 * the open folders again.
 */
export function useFileTreeData(
  selectedProject: Project | null,
  expandedDirs: ReadonlySet<string>,
): UseFileTreeDataResult {
  const [tree, setTree] = useState<LoadedTree | null>(null);
  // Loaded folders' entries, by folder path.
  const [listings, setListings] = useState(NO_LISTINGS);
  // Why folders failed to load, by folder path. Kept until the next refresh,
  // which tries them again.
  const [folderFailures, setFolderFailures] = useState(NO_FAILURES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Read by a refresh, which lists the open folders again without depending
  // on them: opening a folder must not reload the whole tree.
  const refreshStateRef = useRef({ tree, listings, expandedDirs });
  useEffect(() => {
    refreshStateRef.current = { tree, listings, expandedDirs };
  }, [tree, listings, expandedDirs]);

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;

    if (!projectId) {
      setTree(null);
      setListings(NO_LISTINGS);
      setFolderFailures(NO_FAILURES);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    const fetchFiles = async () => {
      setLoading(true);
      setError(null);
      try {
        const rootResult = await fetchFolderListing(projectId, null, signal);

        if (rootResult.kind === 'listed') {
          const previous = refreshStateRef.current;
          const reopened = previous.tree?.projectId === projectId && previous.tree.mode === 'folders'
            ? [...previous.listings.keys()].filter((folder) => previous.expandedDirs.has(folder))
            : [];
          const relisted = await Promise.all(reopened.map(async (folder) =>
            [folder, await fetchFolderListing(projectId, folder, signal)] as const));
          const nextListings = new Map<string, FolderListing>();
          // A folder that is gone or unreadable now is left unloaded; if it
          // still shows, it is loaded again and reports why it failed.
          relisted.forEach(([folder, result]) => {
            if (result.kind === 'listed') nextListings.set(folder, result.listing);
          });
          setTree({ projectId, mode: 'folders', root: rootResult.listing, controller, listing: new Set() });
          setListings(nextListings);
          setFolderFailures(NO_FAILURES);
          return;
        }

        if (rootResult.kind === 'failed') {
          setTree(null);
          setError(rootResult.error);
          return;
        }

        const response = await api.getFiles(projectId, { signal });
        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          let body: unknown = null;
          try {
            body = JSON.parse(errorText);
          } catch {
            // Not the API's JSON error: the default message stands.
          }
          setTree(null);
          setError(readResponseErrorMessage(body) ?? DEFAULT_LOAD_ERROR);
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        setTree({ projectId, mode: 'whole', root: { entries: data, truncated: false }, controller, listing: new Set() });
        setListings(NO_LISTINGS);
        setFolderFailures(NO_FAILURES);
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        setTree(null);
        setError(DEFAULT_LOAD_ERROR);
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      controller.abort();
    };
  }, [selectedProject?.projectId, refreshKey]);

  const files = useMemo(
    () => (tree ? attachFolderListings(tree.root.entries, listings) : []),
    [tree, listings],
  );

  // Folders open and showing whose entries are not loaded: each is loading,
  // unless it failed.
  const unloadedOpenFolders = useMemo(
    () => (tree?.mode === 'folders' ? findUnloadedOpenFolders(files, expandedDirs) : []),
    [tree, files, expandedDirs],
  );

  useEffect(() => {
    if (!tree || tree.controller.signal.aborted) {
      return;
    }
    const { signal } = tree.controller;
    unloadedOpenFolders
      .filter((folder) => !folderFailures.has(folder) && !tree.listing.has(folder))
      .forEach((folder) => {
        tree.listing.add(folder);
        const fail = (message: string) => {
          if (signal.aborted) return;
          setFolderFailures((previous) => new Map(previous).set(folder, message));
        };
        fetchFolderListing(tree.projectId, folder, signal).then((result) => {
          tree.listing.delete(folder);
          if (signal.aborted) return;
          if (result.kind === 'listed') {
            setListings((previous) => new Map(previous).set(folder, result.listing));
          } else {
            fail(result.kind === 'failed' ? result.error : DEFAULT_LOAD_ERROR);
          }
        }, (loadError: unknown) => {
          tree.listing.delete(folder);
          if ((loadError as { name?: string }).name !== 'AbortError') {
            console.error('Error fetching folder:', loadError);
          }
          fail(DEFAULT_LOAD_ERROR);
        });
      });
  }, [tree, unloadedOpenFolders, folderFailures]);

  const directoryStatuses = useMemo(() => {
    const statuses = new Map<string, FileTreeDirectoryStatus>();
    unloadedOpenFolders.forEach((folder) => {
      const failure = folderFailures.get(folder);
      statuses.set(folder, failure === undefined ? { state: 'loading' } : { state: 'failed', error: failure });
    });
    if (tree?.root.truncated) {
      statuses.set(ROOT_FOLDER_KEY, { state: 'truncated', shown: tree.root.entries.length });
    }
    listings.forEach((listing, folder) => {
      if (listing.truncated) statuses.set(folder, { state: 'truncated', shown: listing.entries.length });
    });
    return statuses;
  }, [tree, listings, unloadedOpenFolders, folderFailures]);

  const readFolderEntries = useCallback(async (folderPath: string): Promise<FileTreeNode[]> => {
    if (!tree || tree.mode !== 'folders') {
      // The whole tree an older node sent holds every folder it lists.
      return [];
    }
    const loaded = listings.get(folderPath);
    if (loaded) {
      return attachFolderListings(loaded.entries, listings);
    }
    const result = await fetchFolderListing(tree.projectId, folderPath);
    if (result.kind !== 'listed') {
      throw new Error(result.kind === 'failed' ? result.error : DEFAULT_LOAD_ERROR);
    }
    return result.listing.entries;
  }, [tree, listings]);

  return {
    files,
    loading,
    error,
    refreshFiles,
    loadsFolders: tree?.mode === 'folders',
    directoryStatuses,
    readFolderEntries,
  };
}
