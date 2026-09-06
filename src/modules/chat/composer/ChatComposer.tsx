import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { Loader2, ArrowUpIcon, PencilIcon } from 'lucide-react';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { useVoiceRewrite } from '@/modules/chat/hooks/useVoiceRewrite';
import { useVoiceAvailable } from '@/modules/chat/hooks/useVoiceAvailable';
import { useCodeyVoice } from '@/shared/hooks/useCodeyVoice';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { isCodeyPortalSso } from '@/shared/utils';
import type { ChatMessage, VoiceDraftInsertion, QueuedDraft, ScheduledMessage, SlashCommand,SessionActivity,PendingPermissionRequest,PermissionMode,ProviderModelOption } from '@/shared/types';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputSubmit,
} from '@/modules/chat/composer/PromptInput';
import CommandMenu from '@/modules/chat/composer/CommandMenu';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ComposerAttachment from '@/modules/chat/composer/ComposerAttachment';
import { ComposerToolbar } from '@/modules/chat/composer/ComposerToolbar';
import { ComposerVoiceControl } from '@/modules/chat/composer/ComposerVoiceControl';
import { VoiceRewriteControl } from '@/modules/chat/composer/VoiceRewriteControl';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import { ScheduledMessageList } from '@/modules/chat/composer/ScheduledMessageList';
import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';
import ComposerPermissionMenu from '@/modules/chat/composer/ComposerPermissionMenu';

type MentionableFile = {
  name: string;
  path: string;
};

type ChatComposerProps = {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  activity: SessionActivity | null;
  isLoading: boolean;
  onAbortSession: () => void;
  permissionMode: PermissionMode;
  availablePermissionModes: PermissionMode[];
  onSelectPermissionMode: (mode: PermissionMode) => void;
  providerLabel: string;
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  model: string;
  availableModelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  queuedDraft: QueuedDraft | null;
  /** Set while the composer is replacing an already-sent message. */
  isEditingSentMessage: boolean;
  onCancelEditMessage: () => void;
  /** Messages waiting to be sent to this session later. */
  scheduledMessages: ScheduledMessage[];
  onScheduleMessage: (scheduledFor: Date) => void;
  onCancelScheduledMessage: (id: string) => void;
  onEditQueuedDraft: () => void;
  onDeleteQueuedDraft: () => void;
  attachedFiles: File[];
  onRemoveAttachment: (index: number) => void;
  fileErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openAttachmentPicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => VoiceDraftInsertion | void;
  onReplaceVoiceDraft?: (expected: string, replacement: string) => void;
  voiceHistory?: ChatMessage[];
  voiceContextKey?: string;
  voiceRecordingAllowed?: boolean;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  isInputFocused?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
};

/**
 * Rendered by chat's ChatInterface as the whole input area: textarea, pending
 * attachments, queued message, permission banner, voice input and the
 * model/permission popovers that drive the next turn.
 */
