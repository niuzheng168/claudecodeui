import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiRequestError, readPortalJson } from '@/shared/api';
import type { ServerEvent, SharedSessionLive } from '@/shared/types';

/** While a turn runs the page follows it once a second. */
const RUNNING_POLL_MS = 1000;
/** With no turn running, after a failure, and on a machine without live support. */
const IDLE_POLL_MS = 5000;

/** What a poll says about the session, without the events, which go to the transcript. */
type SharedSessionLiveState = Omit<SharedSessionLive, 'events' | 'reset' | 'more'>;

type UseSharedSessionLiveArgs = {
  /** The grant's Portal API root, `/api/v1/shared/<grantId>`. */
  apiRoot: string;
  /** Stamped on every event, so the transcript files it under the session it renders. */
  sessionId: string;
  /** The events no longer account for everything history may hold: re-read its newest page. */
  onHistoryStale: () => void;
  /** The Portal answered 401 (the login expired) or 404 (the grant is gone); polling stops for good. */
  onAccessLost: (error: ApiRequestError) => void;
};

const readArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

/** The poll's answer with its lists and flags made safe to read, whatever an older Portal left out. */
function normalizeLive(value: SharedSessionLive): SharedSessionLive {
  return {
    supported: value.supported !== false,
    online: value.online !== false,
    run: value.run && typeof value.run.id === 'string' ? value.run : null,
    events: readArray<ServerEvent>(value.events).filter((event) => event && typeof event === 'object'),
    reset: value.reset === true,
    more: value.more === true,
    background: value.background === true,
    permissions: readArray(value.permissions),
    waitingForOwner: value.waitingForOwner === true,
    messages: readArray(value.messages),
  };
}

/**
 * Polls `GET <api>/live` for a shared session (codey
 * docs/codey-shared-sessions.md §5–6) and turns it into what the chat page
 * gets from its websocket: the run's events, delivered in order through
 * `subscribe`, plus the run, approvals and outgoing messages as state.
 *
 * It polls every second while a turn runs and every five seconds otherwise,
 * not at all while the tab is hidden; coming back re-reads history, since
 * whatever ran meanwhile may have left the live buffer. It follows one run at
 * a time by `runId` and `afterSeq`: a run it did not see start is replayed
 * from its first event — unless it had already ended before the page opened,
 * when the history read covers it.
 */
