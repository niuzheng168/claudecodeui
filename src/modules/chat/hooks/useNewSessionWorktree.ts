import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project, WorktreeInfo } from '@/shared/types';

/**
 * The new session page's "start in a new worktree" choice. It is offered when
 * the open directory is in a git repository; the composer asks `prepare` for
 * the directory to start the session in when the first message goes out.
 */
export type NewSessionWorktree = {
  available: boolean;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** The new branch's name as typed; blank means one is made up at send time. */
  branch: string;
  setBranch: (branch: string) => void;
  /** What the new branch starts from: the branch the open directory has checked out. */
  baseBranch: string | null;
  creating: boolean;
  /** The project of a new worktree when the choice is on, null otherwise; throws when git refuses. */
  prepare: () => Promise<Project | null>;
};

type WorktreeListPayload = {
  data?: { repositoryRoot?: string; baseBranch?: string | null; worktrees?: WorktreeInfo[] };
};

type WorktreeCreatePayload = {
  data?: { project?: Project };
  error?: { message?: string; details?: unknown };
};

const pad = (value: number) => String(value).padStart(2, '0');

/** `codey/261029-171502`: unique enough that it never lands on an existing branch. */
export function generatedWorktreeBranch(now = new Date()): string {
  const date = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `codey/${date}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function useNewSessionWorktree(selectedProject: Project | null, isNewSession: boolean): NewSessionWorktree {
  const projectId = isNewSession ? selectedProject?.projectId ?? null : null;
  const [repository, setRepository] = useState<{ projectId: string; baseBranch: string | null } | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [branch, setBranch] = useState('');
  const [creating, setCreating] = useState(false);
  // A worktree made for a send whose session then failed to start is used
  // again by the next try, rather than leaving one behind per attempt.
  const createdRef = useRef<{ key: string; project: Project } | null>(null);

  useEffect(() => {
    setEnabled(false);
    setBranch('');
    createdRef.current = null;
    if (!projectId) {
      setRepository(null);
      return undefined;
    }
    let cancelled = false;
    // Not a repository answers 400; a node without the route answers its app page.
    api.worktrees.list(projectId)
      .then((response) => (response.ok ? response.json() as Promise<WorktreeListPayload> : null))
      .then((payload) => {
        if (cancelled) return;
        const data = payload?.data;
        if (!data?.repositoryRoot) {
          setRepository(null);
          return;
        }
        const current = data.worktrees?.find((worktree) => worktree.isCurrent);
        setRepository({ projectId, baseBranch: current?.branch ?? data.baseBranch ?? null });
      })
      .catch(() => {
        if (!cancelled) setRepository(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const available = Boolean(projectId && repository?.projectId === projectId);
  const stateRef = useRef({ available, enabled, branch, projectId, baseBranch: repository?.baseBranch ?? null });
  stateRef.current = { available, enabled, branch, projectId, baseBranch: repository?.baseBranch ?? null };

  const prepare = useCallback(async (): Promise<Project | null> => {
    const state = stateRef.current;
    if (!state.available || !state.enabled || !state.projectId) return null;
    const typed = state.branch.trim();
    const key = `${state.projectId}\n${typed}`;
    if (createdRef.current?.key === key) return createdRef.current.project;

    setCreating(true);
    try {
      const response = await api.worktrees.create(state.projectId, {
        branch: typed || generatedWorktreeBranch(),
        baseBranch: state.baseBranch,
      });
      const payload = await response.json().catch(() => ({})) as WorktreeCreatePayload;
      const project = payload.data?.project;
      if (!response.ok || !project?.projectId) {
        const details = typeof payload.error?.details === 'string' ? `: ${payload.error.details}` : '';
        throw new Error(`${payload.error?.message || `HTTP ${response.status}`}${details}`);
      }
      createdRef.current = { key, project };
      return project;
    } finally {
      setCreating(false);
    }
  }, []);

  return {
    available,
    enabled: available && enabled,
    setEnabled,
    branch,
    setBranch,
    baseBranch: repository?.baseBranch ?? null,
    creating,
    prepare,
  };
}
