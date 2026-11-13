import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { collectExpandedDirectoryPaths, filterFileTree } from '@/modules/file-tree/utils/fileTreeUtils';
import { buildSearchTree } from '@/modules/file-tree/utils/folderListing';
import type { FileSearchResult } from '@/modules/file-tree/utils/folderListing';
import type { FileTreeNode } from '@/shared/types';

type UseFileTreeSearchArgs = {
  projectId: string | undefined;
  apiBasePath?: string;
  files: FileTreeNode[];
  // Ask the server, which searches the whole project. Otherwise `files` is
  // the whole tree an older node sent, and it is filtered here.
  searchOnServer: boolean;
  expandDirectories: (paths: string[]) => void;
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredFiles: FileTreeNode[];
  // The server has not answered the query yet.
  searchPending: boolean;
  // The server found more files than it returns, so some are not shown.
  searchLimited: boolean;
  // Search the project again, listing its files anew.
  refreshSearch: () => void;
};

// The most files the server returns for one search.
const SEARCH_LIMIT = 100;
// While a query is typed, the server is asked again once typing pauses this long.
const SEARCH_DELAY_MS = 150;

type FoundFiles = {
  projectId: string;
  apiBasePath?: string;
  query: string;
  files: FileTreeNode[];
  limited: boolean;
};

export function useFileTreeSearch({
  projectId,
  apiBasePath,
  files,
  searchOnServer,
  expandDirectories,
}: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [searchQuery, setSearchQuery] = useState('');
  const [found, setFound] = useState<FoundFiles | null>(null);
  const [searchRefreshKey, setSearchRefreshKey] = useState(0);
  // The server keeps a project's file list between searches. Files keep
  // appearing, so the first search of each query typed, and one after a
  // refresh, lists the project again.
  const relistRef = useRef(true);

  const query = searchQuery.trim();
  const serverQuery = searchOnServer && projectId ? query : '';

  useEffect(() => {
    if (!serverQuery || !projectId) {
      relistRef.current = true;
      return;
    }

    const controller = new AbortController();
    const refresh = relistRef.current;
    const timer = setTimeout(async () => {
      try {
        const response = await api.searchFiles(
          projectId,
          { query: serverQuery, limit: SEARCH_LIMIT, refresh },
          { signal: controller.signal, apiBasePath },
        );
        const body = (await response.json().catch(() => null)) as { files?: FileSearchResult[] } | null;
        if (controller.signal.aborted) return;
        if (!response.ok) {
          console.error('Error searching files:', response.status);
        } else {
          relistRef.current = false;
        }
        const results = Array.isArray(body?.files)
          ? body.files.filter((file) => typeof file.absolutePath === 'string')
          : [];
        setFound({
          projectId,
          apiBasePath,
          query: serverQuery,
          files: buildSearchTree(results),
          limited: results.length >= SEARCH_LIMIT,
        });
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        console.error('Error searching files:', error);
        setFound({ projectId, apiBasePath, query: serverQuery, files: [], limited: false });
      }
    }, refresh ? 0 : SEARCH_DELAY_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, apiBasePath, serverQuery, searchRefreshKey]);

  // Clearing the search drops its answer, so the next one does not open on it.
  const updateSearchQuery = useCallback((nextQuery: string) => {
    setSearchQuery(nextQuery);
    if (!nextQuery.trim()) {
      setFound(null);
    }
  }, []);

  const refreshSearch = useCallback(() => {
    relistRef.current = true;
    setSearchRefreshKey((previous) => previous + 1);
  }, []);

  // Derived, not stored: mirroring the filter into state made every keystroke
  // (and every tree refresh) cost an extra render, and left `filteredFiles` one
  // render behind `files`.
  const filteredFiles = useMemo(() => {
    if (!query) return files;
    if (!searchOnServer) return filterFileTree(files, query.toLowerCase());
    // The last answer stays up until the next one arrives.
    return found && found.projectId === projectId && found.apiBasePath === apiBasePath ? found.files : [];
  }, [files, query, searchOnServer, found, projectId, apiBasePath]);

  useEffect(() => {
    if (!query) {
      return;
    }
    // Keep search results visible by opening every matching ancestor directory once per query update.
    expandDirectories(collectExpandedDirectoryPaths(filteredFiles));
  }, [expandDirectories, filteredFiles, query]);

  const answered = found !== null && found.projectId === projectId && found.apiBasePath === apiBasePath && found.query === serverQuery;
  return {
    searchQuery,
    setSearchQuery: updateSearchQuery,
    filteredFiles,
    searchPending: Boolean(serverQuery) && !answered,
    searchLimited: Boolean(serverQuery) && answered && found.limited,
    refreshSearch,
  };
}
