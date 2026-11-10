import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangleIcon, LockIcon, RefreshCwIcon } from 'lucide-react';

import {
  ActivityIndicator,
  PermissionContext,
  PermissionRequestsBanner,
  TranscriptRows,
  TranscriptViewerContext,
  useLazyRowObserver,
  useRemoteSessionTranscript,
} from '@/modules/chat';
import { api, ApiRequestError, readPortalJson } from '@/shared/api';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type {
  LLMProvider,
  PendingPermissionRequest,
  SessionActivity,
  SharedSessionInfo,
  SharedSessionOutgoingMessage,
  SharedSessionRuntime,
} from '@/shared/types';
import { useSharedSessionLive } from '@/modules/shared-session/hooks/useSharedSessionLive';
import SharedSessionComposer from '@/modules/shared-session/SharedSessionComposer';
import SharedSessionHeader from '@/modules/shared-session/SharedSessionHeader';
import SharedSessionOutbox from '@/modules/shared-session/SharedSessionOutbox';

/** Within this distance of the bottom the transcript keeps following new rows. */
const FOLLOW_BOTTOM_PX = 80;
/** A login that expired reloads the page once (the Portal then asks for a login); not again within this window. */
const SIGNED_OUT_RELOAD_GUARD_MS = 60_000;
const KNOWN_PROVIDERS = new Set<LLMProvider>(['claude', 'cursor', 'codex', 'opencode']);

type PageAccess = 'open' | 'ended' | 'signedOut';

/** An Idempotency-Key for one message: 8–64 letters, digits, `_` or `-`. */
const createIdempotencyKey = (): string => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
);

const readErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The page parameters updated from `GET <api>`; anything it leaves out keeps the injected value. */
function applySharedSessionInfo(current: SharedSessionRuntime, info: SharedSessionInfo): SharedSessionRuntime {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  const provider = text(info.session?.provider) as LLMProvider | null;
  const mode = info.grant?.mode;
  const approvals = info.grant?.approvals;
  return {
    ...current,
    address: text(info.session?.address) ?? current.address,
    provider: provider && KNOWN_PROVIDERS.has(provider) ? provider : current.provider,
    title: text(info.session?.title) ?? current.title,
    owner: text(info.owner) ?? current.owner,
    viewer: text(info.viewer) ?? current.viewer,
    mode: mode === 'auto' || mode === 'confirm' ? mode : current.mode,
    approvals: approvals === 'user' || approvals === 'owner' ? approvals : current.approvals,
    expiresAt: info.grant && 'expiresAt' in info.grant ? text(info.grant.expiresAt) : current.expiresAt,
  };
}

/** Where a message the Portal just accepted stands, from its `POST /api/v1/messages` answer. */
function readAcceptedMessage(value: unknown, text: string): SharedSessionOutgoingMessage | null {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
    return null;
  }
  const message = value as Partial<SharedSessionOutgoingMessage> & { id: string };
  return {
    id: message.id,
    text: typeof message.text === 'string' ? message.text : text,
    status: typeof message.status === 'string' ? message.status : 'pending',
    error: message.error ?? null,
    createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
  };
}

