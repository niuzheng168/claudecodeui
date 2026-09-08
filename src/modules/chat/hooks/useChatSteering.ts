import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { SteerChatMessage } from '@/shared/types';

type PendingSteer = {
  requestId: string;
  sessionId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SessionSteeringCapability = {
  runId: string | null;
  unavailableReason: 'unavailable' | 'upgradeRequired' | null;
};

// Longer than the daemon's acknowledgement deadline; never automatically retry.
const STEER_TIMEOUT_MS = 15_000;

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
    pending.reject(error);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      failPending(new Error(unconfirmedMessageRef.current));
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
      const pending = pendingRef.current;
      if (!pending || event.requestId !== pending.requestId || sid !== pending.sessionId) return;
      if (event.accepted !== true) {
        failPending(new Error(t(`input.steer.errors.${String(event.code)}`, {
          defaultValue: String(event.error || t('input.steer.failed')),
        })));
      } else {
        pendingRef.current = null;
        clearTimeout(pending.timer);
        pending.resolve();
      }
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
    };
    setSessionCapabilities((previous) => {
      if (event.kind === 'complete' && !previous.has(sid)) return previous;
      const current = previous.get(sid);
      if (event.kind !== 'complete' && current?.runId === capability.runId
        && current.unavailableReason === capability.unavailableReason) return previous;
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
  }), [failPending, subscribe, t]);

  useEffect(() => {
    if (isConnected) return;
    failPending(new Error(t('input.steer.unconfirmed')));
  }, [failPending, isConnected, t]);

  const steerMessage = useCallback<SteerChatMessage>((targetSessionId, content, attachments) => {
    if (!mountedRef.current || !connectedRef.current) {
      return Promise.reject(new Error(t('input.steer.disconnected')));
    }
    if (pendingRef.current) {
      return Promise.reject(new Error(t('input.steer.pending')));
    }
    // This closure is captured by the composer BEFORE uploading attachments.
    // A newer capability update must not redirect that submission to a new run.
    const expectedRunId = sessionCapabilities.get(targetSessionId)?.runId;
    if (!expectedRunId) {
      return Promise.reject(new Error(t('input.steer.errors.STEER_UNAVAILABLE')));
    }
    return new Promise<void>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => failPending(new Error(t('input.steer.unconfirmed'))), STEER_TIMEOUT_MS);
      pendingRef.current = { requestId, sessionId: targetSessionId, resolve, reject, timer };
      try {
        sendMessage({
          type: 'chat.steer', requestId, expectedRunId, sessionId: targetSessionId, content,
          options: { attachments },
        });
      } catch (error) {
        failPending(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }, [failPending, sendMessage, sessionCapabilities, t]);

  const capability = sessionId ? sessionCapabilities.get(sessionId) : undefined;
  const canSteer = isConnected && Boolean(capability?.runId);
  return {
    canSteer,
    unavailableReason: canSteer ? null : t(!isConnected ? 'input.steer.disconnected'
      : `input.steer.${capability?.unavailableReason ?? 'checking'}`),
    steerMessage,
  };
}
