import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChatMessage, DiffLine, LLMProvider, PendingPermissionRequest, ServerEvent } from '@/shared/types';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';

/** Approvals come from the caller, never from the event stream, so the realtime handler is given nowhere to put them. */
const NO_PERMISSION_REQUESTS: PendingPermissionRequest[] = [];
const ignorePermissionRequests = () => {};
const ignoreTokenBudget = () => {};

type UseRemoteSessionTranscriptArgs = {
  /** The CloudCLI session id the history endpoint and the live events are keyed by. */
  sessionId: string;
  provider: LLMProvider;
  /**
   * Delivers the run's live events — the chat websocket's NormalizedMessage
   * frames — from whatever transport the caller reads them over.
   */
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
};

type RemoteSessionTranscript = {
  chatMessages: ChatMessage[];
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  /** True until the first history page has been read (or failed). */
  isLoading: boolean;
  isLoadingEarlier: boolean;
  hasEarlier: boolean;
  historyError: string | null;
  loadEarlier: () => Promise<void>;
  /** Re-reads the newest history, merging it under the live rows. */
  refreshLatest: () => Promise<void>;
  /** Reads the newest page from scratch, after a failed first read. */
  reload: () => Promise<void>;
};

/**
 * A session's transcript for a page that has no chat websocket: history read
 * page by page from `/api/providers/sessions/:id/messages` (under whatever
 * deployment base path serves it), and a run's live events merged in exactly
 * as the chat page merges them — the same session store, realtime handler and
 * message projection, so streaming text, tool results and the history refresh
 * after `complete` behave as they do for the owner.
 *
 * Used by the shared-session module (through the chat barrel), which polls the
 * Portal for a shared session's events and feeds them in through `subscribe`.
 * Nothing here persists: the store is created without a cache owner.
 */
export function useRemoteSessionTranscript({
  sessionId,
  provider,
  subscribe,
}: UseRemoteSessionTranscriptArgs): RemoteSessionTranscript {
  const sessionStore = useSessionStore(null);
  // The realtime handler's buffers, owned here as ChatInterface owns them.
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const lastSeqRef = useRef(new Map<string, number>());
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  // Whether an older page is being read, for the "load earlier" control; the store keeps no such flag.
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);

  const reload = useCallback(async () => {
    await sessionStore.fetchFromServer(sessionId, { limit: SESSION_MESSAGES_PAGE_SIZE, offset: 0 });
  }, [sessionId, sessionStore]);

  useEffect(() => {
    // The store re-renders only for its active session, so that comes first.
    sessionStore.setActiveSession(sessionId);
    void reload();
  }, [reload, sessionId, sessionStore]);

  const refreshLatest = useCallback(async () => {
    const slot = sessionStore.getSessionSlot(sessionId);
    if (!slot?.fetchedAt) {
      // The first read is still on its way and will bring the newest page;
      // if it failed, a refresh is a first read.
      if (slot?.status !== 'loading') {
        await reload();
      }
      return;
    }
    await sessionStore.refreshLatestFromServer(sessionId);
  }, [reload, sessionId, sessionStore]);

  const requestLatestMessages = useCallback(async (targetSessionId: string) => {
    if (targetSessionId === sessionId) {
      await refreshLatest();
    }
  }, [refreshLatest, sessionId]);

  useChatRealtimeHandlers({
    isActive: true,
    subscribe,
    provider,
    selectedSession: null,
    currentSessionId: sessionId,
    setTokenBudget: ignoreTokenBudget,
    pendingPermissionRequests: NO_PERMISSION_REQUESTS,
    setPendingPermissionRequests: ignorePermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    requestLatestMessages,
    sessionStore,
  });

  useEffect(() => () => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
  }, []);

  const loadEarlier = useCallback(async () => {
    setIsLoadingEarlier(true);
    try {
      await sessionStore.fetchMore(sessionId, { limit: SESSION_MESSAGES_PAGE_SIZE });
    } finally {
      setIsLoadingEarlier(false);
    }
  }, [sessionId, sessionStore]);

  const messages = sessionStore.getMessages(sessionId);
  const chatMessages = useMemo(() => normalizedToChatMessages(messages), [messages]);
  const slot = sessionStore.getSessionSlot(sessionId);

  return {
    chatMessages,
    createDiff,
    isLoading: !slot?.fetchedAt && !slot?.historyError,
    isLoadingEarlier,
    hasEarlier: Boolean(slot?.hasMore),
    historyError: slot?.historyError ?? null,
    loadEarlier,
    refreshLatest,
    reload,
  };
}
