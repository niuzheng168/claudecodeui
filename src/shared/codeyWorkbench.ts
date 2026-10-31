import { useEffect, useSyncExternalStore } from 'react';

/**
 * The Codey Workbench embeds this app in same-origin frames and lists the
 * sessions itself. For a new session it knows what this app cannot: the
 * directories, on any of the user's machines, the session may start in. It
 * posts them to the frame so the new session page can offer them under the
 * model card; a pick goes back to the Workbench, which opens the page again in
 * that directory (on another machine that is another Workspace).
 *
 * `data-codey-workbench-directories` on <html> tells the Workbench this build
 * shows the directories itself. Builds without it get the Workbench's own bar
 * above the frame instead.
 *
 * The Workbench keeps one frame per machine and switches it to another session
 * of its machine, or to the new session page of one of its projects, by asking
 * it to, so the app is not loaded again and only the conversation changes.
 * `data-codey-workbench-navigation` says this build opens sessions when asked,
 * `data-codey-workbench-new-session` that it opens new session pages; the
 * Workbench loads the page at the new address for builds without them.
 * `data-codey-workbench-ready` is there while the workspace is drawn, past its
 * loading screen: a frame that is still loading stays out of sight until then.
 */

export type WorkbenchDirectory = {
  machine: string;
  /** The directory's project name on its machine. */
  name: string;
  path: string;
  /** The worktree's label when the directory is a linked worktree, otherwise empty. */
  worktree: string;
  /** False while the machine cannot be reached: listed, but not offered. */
  available: boolean;
};

export type WorkbenchDirectories = {
  directories: WorkbenchDirectory[];
  /** Index of the directory this page was opened in. */
  selected: number;
};

/** A project of this machine the Workbench asks to start a new session in. */
export type WorkbenchNewSession = {
  projectId: string;
  /** Explicit Portal placement carried to the native memory hook on the first send. */
  workbenchProjectId?: string;
  /** The project's directory and name, for a project this page has not listed yet. */
  path: string;
  name: string;
};

export const WORKBENCH_DIRECTORIES_MESSAGE = 'codey-workbench:new-session-directories';
export const WORKBENCH_CHOOSE_DIRECTORY_MESSAGE = 'codey-workbench:choose-new-session-directory';
export const WORKBENCH_OPEN_SESSION_MESSAGE = 'codey-workbench:open-session';
export const WORKBENCH_NEW_SESSION_MESSAGE = 'codey-workbench:new-session';
const PAGE_MARK = 'codeyWorkbenchDirectories';
const NAVIGATION_MARK = 'codeyWorkbenchNavigation';
const NEW_SESSION_MARK = 'codeyWorkbenchNewSession';
const READY_MARK = 'codeyWorkbenchReady';

let current: WorkbenchDirectories | null = null;
const listeners = new Set<() => void>();
const openSessionListeners = new Set<(sessionId: string) => void>();
const newSessionListeners = new Set<(request: WorkbenchNewSession) => void>();
let readyHolders = 0;

function readDirectory(value: unknown): WorkbenchDirectory | null {
  if (!value || typeof value !== 'object') return null;
  const { machine, name, path, worktree, available } = value as Record<string, unknown>;
  if (typeof machine !== 'string' || typeof name !== 'string' || typeof path !== 'string') return null;
  return {
    machine,
    name,
    path,
    worktree: typeof worktree === 'string' ? worktree : '',
    available: available !== false,
  };
}

/** The directories a message offers; anything else (the Workbench sends `directories: null`) clears them. */
function readDirectories(data: Record<string, unknown>): WorkbenchDirectories | null {
  if (!Array.isArray(data.directories)) return null;
  const directories = data.directories.map(readDirectory);
  const { selected } = data;
  if (directories.some((directory) => !directory)) return null;
  if (typeof selected !== 'number' || !Number.isInteger(selected) || !directories[selected]) return null;
  return { directories: directories as WorkbenchDirectory[], selected };
}

function readNewSession(data: Record<string, unknown>): WorkbenchNewSession | null {
  const { projectId, path, name } = data;
  if (typeof projectId !== 'string' || !projectId) return null;
  return {
    projectId,
    ...(typeof data.workbenchProjectId === 'string' && /^p-[a-f0-9]{16}$/.test(data.workbenchProjectId)
      ? { workbenchProjectId: data.workbenchProjectId } : {}),
    path: typeof path === 'string' ? path : '',
    name: typeof name === 'string' ? name : '',
  };
}

function handleMessage(event: MessageEvent): void {
  // Only the page that embeds this one, on this origin, says where sessions may start.
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return;
  if (data.type === WORKBENCH_OPEN_SESSION_MESSAGE) {
    const { sessionId } = data;
    if (typeof sessionId === 'string' && sessionId) openSessionListeners.forEach((listener) => listener(sessionId));
    return;
  }
  if (data.type === WORKBENCH_NEW_SESSION_MESSAGE) {
    const request = readNewSession(data);
    if (request) newSessionListeners.forEach((listener) => listener(request));
    return;
  }
  if (data.type !== WORKBENCH_DIRECTORIES_MESSAGE) return;
  current = readDirectories(data);
  listeners.forEach((listener) => listener());
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', handleMessage);
  // Set while the bundle loads, so the Workbench can tell by the frame's `load` event.
  if (window.parent !== window) {
    document.documentElement.dataset[PAGE_MARK] = '';
    document.documentElement.dataset[NAVIGATION_MARK] = '';
    document.documentElement.dataset[NEW_SESSION_MARK] = '';
  }
}

/**
 * Calls `listener` with each session the Workbench asks this frame to open.
 * The workspace shell navigates to it, as its own sidebar does.
 */
export function onWorkbenchOpenSession(listener: (sessionId: string) => void): () => void {
  openSessionListeners.add(listener);
  return () => openSessionListeners.delete(listener);
}

/**
 * Calls `listener` with each project the Workbench asks this frame to start a
 * new session in. The workspace opens that project's new session page, as its
 * own sidebar's "New Session" does.
 */
export function onWorkbenchNewSession(listener: (request: WorkbenchNewSession) => void): () => void {
  newSessionListeners.add(listener);
  return () => newSessionListeners.delete(listener);
}

/** Marks the page ready for the Workbench while the calling component, the drawn workspace, is mounted. */
export function useWorkbenchPageReady(): void {
  useEffect(() => {
    if (window.parent === window) return undefined;
    readyHolders += 1;
    document.documentElement.dataset[READY_MARK] = '';
    return () => {
      readyHolders -= 1;
      if (!readyHolders) delete document.documentElement.dataset[READY_MARK];
    };
  }, []);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => current;

/** The directories the Workbench offers for the new session on this page, or null outside the Workbench. */
export function useWorkbenchDirectories(): WorkbenchDirectories | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Asks the Workbench to open the new session page in another of the directories it offered. */
export function chooseWorkbenchDirectory(index: number): void {
  window.parent.postMessage({ type: WORKBENCH_CHOOSE_DIRECTORY_MESSAGE, index }, window.location.origin);
}
