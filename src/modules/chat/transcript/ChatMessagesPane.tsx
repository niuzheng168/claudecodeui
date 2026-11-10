import { useTranslation } from 'react-i18next';
import { memo } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { BackgroundTaskSummary,
  ChatMessage,
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition } from '@/shared/types';
import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import ProviderSelectionEmptyState from '@/modules/chat/transcript/ProviderSelectionEmptyState';
import type { NewSessionWorktree } from '@/modules/chat/hooks/useNewSessionWorktree';
import TranscriptRows from '@/modules/chat/transcript/TranscriptRows';
import LoadAllMessagesOverlay from '@/modules/chat/transcript/LoadAllMessagesOverlay';
import ChatExportMenu from '@/modules/chat/transcript/ChatExportMenu';
import { BackgroundTasksStrip } from '@/modules/chat/transcript/BackgroundTasksStrip';

type ChatMessagesPaneProps = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  setProviderModel: (provider: LLMProvider, model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  newSessionWorktree?: NewSessionWorktree | null;
  isLoadingMoreMessages: boolean;
  historyError?: string | null;
  hasMoreMessages: boolean;
  totalMessages: number;
  totalIsExact?: boolean;
  sessionMessagesCount: number;
  visibleMessageCount: number;
  visibleMessages: ChatMessage[];
  loadEarlierMessages: () => void;
  revealMessage: (message: ChatMessage) => void;
  /** The session's running background tasks from the activity map, for the strip to list ones whose rows are not loaded. */
  backgroundTasks?: BackgroundTaskSummary[];
  /** The chat websocket's send, which the background-tasks strip stops a task over. */
  sendMessage: (message: unknown) => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  loadAllJustFinished: boolean;
  showLoadAllOverlay: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject: Project;
  /** Loads an already-sent message back into the composer; absent when the provider cannot re-run from a point. */
  onEditMessage?: (message: ChatMessage) => void;
  /** Branches the conversation into a new session ending at a message. */
  onForkFromMessage?: (message: ChatMessage) => void;
  /** Fetches the whole transcript for an export, which otherwise only sees the loaded page. */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
};

/**
 * Rendered by chat's ChatInterface as the scrolling transcript: the message
 * list and tool groups, the export menu, the provider empty state and the
 * load-all-history overlay.
 */
function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  newSessionWorktree = null,
  isLoadingMoreMessages,
  historyError,
  hasMoreMessages,
  totalMessages,
  totalIsExact = true,
  sessionMessagesCount,
  visibleMessageCount,
  visibleMessages,
  loadEarlierMessages,
  revealMessage,
  backgroundTasks,
  sendMessage,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  loadAllJustFinished,
  showLoadAllOverlay,
  createDiff,
  onEditMessage,
  onForkFromMessage,
  onLoadFullTranscript,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      {chatMessages.length > 0 && (
        <div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex items-start justify-between gap-2 sm:px-4">
          {/* Running background work stays in view while the transcript scrolls under it. */}
          <div className="pointer-events-auto min-w-0 pl-4 sm:pl-0">
            <BackgroundTasksStrip
              messages={chatMessages}
              tasks={backgroundTasks}
              sessionId={selectedSession?.id || currentSessionId}
              sendMessage={sendMessage}
              onReveal={revealMessage}
              onLoadAll={loadAllMessages}
            />
          </div>
          <div className="pointer-events-auto">
            <ChatExportMenu
              messages={chatMessages}
              sessionTitle={selectedSession?.summary || selectedSession?.title}
              provider={provider}
              selectedProject={selectedProject}
              createDiff={createDiff}
              onLoadFullTranscript={onLoadFullTranscript}
            />
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4">
      {historyError && (
        <div role="alert" className="rounded-md border border-amber-300 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          <p>{t('session.messages.loadFailed', { defaultValue: 'History could not be loaded. Retry, or reload the full conversation.' })}</p>
          <p className="mt-1 break-words text-xs">{historyError}</p>
          <button type="button" className="mt-2 underline" disabled={isLoadingAllMessages || isLoadingMoreMessages} onClick={loadAllMessages}>
            {t('session.messages.loadAll')}
          </button>
        </div>
      )}
      {(isLoadingSessionMessages || isProcessing) && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          providerModels={providerModels}
          setProviderModel={setProviderModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          newSessionWorktree={newSessionWorktree}
        />
      ) : (
        <>
          {/* Loading indicator for older messages (hide when load-all is active) */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded && (
            <div className="py-3 text-center text-gray-500 dark:text-gray-400">
              <div className="flex items-center justify-center space-x-2">
                <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
                <p className="text-sm">{t('session.loading.olderMessages')}</p>
              </div>
            </div>
          )}

          {/* Persistent controls still work when tool grouping adds no scroll height. */}
          {(hasMoreMessages || chatMessages.length > visibleMessageCount) && (
            <div className="border-b border-gray-200 py-2 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {totalMessages > 0 && totalIsExact && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
              <div className="mt-2 flex justify-center gap-4">
                <button type="button" className="text-blue-600 underline disabled:opacity-50 dark:text-blue-400"
                  disabled={isLoadingMoreMessages || isLoadingAllMessages} onClick={loadEarlierMessages}>
                  {t('session.messages.loadEarlier')}
                </button>
                <button type="button" className="text-blue-600 underline disabled:opacity-50 dark:text-blue-400"
                  disabled={isLoadingMoreMessages || isLoadingAllMessages} onClick={loadAllMessages}>
                  {t('session.messages.loadAll')}
                </button>
              </div>
            </div>
          )}

          <LoadAllMessagesOverlay
            showLoadAllOverlay={showLoadAllOverlay}
            isLoadingAllMessages={isLoadingAllMessages}
            loadAllJustFinished={loadAllJustFinished}
            totalMessages={totalMessages}
            onLoadAllMessages={loadAllMessages}
          />

          <TranscriptRows
            messages={visibleMessages}
            lazyRows={lazyRows}
            createDiff={createDiff}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onGrantToolPermission={onGrantToolPermission}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject}
            provider={provider}
            onEditMessage={onEditMessage}
            onForkFromMessage={onForkFromMessage}
          />
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
