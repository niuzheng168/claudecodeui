import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { CodexGoalReadError, CodexSessionGoal } from '@/shared/types';

type GoalSnapshot = {
  sessionId: string;
  goal: CodexSessionGoal | null;
  loading: boolean;
  error: CodexGoalReadError | null;
};

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;
const MIN_REFRESH_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

function readGoal(value: unknown): CodexSessionGoal | null {
  if (value === null) return null;
  const goal = value as CodexSessionGoal | undefined;
  if (!goal || typeof goal.objective !== 'string'
    || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goal.status)
    || !(goal.tokenBudget === null || (Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0))
    || !Number.isFinite(goal.tokensUsed) || goal.tokensUsed < 0
    || !Number.isFinite(goal.timeUsedSeconds) || goal.timeUsedSeconds < 0) {
    throw new Error('Invalid native goal snapshot');
  }
  return {
    objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds,
  };
}

/**
 * ChatInterface reads persisted goals even when another client owns the run.
 * Only explicit status reads are sent: opening/reconnecting never starts,
 * resumes, pauses or takes over work, nor depends on paginated chat messages.
 */
export function useSessionGoal(sessionId: string | null, isActive: boolean) {
  const { subscribe } = useWebSocket();
  // Keep the last confirmed snapshot on transient failure, keyed by session
  // so navigation can never display a different conversation's goal.
  const [snapshot, setSnapshot] = useState<GoalSnapshot | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!sessionId || !isActive) return;
    const targetSessionId = sessionId;
    let disposed = false;
    let request: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshPending = false;
    let lastRequestAt = -Infinity;
    let activeGoal = false;

    const visible = () => document.visibilityState !== 'hidden';
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!disposed && visible()) timer = setTimeout(refresh, delay);
    };

    async function load() {
      const controller = new AbortController();
      request = controller;
      lastRequestAt = Date.now();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      setSnapshot((previous) => ({
        sessionId: targetSessionId,
        goal: previous?.sessionId === targetSessionId ? previous.goal : null,
        error: previous?.sessionId === targetSessionId ? previous.error : null,
        loading: true,
      }));
      let error: GoalSnapshot['error'] = 'unavailable';
      try {
        const response = await api.commands.goal(targetSessionId, 'status', { signal: controller.signal });
        // Older nodes may return an HTML 404 rather than a JSON error.
        const result = await response.json().catch(() => null);
        if (!response.ok) {
          if ([404, 405, 501].includes(response.status) && result?.code !== 'SESSION_NOT_FOUND') {
            error = 'unsupported';
          }
          throw new Error('Goal status unavailable');
        }
        const goal = readGoal(result?.goal);
        if (disposed) return;
        activeGoal = goal?.status === 'active';
        setSnapshot({ sessionId: targetSessionId, goal, loading: false, error: null });
      } catch {
        if (!disposed) {
          setSnapshot((previous) => ({
            sessionId: targetSessionId,
            goal: previous?.sessionId === targetSessionId ? previous.goal : null,
            loading: false,
            error,
          }));
        }
      } finally {
        clearTimeout(timeout);
        request = null;
        if (!disposed) {
          schedule(refreshPending ? MIN_REFRESH_MS : activeGoal ? ACTIVE_POLL_MS : IDLE_POLL_MS);
          refreshPending = false;
        }
      }
    }

    function refresh() {
      if (disposed || !visible()) return;
      if (request) {
        // A completion/reconnect received during a read needs one fresh read,
        // not concurrent requests whose replies can arrive out of order.
        refreshPending = true;
        return;
      }
      clearTimeout(timer);
      const wait = Math.min(MIN_REFRESH_MS, MIN_REFRESH_MS - (Date.now() - lastRequestAt));
      if (wait > 0) schedule(wait);
      else void load();
    }

    const unsubscribe = subscribe((event) => {
      if (event.kind === 'websocket_reconnected'
        || (event.sessionId === targetSessionId
          && ['chat_subscribed', 'complete', 'session_upserted', 'history_truncated'].includes(event.kind ?? ''))) {
        refresh();
      }
      // Goal controls can themselves emit task_notification rows. Refetching
      // those would create a status-read → notification → status-read loop.
    });
    refreshRef.current = refresh;
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      request?.abort();
      unsubscribe();
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      refreshRef.current = () => {};
    };
  }, [isActive, sessionId, subscribe]);

  const refresh = useCallback(() => refreshRef.current(), []);
  const current = sessionId && snapshot?.sessionId === sessionId ? snapshot : null;
  return {
    goal: current?.goal ?? null,
    loading: current?.loading ?? false,
    error: current?.error ?? null,
    refresh,
  };
}
