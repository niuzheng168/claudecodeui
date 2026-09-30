import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM, isCodeyPortalSso, withDeploymentBasePath } from '@/shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

const RECONNECT_DELAY_MS = 3_000;
const CONNECT_TIMEOUT_MS = 10_000;

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socketPath = withDeploymentBasePath('/ws');
  if (IS_PLATFORM || isCodeyPortalSso()) return `${protocol}//${window.location.host}${socketPath}`;
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}${socketPath}?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  // Includes a connecting socket so lifecycle/auth changes can retire it.
  const wsRef = useRef<WebSocket | null>(null);
  // Later opens must notify consumers to catch up on events missed offline.
  const hasConnectedRef = useRef(false);
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  // Publish socket identity, not just a boolean: React can batch close/open,
  // but session subscriptions still need to see the replacement transport.
  const [connectedSocket, setConnectedSocket] = useState<WebSocket | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  useEffect(() => {
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    let disposed = false;
    let wasHidden = document.visibilityState === 'hidden';
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    const retireSocket = () => {
      clearTimeout(connectTimer);
      const activeSocket = wsRef.current;
      wsRef.current = null;
      setConnectedSocket(null);
      if (activeSocket) {
        // Retired sockets must neither dispatch late frames nor start a
        // second retry loop after foreground recovery or a token refresh.
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
      }
    };

    const retry = () => {
      retireSocket();
      clearTimeout(reconnectTimer);
      if (!disposed) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    function connect() {
      if (disposed) return;
      clearTimeout(reconnectTimer);
      retireSocket();
      try {
        const wsUrl = buildWebSocketUrl(token);
        if (!wsUrl) return;
        const websocket = new WebSocket(wsUrl);
        wsRef.current = websocket;
        const isCurrent = () => !disposed && wsRef.current === websocket;

        // A suspended/network-stalled handshake need not emit close promptly.
        connectTimer = setTimeout(() => {
          if (isCurrent()) retry();
        }, CONNECT_TIMEOUT_MS);

        websocket.onopen = () => {
          if (!isCurrent()) return;
          clearTimeout(connectTimer);
          setConnectedSocket(websocket);
          if (hasConnectedRef.current) {
            dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
          }
          hasConnectedRef.current = true;
        };
        websocket.onmessage = (event) => {
          if (!isCurrent()) return;
          try {
            dispatch(JSON.parse(event.data) as ServerEvent);
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        };
        websocket.onclose = () => {
          if (isCurrent()) retry();
        };
        websocket.onerror = (error) => {
          if (isCurrent()) console.error('WebSocket error:', error);
        };
      } catch (error) {
        console.error('Error creating WebSocket connection:', error);
        retry();
      }
    }

    const recoverConnection = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true;
        return;
      }
      // Coalesce visibility/focus/online/pageshow bursts behind the fresh
      // handshake, but never reuse a handshake suspended in the background.
      if (!wasHidden && wsRef.current?.readyState === WebSocket.CONNECTING) return;
      wasHidden = false;
      connect();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden = true;
      } else if (wasHidden) {
        // readyState may still be OPEN on a dead mobile transport. Do not wait
        // for heartbeat/TCP timeouts; replacing only the socket leaves the
        // server-owned run alone and never replays chat.send.
        recoverConnection();
      }
    };
    const handleFocus = () => {
      if (wasHidden || !wsRef.current || wsRef.current.readyState >= WebSocket.CLOSING) {
        recoverConnection();
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) recoverConnection();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', recoverConnection);
    window.addEventListener('pageshow', handlePageShow);
    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      retireSocket();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', recoverConnection);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [dispatch, isAuthLoading, token, user]);

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: connectedSocket,
    sendMessage,
    subscribe,
    isConnected: connectedSocket !== null,
  }), [connectedSocket, sendMessage, subscribe]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