/** A full-page notice for a grant that no longer opens this page. */
function SharedSessionNotice({ access, grantId }: { access: Exclude<PageAccess, 'open'>; grantId: string }) {
  const { t } = useTranslation('chat');

  // An expired login reloads once, so the Portal can ask for a new one; the
  // guard keeps a Portal that keeps answering 401 from reloading forever.
  useEffect(() => {
    if (access !== 'signedOut') return;
    try {
      const guardKey = `codey-shared-session-reload:${grantId}`;
      const lastReload = Number(sessionStorage.getItem(guardKey) || 0);
      if (Date.now() - lastReload > SIGNED_OUT_RELOAD_GUARD_MS) {
        sessionStorage.setItem(guardKey, String(Date.now()));
        window.location.reload();
      }
    } catch {
      // Storage or navigation unavailable: the button below still works.
    }
  }, [access, grantId]);

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background p-6" role="alert">
      <div className="max-w-sm text-center">
        <LockIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
        {access === 'ended' ? (
          <>
            <h1 className="text-base font-semibold text-foreground">
              {t('sharedSession.ended.title', { defaultValue: 'This shared session is no longer available' })}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('sharedSession.ended.body', { defaultValue: 'The share was withdrawn or has expired.' })}
            </p>
          </>
        ) : (
          <>
            <h1 className="text-base font-semibold text-foreground">
              {t('sharedSession.signedOut.title', { defaultValue: 'Your Codey login has expired' })}
            </h1>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted"
            >
              <RefreshCwIcon className="h-3.5 w-3.5" aria-hidden />
              {t('sharedSession.signedOut.reload', { defaultValue: 'Reload' })}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A session another Codey user shared with the reader to read and chat in
 * (codey docs/codey-shared-sessions.md §6): the owner's transcript drawn with
 * the chat's own rows, followed live through the Portal, a text composer, a
 * stop button for the reader's own turn and the approvals the owner lets them
 * answer. Rendered by SharedSessionApp; there is no file tree, terminal,
 * settings or session switching, and nothing here talks to a node directly.
 */
export default function SharedSessionPage({ runtime }: { runtime: SharedSessionRuntime }) {
  const { t } = useTranslation('chat');
  const { showThinking, showRawParameters, sendByCtrlEnter } = useUiPreferences();
  // The page parameters, refreshed from `GET <api>`: the owner may have shared again with another mode since the page was served.
  const [session, setSession] = useState(runtime);
  // Whether the grant still opens the page: a 404 means it was withdrawn or expired, a 401 that the Portal login did.
  const [access, setAccess] = useState<PageAccess>('open');
  // Messages the Portal accepted that the live poll does not list yet.
  const [sentMessages, setSentMessages] = useState<SharedSessionOutgoingMessage[]>([]);
  // Approvals answered here, hidden at once rather than at the next poll; request ids are never reused.
  const [answeredRequestIds, setAnsweredRequestIds] = useState<Set<string>>(() => new Set());
  // Why the last send, stop or answer failed, shown above the composer.
  const [actionError, setActionError] = useState<string | null>(null);
  // The Idempotency-Key of a send that has not been accepted yet, reused when the same text is sent again.
  const pendingSendRef = useRef<{ key: string; text: string } | null>(null);
  // The transcript's history refresh, which the live poll calls; the two hooks need each other.
  const historyRefreshRef = useRef<() => void>(() => {});
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Whether the reader is at the bottom of the transcript, so new rows keep it there.
  const followBottomRef = useRef(true);

  const loseAccess = useCallback((error: ApiRequestError) => {
    setAccess(error.status === 401 ? 'signedOut' : 'ended');
  }, []);

  const reportActionError = useCallback((error: unknown, key: string, defaultValue: string) => {
    if (error instanceof ApiRequestError && error.status === 401) {
      setAccess('signedOut');
      return;
    }
    setActionError(t(key, { error: readErrorMessage(error), defaultValue }));
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await readPortalJson<SharedSessionInfo>(await api.sharedSession.info(runtime.api));
        if (!cancelled && info && typeof info === 'object') {
          setSession((current) => applySharedSessionInfo(current, info));
        }
      } catch (error) {
        if (!cancelled && error instanceof ApiRequestError && (error.status === 401 || error.status === 404)) {
          loseAccess(error);
        }
        // Anything else: the injected parameters stand.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loseAccess, runtime.api]);

  const handleHistoryStale = useCallback(() => historyRefreshRef.current(), []);
  const { live, pollError, subscribe, pollNow } = useSharedSessionLive({
    apiRoot: session.api,
    sessionId: session.sessionId,
    onHistoryStale: handleHistoryStale,
    onAccessLost: loseAccess,
  });
  const transcript = useRemoteSessionTranscript({
    sessionId: session.sessionId,
    provider: session.provider,
    subscribe,
  });
  const { chatMessages, refreshLatest } = transcript;

  useEffect(() => {
    historyRefreshRef.current = () => {
      void refreshLatest();
    };
  }, [refreshLatest]);

  useEffect(() => {
    document.title = session.title || t('sharedSession.header.untitled', { defaultValue: 'Shared session' });
  }, [session.title, t]);

  const listedMessages = live?.messages;
  // The poll's copy of a message wins: it has the newer status.
  const outgoingMessages = useMemo(() => {
    const listed = listedMessages ?? [];
    const listedIds = new Set(listed.map((message) => message.id));
    return [...listed, ...sentMessages.filter((message) => !listedIds.has(message.id))];
  }, [listedMessages, sentMessages]);

  const run = live?.run ?? null;
  const runId = run?.id ?? null;
  const listedPermissions = live?.permissions;

  // Only what the Portal lists: the approvals in the reader's own turn that
  // the owner lets them answer. Requests seen in the event stream are not.
  const permissionRequests = useMemo<PendingPermissionRequest[]>(() => (listedPermissions ?? [])
    .filter((request) => typeof request?.requestId === 'string' && !answeredRequestIds.has(request.requestId))
    .map((request) => {
      const receivedAt = request.receivedAt ? new Date(request.receivedAt) : null;
      return {
        requestId: request.requestId,
        toolName: request.toolName || 'UnknownTool',
        input: request.input,
        sessionId: session.sessionId,
        ...(receivedAt && Number.isFinite(receivedAt.getTime()) ? { receivedAt } : {}),
      };
    }), [answeredRequestIds, listedPermissions, session.sessionId]);

  const handlePermissionDecision = useCallback((
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => {
    const ids = (Array.isArray(requestIds) ? requestIds : [requestIds]).filter(Boolean);
    if (!runId || ids.length === 0) return;
    setActionError(null);
    setAnsweredRequestIds((previous) => new Set([...previous, ...ids]));

    // The Portal takes an object for updatedInput and at most 4000 characters
    // of message, and no remembered rule: the owner's settings are not the reader's.
    const updatedInput = decision.updatedInput && typeof decision.updatedInput === 'object' && !Array.isArray(decision.updatedInput)
      ? decision.updatedInput
      : undefined;
    const message = typeof decision.message === 'string' && decision.message ? decision.message.slice(0, 4000) : undefined;
    for (const requestId of ids) {
      void api.sharedSession.answerPermission(session.api, requestId, {
        runId,
        allow: Boolean(decision.allow),
        ...(updatedInput ? { updatedInput } : {}),
        ...(message ? { message } : {}),
      })
        .then((response) => readPortalJson(response))
        .catch((error: unknown) => {
          setAnsweredRequestIds((previous) => {
            const next = new Set(previous);
            next.delete(requestId);
            return next;
          });
          reportActionError(error, 'sharedSession.permissionFailed', 'Could not answer: {{error}}');
        })
        .finally(pollNow);
    }
  }, [pollNow, reportActionError, runId, session.api]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests: permissionRequests,
    handlePermissionDecision,
  }), [handlePermissionDecision, permissionRequests]);

  const canStop = run?.status === 'running' && run.canStop === true;
  const handleStop = useCallback(async () => {
    if (!runId || !canStop) return;
    setActionError(null);
    try {
      await readPortalJson(await api.sharedSession.stop(session.api, runId));
    } catch (error) {
      reportActionError(error, 'sharedSession.stopFailed', 'Could not stop the turn: {{error}}');
    } finally {
      pollNow();
    }
  }, [canStop, pollNow, reportActionError, runId, session.api]);

  const runStatus = run?.status ?? null;
  const runStartedAt = run?.startedAt ?? null;
  // The chat's own activity tab; it offers Stop only while the reader may stop the turn.
  const activity = useMemo<SessionActivity | null>(() => (runStatus === 'running'
    ? {
        statusText: null,
        canInterrupt: canStop,
        startedAt: runStartedAt ?? 0,
      }
    : null), [canStop, runStartedAt, runStatus]);

  const handleSend = useCallback(async (text: string): Promise<boolean> => {
    if (!session.address) {
      setActionError(t('sharedSession.composer.noAddress', { defaultValue: 'Messages cannot be sent to this session yet.' }));
      return false;
    }
    setActionError(null);
    // A retry of the same text reuses its key, so a send whose answer was
    // lost is not delivered twice; different text is a different message.
    if (pendingSendRef.current?.text !== text) {
      pendingSendRef.current = { key: createIdempotencyKey(), text };
    }
    try {
      const response = await api.sharedSession.sendMessage(
        session.api,
        { to: session.address, text },
        pendingSendRef.current.key,
      );
      const accepted = readAcceptedMessage(await readPortalJson<unknown>(response), text);
      pendingSendRef.current = null;
      // Local copies the poll already lists are dropped here, so one that
      // later falls out of its recent-20 window cannot come back stale.
      const listedIds = new Set((listedMessages ?? []).map((message) => message.id));
      setSentMessages((previous) => [
        ...previous.filter((message) => !listedIds.has(message.id)),
        ...(accepted ? [accepted] : []),
      ]);
      followBottomRef.current = true;
      pollNow();
      return true;
    } catch (error) {
      reportActionError(error, 'sharedSession.composer.sendFailed', 'Not sent: {{error}}');
      return false;
    }
  }, [listedMessages, pollNow, reportActionError, session.address, session.api, t]);

  const lazyRows = useLazyRowObserver(scrollContainerRef);
  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    followBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight <= FOLLOW_BOTTOM_PX;
  };

  // Follow new rows while the reader is at the bottom, as the chat does.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (container && followBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [chatMessages, outgoingMessages, permissionRequests]);

  const { loadEarlier } = transcript;
  const handleLoadEarlier = useCallback(async () => {
    const container = scrollContainerRef.current;
    const distanceFromBottom = container ? container.scrollHeight - container.scrollTop : 0;
    followBottomRef.current = false;
    await loadEarlier();
    // Keep the rows the reader was looking at where they were.
    window.requestAnimationFrame(() => {
      if (container) {
        container.scrollTop = container.scrollHeight - distanceFromBottom;
      }
    });
  }, [loadEarlier]);

  const viewer = useMemo(
    () => ({ ownerName: session.owner, viewerName: session.viewer }),
    [session.owner, session.viewer],
  );

  if (access !== 'open') {
    return <SharedSessionNotice access={access} grantId={session.grantId} />;
  }

  const ownerName = session.owner;
  const statusNotice = live && !live.supported
    ? t('sharedSession.status.unsupported', {
      owner: ownerName,
      defaultValue: "{{owner}}'s machine runs an older Codey: the conversation refreshes every few seconds, and turns cannot be followed live, stopped or approved here.",
    })
    : live && !live.online
      ? t('sharedSession.status.offline', {
        owner: ownerName,
        defaultValue: "{{owner}}'s machine cannot be reached right now. This is the conversation as last read.",
      })
      : null;

  return (
    <TranscriptViewerContext.Provider value={viewer}>
      <PermissionContext.Provider value={permissionContextValue}>
        <div className="fixed inset-0 flex flex-col bg-background text-foreground">
          <SharedSessionHeader
            title={session.title}
            ownerName={ownerName}
            provider={session.provider}
            mode={session.mode}
            expiresAt={session.expiresAt}
          />

          {(statusNotice || pollError) && (
            <div
              role="status"
              className="flex flex-shrink-0 items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200"
            >
              <AlertTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {statusNotice ?? t('sharedSession.status.pollFailed', {
                  error: pollError,
                  defaultValue: 'Could not check for updates: {{error}}',
                })}
              </span>
            </div>
          )}

          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3 pt-3 sm:pb-4 sm:pt-4"
          >
            <div className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4">
              {transcript.historyError && (
                <div role="alert" className="rounded-md border border-amber-300 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                  <p className="break-words">
                    {t('sharedSession.history.failed', {
                      error: transcript.historyError,
                      defaultValue: 'The conversation could not be loaded: {{error}}',
                    })}
                  </p>
                  <button type="button" className="mt-2 underline" onClick={() => void refreshLatest()}>
                    {t('sharedSession.history.retry', { defaultValue: 'Retry' })}
                  </button>
                </div>
              )}

              {transcript.hasEarlier && (
                <div className="py-2 text-center text-sm">
                  <button
                    type="button"
                    className="text-blue-600 underline disabled:opacity-50 dark:text-blue-400"
                    disabled={transcript.isLoadingEarlier}
                    onClick={() => void handleLoadEarlier()}
                  >
                    {transcript.isLoadingEarlier
                      ? t('session.loading.olderMessages')
                      : t('session.messages.loadEarlier')}
                  </button>
                </div>
              )}

              {transcript.isLoading && chatMessages.length === 0 ? (
                <div className="mt-8 flex items-center justify-center space-x-2 text-gray-500 dark:text-gray-400">
                  <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                  <p>{t('session.loading.sessionMessages')}</p>
                </div>
              ) : chatMessages.length === 0 && !transcript.historyError ? (
                <p className="mt-8 text-center text-sm text-muted-foreground">
                  {t('sharedSession.history.empty', { defaultValue: 'No messages yet.' })}
                </p>
              ) : null}

              <TranscriptRows
                messages={chatMessages}
                lazyRows={lazyRows}
                createDiff={transcript.createDiff}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                provider={session.provider}
              />

              {!transcript.isLoading && (
                <SharedSessionOutbox
                  messages={outgoingMessages}
                  chatMessages={chatMessages}
                  ownerName={ownerName}
                  viewerName={session.viewer}
                  hasEarlierHistory={transcript.hasEarlier}
                />
              )}
            </div>
          </div>

          <div className="flex-shrink-0 px-2 pb-2 sm:px-4 sm:pb-4">
            <div className="mx-auto w-full max-w-[54.25rem] space-y-2">
              {live?.waitingForOwner && (
                <div role="status" className="rounded-md border border-border/60 bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  {t('sharedSession.status.waitingForOwner', {
                    owner: ownerName,
                    defaultValue: 'Waiting for {{owner}}: this turn needs an approval only {{owner}} can give.',
                  })}
                </div>
              )}
              {actionError && (
                <p role="alert" className="break-words px-1 text-xs text-destructive">{actionError}</p>
              )}
              <PermissionRequestsBanner
                pendingPermissionRequests={permissionRequests}
                handlePermissionDecision={handlePermissionDecision}
              />
              <div>
                <ActivityIndicator activity={activity} onAbort={() => void handleStop()} />
                <SharedSessionComposer
                  onSend={handleSend}
                  disabled={!session.address}
                  sendByCtrlEnter={sendByCtrlEnter}
                  placeholder={t('sharedSession.composer.placeholder', {
                    owner: ownerName,
                    defaultValue: "Message {{owner}}'s agent…",
                  })}
                />
              </div>
            </div>
          </div>
        </div>
      </PermissionContext.Provider>
    </TranscriptViewerContext.Provider>
  );
}