export function useSharedSessionLive({ apiRoot, sessionId, onHistoryStale, onAccessLost }: UseSharedSessionLiveArgs) {
  const listenersRef = useRef(new Set<(event: ServerEvent) => void>());
  // The latest callbacks, read by the polling loop without restarting it.
  const callbacksRef = useRef({ onHistoryStale, onAccessLost });
  const pollNowRef = useRef<() => void>(() => {});
  // The last poll's answer, minus its events: drives the stop button, the approvals and the outbox.
  const [live, setLive] = useState<SharedSessionLiveState | null>(null);
  // Why the last poll failed; cleared by the next one that succeeds.
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    callbacksRef.current = { onHistoryStale, onAccessLost };
  }, [onAccessLost, onHistoryStale]);

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let pollAgain = false;
    // Where the transcript stands: the run followed and the last event it was given.
    let runId: string | null = null;
    let afterSeq = 0;
    let runEnded = false;
    // When this page first saw the followed run: its start time when the machine reports none.
    let runSeenAt = 0;
    // Whether a poll has reached the owner's machine yet.
    let primed = false;

    const historyStale = () => callbacksRef.current.onHistoryStale();

    const emit = (events: ServerEvent[]) => {
      for (const event of events) {
        if (typeof event.seq === 'number') {
          // A retried poll can return events already handed over.
          if (event.seq <= afterSeq) continue;
          afterSeq = event.seq;
        }
        if (event.kind === 'complete') {
          runEnded = true;
        }
        const routed: ServerEvent = { ...event, sessionId };
        for (const listener of [...listenersRef.current]) {
          listener(routed);
        }
      }
    };

    const follow = (result: SharedSessionLive) => {
      const run = result.run;
      if (!run) {
        // The run followed aged out (or the machine restarted) without this
        // page seeing it end; only history knows how it finished.
        if (runId && !runEnded) {
          historyStale();
        }
        runId = null;
        afterSeq = 0;
        runEnded = false;
        return;
      }

      if (run.id !== runId) {
        const endedBeforePageOpened = !primed && run.status !== 'running';
        runId = run.id;
        afterSeq = 0;
        runEnded = false;
        runSeenAt = Date.now();
        if (endedBeforePageOpened) {
          // The first history read covers it; replaying it would only stack
          // live copies on persisted rows. One refresh in case that read
          // raced the turn's last writes.
          afterSeq = result.events.reduce(
            (highest, event) => (typeof event.seq === 'number' ? Math.max(highest, event.seq) : highest),
            Number.isFinite(run.lastSeq) ? run.lastSeq : 0,
          );
          runEnded = true;
          historyStale();
          return;
        }
        if (primed) {
          // A turn that started since the last poll. The owner's own prompt is
          // not among its events (their page shows it as typed), only in history.
          historyStale();
        }
      }

      emit(result.events);
      if (result.reset) {
        historyStale();
      }
    };

    const schedule = (delayMs: number) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (disposed || stopped || document.visibilityState === 'hidden') {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, delayMs);
    };

    const poll = async () => {
      if (disposed || stopped) return;
      if (inFlight) {
        pollAgain = true;
        return;
      }
      inFlight = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      let delayMs = IDLE_POLL_MS;
      try {
        const response = await api.sharedSession.live(apiRoot, runId ? { runId, afterSeq } : {});
        const body = await readPortalJson<SharedSessionLive>(response);
        if (disposed) return;
        if (!body || typeof body !== 'object') {
          throw new Error(`Unexpected response (${response.status})`);
        }
        const result = normalizeLive(body);

        if (!result.supported) {
          // An older Codey on the owner's machine: re-reading history every
          // few seconds is all there is.
          runId = null;
          afterSeq = 0;
          historyStale();
        } else if (result.online) {
          follow(result);
          primed = true;
          delayMs = result.more ? 0 : result.run?.status === 'running' ? RUNNING_POLL_MS : IDLE_POLL_MS;
        }

        const run = result.run && !(typeof result.run.startedAt === 'number' && result.run.startedAt > 0)
          ? { ...result.run, startedAt: runSeenAt || Date.now() }
          : result.run;
        const state: SharedSessionLiveState = {
          supported: result.supported,
          online: result.online,
          run,
          background: result.background,
          permissions: result.permissions,
          waitingForOwner: result.waitingForOwner,
          messages: result.messages,
        };
        // Most polls change nothing; keep the old object so nothing re-renders.
        setLive((previous) => (JSON.stringify(previous) === JSON.stringify(state) ? previous : state));
        setPollError(null);
      } catch (error) {
        if (disposed) return;
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 404)) {
          stopped = true;
          callbacksRef.current.onAccessLost(error);
          return;
        }
        setPollError(error instanceof Error ? error.message : String(error));
      } finally {
        inFlight = false;
        if (!disposed && !stopped) {
          if (pollAgain) {
            pollAgain = false;
            schedule(0);
          } else {
            schedule(delayMs);
          }
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      // Whatever ran while the tab was hidden may have left the live buffer.
      historyStale();
      void poll();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    pollNowRef.current = () => {
      void poll();
    };
    void poll();

    return () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      pollNowRef.current = () => {};
    };
  }, [apiRoot, sessionId]);

  /** Polls at once, after the viewer sent, stopped or answered something. */
  const pollNow = useCallback(() => {
    pollNowRef.current();
  }, []);

  return { live, pollError, subscribe, pollNow };
}