export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  activity,
  isLoading,
  onAbortSession,
  permissionMode,
  availablePermissionModes,
  onSelectPermissionMode,
  providerLabel,
  effort,
  availableEffortOptions,
  onSelectEffort,
  model,
  availableModelOptions,
  onSelectModel,
  modelsLoading,
  tokenBudget,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  isDragActive,
  queuedDraft,
  isEditingSentMessage,
  onCancelEditMessage,
  scheduledMessages,
  onScheduleMessage,
  onCancelScheduledMessage,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  attachedFiles,
  onRemoveAttachment,
  fileErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openAttachmentPicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  onReplaceVoiceDraft,
  voiceHistory,
  voiceContextKey,
  voiceRecordingAllowed = true,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  isInputFocused = false,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  const fileDropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedFileRef = useRef<HTMLDivElement | null>(null);
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  useEffect(() => {
    const dropdown = fileDropdownRef.current;
    const selectedFile = selectedFileRef.current;
    if (!showFileDropdown || !dropdown || !selectedFile) {
      return;
    }

    const itemTop = selectedFile.offsetTop;
    const itemBottom = itemTop + selectedFile.offsetHeight;
    const visibleTop = dropdown.scrollTop;
    const visibleBottom = visibleTop + dropdown.clientHeight;

    if (itemTop < visibleTop) {
      dropdown.scrollTop = itemTop;
    } else if (itemBottom > visibleBottom) {
      dropdown.scrollTop = itemBottom - dropdown.clientHeight;
    }
  }, [selectedFileIndex, showFileDropdown]);

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const standaloneVoiceAvailable = useVoiceAvailable();
  const managedVoice = isCodeyPortalSso();
  const { voiceEnabled } = useUiPreferences();
  const codeyVoice = useCodeyVoice(managedVoice && voiceEnabled);
  const voiceVisible = managedVoice ? voiceEnabled : standaloneVoiceAvailable;
  const voiceAvailable = managedVoice
    ? Boolean(codeyVoice.config?.providers.find((item) => item.id === codeyVoice.preferences.provider)?.configured)
    : standaloneVoiceAvailable;
  const rewriteConfigured = codeyVoice.config?.rewrite?.configured === true;
  const replaceVoiceDraft = useCallback((expected: string, replacement: string) => {
    onReplaceVoiceDraft?.(expected, replacement);
  }, [onReplaceVoiceDraft]);
  const rewrite = useVoiceRewrite({
    contextKey: voiceContextKey || '',
    draft: input,
    enabled: managedVoice && voiceEnabled && voiceRecordingAllowed && Boolean(onReplaceVoiceDraft),
    configured: rewriteConfigured,
    useHistory: codeyVoice.preferences.rewriteUseHistory !== false,
    language: codeyVoice.preferences.language,
    replaceDraft: replaceVoiceDraft,
  });
  const { remember: rememberVoice, clear: clearVoice } = rewrite;
  // useVoiceInput captures this callback at recording start, freezing the
  // current session's reference dialogue rather than reading another tab later.
  const receiveVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const insertion = onVoiceTranscript?.(text, rewriteConfigured ? false : send);
    if (managedVoice && insertion) rememberVoice(insertion, voiceHistory || []);
  }, [onVoiceTranscript, rewriteConfigured, managedVoice, rememberVoice, voiceHistory]);
  // Brief, localized recording errors belong to the active composer, never another session's draft.
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceError = useCallback((msg: string) => {
    setVoiceError(t(`voice.errors.${msg}`, { defaultValue: t('voice.failed') }));
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = setTimeout(() => setVoiceError(null), 4000);
  }, [t]);
  useEffect(() => () => {
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
  }, []);
  const { state: voiceState, toggle: voiceToggle, stop: voiceStop, cancel: voiceCancel, activePreferences: recordingPreferences } = useVoiceInput(
    receiveVoiceTranscript,
    handleVoiceError,
    {
      contextKey: voiceContextKey,
      enabled: voiceVisible && voiceAvailable && voiceRecordingAllowed,
      managed: managedVoice ? {
        ...codeyVoice.preferences,
        maxDurationSeconds: codeyVoice.config?.maxDurationSeconds || 120,
      } : undefined,
    },
  );
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';
  const toggleVoice = useCallback(() => {
    if (voiceState === 'idle') clearVoice();
    voiceToggle();
  }, [voiceState, clearVoice, voiceToggle]);

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Hide the thinking/status bar while any permission request is pending
  const hasPendingPermissions = pendingPermissionRequests.length > 0;
  const hasActivityIndicator = Boolean(activity && !hasPendingPermissions);

  const hasQueuedDraft = Boolean(queuedDraft);
  const canQueueDraft = isLoading && Boolean(input.trim() || attachedFiles.length > 0);
  const submitHint = canQueueDraft
    ? hasQueuedDraft
      ? t('input.hintText.updateQueued', { defaultValue: 'Enter to update queued message' })
      : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
    : sendByCtrlEnter
      ? t('input.hintText.ctrlEnter')
      : t('input.hintText.enter');
  const submitAriaLabel = canQueueDraft
    ? hasQueuedDraft
      ? t('input.queue.update', { defaultValue: 'Update queued message' })
      : t('input.queue.sendNext', { defaultValue: 'Queue next message' })
    : isLoading
      ? t('input.stop')
      : isRecording && rewriteConfigured ? t('voice.rewrite.stopPreview') : t('input.send');

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      {!hasPendingPermissions && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 w-[calc(100%-1rem)] max-w-[54.25rem] -translate-x-1/2 translate-y-px bg-transparent sm:w-[calc(100%-2rem)]">
          <ActivityIndicator activity={activity} onAbort={onAbortSession} isInputFocused={isInputFocused} />
        </div>
      )}

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      <ScheduledMessageList
        scheduledMessages={scheduledMessages}
        onCancel={onCancelScheduledMessage}
      />

      {isEditingSentMessage && (
        <div className="mx-auto mb-2 flex max-w-[54.25rem] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
          <PencilIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1">
            {t('composer.editing.title')}
            {' — '}
            <span className="text-muted-foreground">{t('composer.editing.filesNotReverted')}</span>
          </span>
          <button
            type="button"
            onClick={onCancelEditMessage}
            className="shrink-0 rounded-md px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('composer.editing.cancel')}
          </button>
        </div>
      )}

      {queuedDraft && (
        <QueuedMessageCard
          content={queuedDraft.content}
          attachmentCount={
            queuedDraft.uploadedAttachments?.length ?? queuedDraft.attachments.length
          }
          onEdit={onEditQueuedDraft}
          onDelete={onDeleteQueuedDraft}
        />
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-[54.25rem]">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div
            ref={fileDropdownRef}
            className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md"
          >
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                ref={index === selectedFileIndex ? selectedFileRef : undefined}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={[
            isTextareaExpanded ? 'chat-input-expanded' : '',
            hasActivityIndicator ? 'rounded-t-none' : '',
          ].filter(Boolean).join(' ')}
          {...getRootProps()}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">Drop files here</p>
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedFiles.map((file, index) => (
                    <ComposerAttachment
                      key={`${file.name}-${file.lastModified}-${index}`}
                      file={file}
                      onRemove={() => onRemoveAttachment(index)}
                      error={fileErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
            />
        </PromptInputBody>

        <ComposerToolbar
          onAttachFiles={openAttachmentPicker}
          voiceControl={onVoiceTranscript && voiceVisible ? (
            <ComposerVoiceControl state={voiceState} onToggle={toggleVoice} onCancel={voiceCancel}
              disabled={!voiceAvailable || !voiceRecordingAllowed || rewrite.busy}
              optionsLocked={rewrite.busy}
              managed={managedVoice ? {
                config: codeyVoice.config,
                preferences: recordingPreferences || codeyVoice.preferences,
                onChange: codeyVoice.update,
                onRefresh: codeyVoice.refresh,
                loadFailed: Boolean(codeyVoice.error),
              } : undefined} />
          ) : null}
          rewriteControl={managedVoice && voiceVisible ? (
            <VoiceRewriteControl busy={rewrite.busy} canRewrite={rewrite.canRewrite && voiceState === 'idle'}
              canUndo={rewrite.canUndo && voiceState === 'idle'} configured={rewriteConfigured}
              canRestore={rewrite.canRestore && voiceState === 'idle'} hasPreviousRewrite={rewrite.hasPreviousRewrite}
              onRewrite={rewrite.rewrite} onCancel={rewrite.cancel} onUndo={rewrite.undo} onRestore={rewrite.restore} />
          ) : null}
          rewriteNotice={managedVoice && voiceVisible && (rewrite.busy || rewrite.notice || rewrite.candidate) ? (
            <div role="status" className="mb-2 space-y-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <p>{rewrite.busy ? t('voice.rewrite.busy') : t(`voice.rewrite.${rewrite.notice}`, {
                defaultValue: t('voice.rewrite.failed'),
              })}</p>
              {rewrite.originalText && (
                <details>
                  <summary className="cursor-pointer">{t('voice.rewrite.original')}</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{rewrite.originalText}</p>
                </details>
              )}
              {rewrite.candidate && (
                <>
                  <textarea readOnly aria-label={t('voice.rewrite.suggestion')} value={rewrite.candidate.text}
                    className="w-full resize-y rounded border border-border bg-background p-2 text-foreground" rows={3} />
                  {rewrite.canApply ? (
                    <button type="button" className="rounded border border-border px-2 py-1 text-foreground"
                      onClick={rewrite.applyCandidate}>{t('voice.rewrite.apply')}</button>
                  ) : <p>{t('voice.rewrite.copySuggestion')}</p>}
                </>
              )}
            </div>
          ) : null}
          modelControl={<ComposerModelMenu
              effort={effort}
              effortOptions={availableEffortOptions}
              onSelectEffort={onSelectEffort}
              model={model}
              modelOptions={availableModelOptions}
              onSelectModel={onSelectModel}
              modelsLoading={modelsLoading}
            />}
          permissionControl={<ComposerPermissionMenu
              permissionMode={permissionMode}
              permissionModes={availablePermissionModes}
              onSelectPermissionMode={onSelectPermissionMode}
              providerLabel={providerLabel}
            />}
          submitControl={<PromptInputSubmit
              onClick={
                canQueueDraft
                  ? (e: MouseEvent<HTMLButtonElement>) => {
                      e.preventDefault();
                      onSubmit(e);
                    }
                  : isLoading
                    ? onAbortSession
                    : isRecording
                      ? (e: MouseEvent<HTMLButtonElement>) => {
                          e.preventDefault();
                          voiceStop({ send: !rewriteConfigured });
                        }
                      : undefined
              }
              disabled={
                isLoading
                  ? false
                  : isRecording
                    ? false
                    : isTranscribing
                      ? true
                      : !input.trim() && attachedFiles.length === 0
              }
              aria-label={submitAriaLabel}
              title={submitAriaLabel}
              className="h-9 w-9"
            >
              {isTranscribing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : canQueueDraft ? (
                <ArrowUpIcon className="h-4 w-4" />
              ) : undefined}
            </PromptInputSubmit>}
          tokenUsage={tokenBudget}
          onShowTokenUsage={onShowTokenUsage}
          commandsCount={slashCommandsCount}
          onShowCommands={onToggleCommandMenu}
          hasInput={hasInput}
          onClearInput={onClearInput}
          canSchedule={Boolean(input.trim())}
          onSchedule={onScheduleMessage}
          submitHint={submitHint}
          hideHint={Boolean(input.trim() && !canQueueDraft)}
          voiceStatus={voiceState === 'idle' ? undefined : t(`voice.${voiceState}`)}
          voiceError={voiceVisible ? voiceError : null}
        />
      </PromptInput>
      </div>}
    </div>
  );
}
