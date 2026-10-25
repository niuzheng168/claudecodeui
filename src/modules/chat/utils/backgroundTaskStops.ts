import { useSyncExternalStore } from 'react';

/**
 * What this page knows about a session's background tasks beyond the
 * transcript: the stops it has asked for, the tasks the server said are not
 * running, and the tasks the user hid from the strip.
 *
 * A launch row can stay "running" after its task ended: its notification
 * arrived while this page was disconnected (a phone asleep), and a refresh of
 * the latest page does not re-read rows further back. The server's refusal
 * of a stop — it tracks no such task — is then the only word the page gets,
 * so the task is no longer listed.
 */
export type BackgroundTaskStops = {
  /** Asked to stop and not answered yet. */
  stopping: ReadonlySet<string>;
  /** The server tracks no such task: it has ended. */
  ended: ReadonlySet<string>;
  /** Hidden from the strip by the user; shown again when another task starts. */
  hidden: ReadonlySet<string>;
};

/** Long enough for any answer; an older stop is not what a refusal answers. */
const STOP_ANSWER_MS = 30_000;

type SessionState = BackgroundTaskStops & { requests: Array<{ taskId: string; at: number }> };

const EMPTY: BackgroundTaskStops = Object.freeze({ stopping: new Set<string>(), ended: new Set<string>(), hidden: new Set<string>() });
const sessions = new Map<string, SessionState>();
const listeners = new Set<() => void>();

function update(sessionId: string, change: (state: SessionState) => Partial<SessionState>): void {
  const current = sessions.get(sessionId) ?? { ...EMPTY, requests: [] };
  sessions.set(sessionId, { ...current, ...change(current) });
  listeners.forEach((listener) => listener());
}

function pending(state: SessionState, now: number) {
  return state.requests.filter((request) => now - request.at < STOP_ANSWER_MS);
}

function withStopping(requests: SessionState['requests']) {
  return { requests, stopping: new Set(requests.map((request) => request.taskId)) };
}

/** Records a `chat.stop-task` sent for one of the session's tasks. */
export function recordTaskStopRequest(sessionId: string, taskId: string, now = Date.now()): void {
  update(sessionId, (state) => withStopping([...pending(state, now).filter((request) => request.taskId !== taskId), { taskId, at: now }]));
}

/**
 * The server refused a stop because it tracks no such task. It names the task;
 * a node from before that answers the oldest stop still waiting, as it handles
 * a socket's requests in order.
 */
export function recordRefusedTaskStop(sessionId: string, taskId?: string, now = Date.now()): void {
  update(sessionId, (state) => {
    const requests = pending(state, now);
    const refused = taskId ?? requests[0]?.taskId;
    if (!refused) {
      return {};
    }
    const ended = new Set(state.ended);
    ended.add(refused);
    return { ...withStopping(requests.filter((request) => request.taskId !== refused)), ended };
  });
}

/** Hides the tasks listed now; a task that starts later shows the strip again. */
export function hideBackgroundTasks(sessionId: string, taskIds: string[]): void {
  update(sessionId, (state) => ({ hidden: new Set([...state.hidden, ...taskIds]) }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readBackgroundTaskStops(sessionId: string | null): BackgroundTaskStops {
  return (sessionId && sessions.get(sessionId)) || EMPTY;
}

export function useBackgroundTaskStops(sessionId: string | null): BackgroundTaskStops {
  return useSyncExternalStore(subscribe, () => readBackgroundTaskStops(sessionId));
}

/** For tests: forgets every session. */
export function resetBackgroundTaskStops(): void {
  sessions.clear();
  listeners.forEach((listener) => listener());
}
