import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import { api } from '@/shared/api';
import type { ServerEvent, SteerChatMessage } from '@/shared/types';

type PendingSteer = {
  requestId: string;
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  controller?: AbortController;
};

type SessionSteeringCapability = {
  runId: string | null;
  unavailableReason: 'unavailable' | 'upgradeRequired' | null;
  queued: boolean;
};

// Longer than the daemon's acknowledgement deadline; never automatically retry.
const STEER_TIMEOUT_MS = 15_000;

function unconfirmedError(message: string): Error {
  return Object.assign(new Error(message), { queueHeld: true });
}

/** ChatInterface uses this to discover native steering and await one correlated acknowledgement without affecting the run. */
export function useChatSteering(sessionId: string | null) {
  const { sendMessage, subscribe, isConnected } = useWebSocket();
  const { t } = useTranslation('chat');
  // Keep the reason as well as the run token so old nodes do not silently hide the action.
  const [sessionCapabilities, setSessionCapabilities] = useState<ReadonlyMap<string, SessionSteeringCapability>>(() => new Map());
  // Reconnecting must never briefly reuse a run token from the previous connection.
  if (!isConnected && sessionCapabilities.size > 0) setSessionCapabilities(new Map());
  // The pending request outlives a session switch, so only its matching ack can settle it.
  const pendingRef = useRef<PendingSteer | null>(null);
  const connectedRef = useRef(isConnected);
  const mountedRef = useRef(false);
  const unconfirmedMessageRef = useRef(t('input.steer.unconfirmed'));
  useLayoutEffect(() => {
    connectedRef.current = isConnected;
    unconfirmedMessageRef.current = t('input.steer.unconfirmed');
  }, [isConnected, t]);

  const failPending = useCallback((error: Error) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    clearTimeout(pending.timer);
    // Aborting a queue HTTP request does not interrupt the native chat turn.
    pending.controller?.abort();
    pending.reject(error);
  }, []);

  const receiveSteerResult = useCallback((event: ServerEvent) => {
    const pending = pendingRef.current;
    if (!pending || event.requestId !== pending.requestId || event.sessionId !== pending.sessionId) return;
    if (event.accepted !== true) {
      const message = event.queueHeld === true ? t('input.queue.reviewHint')
        : t(`input.steer.errors.${String(event.code)}`, {
          defaultValue: String(event.error || t('input.steer.failed')),
        });
      failPending(Object.assign(new Error(message), { queueHeld: event.queueHeld === true }));
    } else {
      pendingRef.current = null;
      clearTimeout(pending.timer);
      pending.resolve();
    }
  }, [failPending, t]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      failPending(unconfirmedError(unconfirmedMessageRef.current));
    };
  }, [failPending]);

  useEffect(() => subscribe((event) => {
    if (event.kind === 'websocket_reconnected') {
      // A disconnected socket may have missed completion/new-run events.
      // Wait for a fresh subscribe ack instead of reusing old capabilities.
      setSessionCapabilities((previous) => previous.size ? new Map() : previous);
      return;
    }
    const sid = typeof event.sessionId === 'string' ? event.sessionId : null;
    if (event.kind === 'chat_steer_result') {
      receiveSteerResult(event);
      return;
    }
    if (!sid) return;
    const isCapabilityEvent = event.kind === 'chat_subscribed'
      || (event.kind === 'status' && typeof event.canSteer === 'boolean')
      || event.kind === 'complete';
    if (!isCapabilityEvent) return;
    const runId = typeof event.runId === 'string' && event.runId ? event.runId : null;
    const enabled = Boolean(runId && event.kind !== 'complete' && event.canSteer === true
      && (event.kind !== 'chat_subscribed' || event.isProcessing === true));
    const capability: SessionSteeringCapability = {
      runId: enabled ? runId : null,
      unavailableReason: enabled ? null
        : typeof event.canSteer !== 'boolean' || (event.canSteer && !runId) ? 'upgradeRequired' : 'unavailable',
      queued: enabled && event.canSteerQueued === true,
    };
    setSessionCapabilities((previous) => {
      if (event.kind === 'complete' && !previous.has(sid)) return previous;
      const current = previous.get(sid);
      if (event.kind !== 'complete' && current?.runId === capability.runId
        && current.unavailableReason === capability.unavailableReason && current.queued === capability.queued) return previous;
      const next = new Map(previous);
      // Old backends cannot send a capability status on the next turn either.
      // Keep their upgrade explanation until a fresh subscribe/status or reconnect.
      if (event.kind === 'complete') {
        if (current?.unavailableReason !== 'upgradeRequired') next.delete(sid);
      } else {
        next.set(sid, capability);
      }
      return next;
    });
  }), [receiveSteerResult, subscribe]);

  useEffect(() => {
    if (isConnected) return;
    failPending(unconfirmedError(t('input.steer.unconfirmed')));
  }, [failPending, isConnected, t]);

  const steerMessage = useCallback<SteerChatMessage>((targetSessionId, content, attachments, queuedMessage) => {
    if (!mountedRef.current || !connectedRef.current) {
      return Promise.reject(new Error(t('input.steer.disconnected')));
    }
    if (pendingRef.current) {
      return Promise.reject(new Error(t('input.steer.pending')));
    }
    // Captured before waiting for the queued save (or legacy uploads). A newer
    // capability update must not redirect the receipt to a different native run.
    const expectedRunId = sessionCapabilities.get(targetSessionId)?.runId;
    if (!expectedRunId) {
      return Promise.reject(new Error(t('input.steer.errors.STEER_UNAVAILABLE')));
    }
    if (queuedMessage && !sessionCapabilities.get(targetSessionId)?.queued) {
      return Promise.reject(new Error(t('input.steer.upgradeRequired')));
    }
    return new Promise<void>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => failPending(unconfirmedError(t('input.steer.unconfirmed'))), STEER_TIMEOUT_MS);
      const controller = queuedMessage ? new AbortController() : undefined;
      pendingRef.current = { requestId, sessionId: targetSessionId, resolve, reject, timer, controller };
      try {
        if (queuedMessage) {
          void api.user.steerQueuedDraft(targetSessionId, {
            requestId, expectedRunId, queuedMessage,
          }, controller?.signal).then(async (response) => {
            if (pendingRef.current?.requestId !== requestId) return;
            if ([404, 501].includes(response.status)) {
              failPending(new Error(t('input.steer.upgradeRequired')));
              return;
            }
            if (!response.ok) throw unconfirmedError(t('input.steer.unconfirmed'));
            const event = await response.json() as ServerEvent;
            if (event.requestId !== requestId || event.sessionId !== targetSessionId
              || typeof event.accepted !== 'boolean') throw unconfirmedError(t('input.steer.unconfirmed'));
            receiveSteerResult(event);
          }).catch(() => {
            if (pendingRef.current?.requestId === requestId) failPending(unconfirmedError(t('input.steer.unconfirmed')));
          });
          return;
        }
        sendMessage({
          type: 'chat.steer', requestId, expectedRunId, sessionId: targetSessionId, content,
          options: { attachments },
        });
      } catch (error) {
        failPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }, [failPending, receiveSteerResult, sendMessage, sessionCapabilities, t]);

  const capability = sessionId ? sessionCapabilities.get(sessionId) : undefined;
  const canSteer = isConnected && Boolean(capability?.runId);
  const unavailableReason = canSteer ? null : t(!isConnected ? 'input.steer.disconnected'
    : `input.steer.${capability?.unavailableReason ?? 'checking'}`);
  return {
    runId: capability?.runId ?? null,
    canSteer,
    unavailableReason,
    canSteerQueued: canSteer && capability?.queued === true,
    queuedUnavailableReason: canSteer && !capability?.queued ? t('input.steer.upgradeRequired') : unavailableReason,
    steerMessage,
  };
}
