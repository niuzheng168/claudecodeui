import { useTranslation } from 'react-i18next';

import { LLMProviderLogo } from '@/shared/ui';
import type { AppTab, Project, ProjectSession, SessionActivityState } from '@/shared/types';
import { usePlugins } from '@/modules/plugins';
import { cn, getSessionTitle } from '@/shared/utils';
import { useSessionTitleRename } from '@/modules/project-workspace/hooks/useSessionTitleRename';

type WorkspaceTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  /** What the selected session is doing; null or absent while it is not busy. */
  sessionState?: SessionActivityState | null;
  shouldShowTasksTab: boolean;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession: (sessionId: string, summary: string) => Promise<boolean>;
};

/**
 * The bar under the session's icon, coloured as the Codey Workbench colours a
 * session in its list: amber waits for the user, blue pulses while a turn
 * runs and holds still while only background or scheduled work is left.
 */
const SESSION_STATE_BAR: Record<SessionActivityState, string> = {
  waiting: 'bg-amber-500',
  running: 'bg-primary motion-safe:animate-pulse',
  background: 'bg-primary',
};

const SESSION_STATE_LABEL: Record<SessionActivityState, string> = {
  waiting: 'Waiting for your input',
  running: 'Running',
  background: 'Background work',
};

function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  if (activeTab === 'browser') {
    return t('tabs.browser');
  }

  return t('misc.projectFallback');
}

/**
 * Rendered by WorkspaceHeader to label the workspace with the active session or
 * tab name. On the chat tab the session title can be double-clicked to rename
 * the session in place, as a second way in beside the sidebar's rename.
 */
export default function WorkspaceTitle({
  activeTab,
  selectedProject,
  selectedSession,
  sessionState = null,
  shouldShowTasksTab,
  onRenameSession,
}: WorkspaceTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const stateLabel = sessionState
    ? t(`mainContent.sessionState.${sessionState}`, { defaultValue: SESSION_STATE_LABEL[sessionState] })
    : '';
  const showChatNewSession = activeTab === 'chat' && !selectedSession;
  const sessionTitle = selectedSession ? getSessionTitle(selectedSession) : '';

  const {
    isEditing: isRenaming,
    draft: renameDraft,
    isSaving: isSavingRename,
    inputRef: renameInputRef,
    startEditing: startRenaming,
    updateDraft: updateRenameDraft,
    cancelEditing: cancelRenaming,
    handleInputKeyDown: handleRenameKeyDown,
  } = useSessionTitleRename({
    sessionId: selectedSession?.id ?? null,
    currentTitle: sessionTitle,
    onRenameSession,
  });

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <LLMProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
          {sessionState && (
            <span
              role="img"
              aria-label={stateLabel}
              title={stateLabel}
              className={cn('absolute -bottom-1 left-1/2 h-[3px] w-3.5 -translate-x-1/2 rounded-full', SESSION_STATE_BAR[sessionState])}
            />
          )}
        </div>
      )}

      <div className="min-w-0 flex-1">
        {activeTab === 'chat' && selectedSession ? (
          <div className="min-w-0">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameDraft}
                onChange={(event) => updateRenameDraft(event.target.value)}
                onKeyDown={handleRenameKeyDown}
                // Clicking anywhere else cancels, as the sidebar's rename does.
                onBlur={cancelRenaming}
                readOnly={isSavingRename}
                aria-busy={isSavingRename}
                aria-label={t('mainContent.renameSessionLabel')}
                // Blur cancels, so a touch keyboard needs a key that commits.
                enterKeyHint="done"
                className="w-full max-w-md rounded border border-border bg-background px-1.5 py-0.5 text-sm font-semibold leading-tight text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <h2
                title={t('mainContent.renameSessionHint', { title: sessionTitle })}
                onDoubleClick={startRenaming}
                className="cursor-text truncate text-sm font-semibold leading-tight text-foreground"
              >
                {sessionTitle}
              </h2>
            )}
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
    </div>
  );
}
