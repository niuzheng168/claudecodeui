import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { api } from '@/shared/api';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import type { Project } from '@/shared/types';

export type MentionableFile = {
  name: string;
  path: string;
};

type UseFileMentionsOptions = {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
};

// The `@` dropdown offers this many files, best matches first.
const MENTION_SEARCH_LIMIT = 20;
// While a query is typed, the server is asked again once typing pauses this long.
const MENTION_SEARCH_DELAY_MS = 120;

const NO_FILES: MentionableFile[] = [];

type ProjectFileNode = {
  name: string;
  type: 'file' | 'directory';
  children?: ProjectFileNode[];
};

// The files of a project's file tree (`api.getFiles`), with their relative paths.
const flattenFileTree = (nodes: ProjectFileNode[], basePath = ''): MentionableFile[] =>
  nodes.flatMap((node) => {
    const nodePath = basePath ? `${basePath}/${node.name}` : node.name;
    if (node.type === 'directory') {
      return node.children ? flattenFileTree(node.children, nodePath) : [];
    }
    return [{ name: node.name, path: nodePath }];
  });

export function useFileMentions({ selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  const projectId = selectedProject?.projectId;
  // What the server found for the latest search, and in which project.
  const [found, setFound] = useState<{ projectId: string; files: MentionableFile[] } | null>(null);
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  // The text typed after `@`, or null while the caret is in no `@` query.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  // The highlighted file by path, so newer results do not move the highlight to another file.
  const [highlightedPath, setHighlightedPath] = useState<string | null>(null);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  // The search still in flight. Starting a new one aborts it, so an older
  // answer can never overwrite a newer one.
  const searchRequestRef = useRef<AbortController | null>(null);
  // The project the open dropdown has listed again; null while it is closed.
  const listedProjectRef = useRef<string | null>(null);
  // Projects on a node from before file search (Codey 0.3.8 and older), and
  // the file tree last loaded for one of them.
  const treeOnlyProjectsRef = useRef(new Set<string>());
  const loadedTreeRef = useRef<{ projectId: string; files: MentionableFile[] } | null>(null);

  // A project switch, or the composer going away, drops a search on its way.
  useEffect(() => () => searchRequestRef.current?.abort(), [projectId]);

  // A node from before file search serves its app page for the search route.
  // The shared UI also runs against such nodes, so `@` then filters the
  // project's whole file tree here, as it did before, loaded again with each
  // `@`. That still stops at the file tree's 10,000 entries.
  const searchProjectFiles = useCallback(async (
    targetProjectId: string,
    query: string,
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<MentionableFile[] | null> => {
    if (!treeOnlyProjectsRef.current.has(targetProjectId)) {
      const response = await api.searchFiles(
        targetProjectId,
        { query, limit: MENTION_SEARCH_LIMIT, refresh },
        { signal },
      );
      if (!response.ok && response.status !== 404) {
        console.error('Error searching files:', response.status);
        return null;
      }
      const body = response.ok
        ? (await response.json().catch(() => null)) as { files?: MentionableFile[] } | null
        : null;
      if (signal.aborted) {
        return null;
      }
      if (Array.isArray(body?.files)) {
        return body.files;
      }
      treeOnlyProjectsRef.current.add(targetProjectId);
    }

    let tree = loadedTreeRef.current;
    if (refresh || !tree || tree.projectId !== targetProjectId) {
      const response = await api.getFiles(targetProjectId, { signal });
      if (!response.ok) {
        console.error('Error fetching files:', response.status);
        return null;
      }
      tree = { projectId: targetProjectId, files: flattenFileTree((await response.json()) as ProjectFileNode[]) };
      loadedTreeRef.current = tree;
    }
    const lowerQuery = query.toLowerCase().replace(/\\/g, '/');
    return tree.files.filter((file) => file.path.toLowerCase().includes(lowerQuery)).slice(0, MENTION_SEARCH_LIMIT);
  }, []);

  useEffect(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    const textAfterAt = lastAtIndex === -1 ? null : textBeforeCursor.slice(lastAtIndex + 1);

    if (textAfterAt === null || textAfterAt.includes(' ')) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      setMentionQuery(null);
      return;
    }

    setAtSymbolPosition(lastAtIndex);
    setShowFileDropdown(true);
    setHighlightedPath(null);
    setMentionQuery(textAfterAt);
  }, [input, cursorPosition]);

  // The server searches the project's files: a large project's list is too
  // big to send to the browser, and it keeps the list between keystrokes.
  // Files keep appearing (uploads, agent edits, the terminal, git checkouts)
  // and nothing tells the composer about them, so the first search after each
  // `@` lists the project again. It starts at once; later ones wait for typing
  // to pause.
  useEffect(() => {
    if (!showFileDropdown) {
      listedProjectRef.current = null;
      return undefined;
    }
    if (mentionQuery === null || !projectId) {
      return undefined;
    }

    const refresh = listedProjectRef.current !== projectId;
    const timer = setTimeout(async () => {
      searchRequestRef.current?.abort();
      const abortController = new AbortController();
      searchRequestRef.current = abortController;
      listedProjectRef.current = projectId;

      try {
        const files = await searchProjectFiles(projectId, mentionQuery, refresh, abortController.signal);
        if (!files || abortController.signal.aborted) {
          return;
        }
        setFound({ projectId, files });
      } catch (error) {
        // Ignore aborts from newer searches and project switches; only the latest one counts.
        if ((error as { name?: string })?.name === 'AbortError') {
          return;
        }
        console.error('Error searching files:', error);
      }
    }, refresh ? 0 : MENTION_SEARCH_DELAY_MS);

    return () => clearTimeout(timer);
  }, [showFileDropdown, mentionQuery, projectId, searchProjectFiles]);

  // The files found, narrowed to what has been typed since: while the next
  // search is on its way the list follows typing at once, and it never offers
  // a file the query no longer matches.
  const filteredFiles = useMemo(() => {
    if (!showFileDropdown || mentionQuery === null || !found || found.projectId !== projectId) {
      return NO_FILES;
    }
    const query = mentionQuery.toLowerCase().replace(/\\/g, '/');
    return found.files.filter((file) => file.path.toLowerCase().includes(query));
  }, [found, mentionQuery, projectId, showFileDropdown]);

  const selectedFileIndex = highlightedPath === null
    ? -1
    : filteredFiles.findIndex((file) => file.path === highlightedPath);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const newInput = `${textBeforeAt}${file.path} ${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length + file.path.length + 1;

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (event.nativeEvent.isComposing || (event.key === 'Tab' &&
          (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey))) return false;
      if (!showFileDropdown) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        // The caret is still inside the `@` query. Only typing re-opens the
        // dropdown, which searches again, so the search on its way is dropped.
        searchRequestRef.current?.abort();
        setShowFileDropdown(false);
        return true;
      }

      if (filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedPath(
          filteredFiles[selectedFileIndex < filteredFiles.length - 1 ? selectedFileIndex + 1 : 0].path,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedPath(
          filteredFiles[selectedFileIndex > 0 ? selectedFileIndex - 1 : filteredFiles.length - 1].path,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        selectFile(filteredFiles[selectedFileIndex] ?? filteredFiles[0]);
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
