import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference } from '@/shared/userSettings';
import type { BackgroundSendChoice, BackgroundSendPrompt, StoredQueuedMessage, SteerChatMessage, CommandModalPayload, CostCommandData, HelpCommandData, MarkSessionProcessing, ModelCommandData, QueuedDraft, SessionActivityMap, StatusCommandData,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import { isComposerModeShortcut, isNativeClaudeCommand, isNativeCodexCommand } from '@/shared/utils';
import {
  clearQueuedMessage,
  enqueueQueuedMessage,
  flushChatDraft,
  forgetQueuedMessage,
  holdQueuedMessage,
  hydrateChatDrafts,
  readDraftText,
  readQueuedMessages,
  subscribeToChatDrafts,
  writeDraftText,
} from '@/shared/chatDrafts';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';

type UseChatComposerStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  selectPermissionMode?: (mode: PermissionMode) => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  activeRunId?: string | null;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  steerMessage?: SteerChatMessage;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
};

type MentionableFile = {
  name: string;
  path: string;
};

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};





type SubmitOptions = {
  /**
   * Send the text as a chat message even when it starts with "/" (or is
   * "help"). Set only for the re-submit of a custom command's expanded body:
   * like the Claude Code CLI, that body is never read as a command again, so a
   * body that opens with its own or another command's name cannot loop or
   * run that command instead of being sent.
   */
  skipCommandInterception?: boolean;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await api.assets.uploadFiles(formData);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};


const restoreQueuedDrafts = (sessionKey: string): QueuedDraft[] =>
  readQueuedMessages(sessionKey).map(saved => ({
    id: saved.id,
    content: saved.content,
    attachments: [],
    uploadedAttachments: saved.attachments ?? saved.images,
    options: saved.options,
    steerHold: saved.steerHold,
  }));

function storedQueuedDraft(draft: QueuedDraft): StoredQueuedMessage {
  return {
    id: draft.id,
    content: draft.content,
    options: draft.options,
    attachments: draft.uploadedAttachments ?? [],
    ...(draft.steerHold ? { steerHold: draft.steerHold } : {}),
  };
}

function matchesQueuedDraft(draft: QueuedDraft | null, saved: StoredQueuedMessage | null): boolean {
  return Boolean(draft && saved && draft.id === saved.id && draft.content === saved.content
    && JSON.stringify(draft.options ?? {}) === JSON.stringify(saved.options ?? {})
    && JSON.stringify(draft.uploadedAttachments ?? []) === JSON.stringify(saved.attachments ?? saved.images ?? []));
}

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

/**
 * Enter that CONFIRMS an IME candidate must not also submit.
 *
 * `event.isComposing` alone is not enough: Safari fires `compositionend` BEFORE the confirming
 * Enter's `keydown`, so the flag is already `false` by the time the handler runs. Chrome and
 * Firefox fire it after, which is why the naive guard looks correct on those two and the bug
 * reads as Safari-only. A tight window after `compositionend` covers it — that sequence is
 * synchronous (microseconds), while a human pressing Enter a second time takes >= 100ms and
 * never lands inside it.
 */
const SAFARI_IME_RACE_WINDOW_MS = 30;

/** Used by ChatInterface to own scoped drafts, attachments, queued sends and acknowledged same-turn corrections. */
export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  selectPermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  processingSessions,
  canAbortSession,
  activeRunId,
  tokenBudget,
  sendMessage,
  steerMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const { t } = useTranslation('chat');
  // The composer text together with the chat scope it belongs to. They are one
  // state rather than a value plus a ref because they have to move in lockstep:
  // on a session switch there is one commit where the scope has already changed
  // while the text has not, and anything that persisted the text in that commit
  // would write the previous session's message into the new session's draft.
  // A ref cannot express this — React evaluates a state updater eagerly, so a
  // ref set inside one is already ahead by the time the effects run.
  //
  // Restored synchronously from the draft mirror so a reload shows what was
  // being typed on the first paint rather than after the drafts request lands.
  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);

  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialScope = selectedSession?.id || currentSessionId
      || (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  // Composition is tracked on `window` in the capture phase rather than on the textarea, so a
  // composition that starts in one field and ends after focus moves still closes cleanly.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  useEffect(() => {
    const onStart = () => {
      isComposingRef.current = true;
    };
    const onEnd = () => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
    };
    // `blur` does not bubble, but a capture-phase listener on `window` still sees it on the way
    // down — otherwise a composition abandoned by clicking away would stay open forever.
    const onBlur = () => {
      isComposingRef.current = false;
    };
    window.addEventListener('compositionstart', onStart, true);
    window.addEventListener('compositionend', onEnd, true);
    window.addEventListener('blur', onBlur, true);
    return () => {
      window.removeEventListener('compositionstart', onStart, true);
      window.removeEventListener('compositionend', onEnd, true);
      window.removeEventListener('blur', onBlur, true);
    };
  }, []);

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setInputState((previous) => ({
      scope: draftScopeRef.current,
      value: typeof next === 'function' ? next(previous.value) : next,
    }));
  }, []);
  // Explicit transcript suggestions reveal/focus even a folded mobile composer;
  // draft hydration and ordinary input changes must not trigger that behavior.
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const insertFollowupPrompt = useCallback((prompt: string) => {
    if (!prompt.trim()) return;
    setInput(previous => previous.trim() ? `${previous}\n\n${prompt}` : prompt);
    setComposerFocusRequest(previous => previous + 1);
  }, [setInput]);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });

  // The displayed server-owned queue retains local File previews until its receipt changes.
  const [queuedDrafts, setQueuedDrafts] = useState<QueuedDraft[]>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return [];
    }
    return restoreQueuedDrafts(sessionKey);
  });
  const queuedDraft = queuedDrafts[0] ?? null;
  // Serialize uploads within a session so repeated Send cannot duplicate or
  // reorder the same textarea contents before its first upload finishes.
  const queueUploadsRef = useRef(new Set<string>());
  // Prevent a card from the previous render/session being promoted in the new session.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  // Keep queued-claim/ack progress and errors scoped to the originating session.
  const [steeringState, setSteeringState] = useState<{
    scope: string; message: StoredQueuedMessage; pending: boolean; error: string | null;
  } | null>(null);
  // Synchronous lock prevents two clicks/Enter from sending or queueing the same draft before React commits.
  const steeringInFlightRef = useRef<string | null>(null);
  // Reserve native submissions per draft/session while a control or new-session request is awaiting acknowledgement.
  const nativeCommandsInFlightRef = useRef(new Set<string>());

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    // The expanded body is the message itself: it skips slash-command interception.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent(), undefined, { skipCommandInterception: true });
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      if (isNativeCodexCommand(command) || isNativeClaudeCommand(command)) {
        // Exact native commands selected with Enter go through the same
        // guarded submit path; the legacy custom-command executor is not used.
        await handleSubmitRef.current?.(createFakeSubmitEvent());
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        // Everything typed after the command name is its argument text, line
        // breaks included (`[\s\S]`, unlike `.`), trimmed as the Claude Code CLI
        // does. `$ARGUMENTS` gets it verbatim; `$1`, `$2`, … get its tokens.
        // The name must open the input and end at whitespace or the end: a pick
        // from the slash menu passes the whole composer, where the name may
        // appear later or inside a longer word ("see /echo2 …" has no arguments).
        const commandMatch = effectiveInput
          .trimStart()
          .match(new RegExp(`^${escapeRegExp(command.name)}(?=\\s|$)([\\s\\S]*)`));
        const rawArgs = commandMatch ? commandMatch[1].trim() : '';
        const args = rawArgs ? rawArgs.split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          rawArgs,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      setInput,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => readUserPreference(
      PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
      {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      },
    );

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      ...(provider === 'codex' ? { codexPlanMode: permissionMode === 'plan' } : {}),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  // Read at send time through a ref: the map changes on every poll, and a
  // submit handler rebuilt that often would re-render the whole composer.
  const processingSessionsRef = useRef(processingSessions);
  useEffect(() => {
    processingSessionsRef.current = processingSessions;
  }, [processingSessions]);

  // Sending over background work asks first. The dialog is rendered by the
  // composer; the submit awaits the user's choice through this resolver.
  const [backgroundSendPrompt, setBackgroundSendPrompt] = useState<BackgroundSendPrompt | null>(null);
  const backgroundSendResolverRef = useRef<((choice: BackgroundSendChoice) => void) | null>(null);

  const askBeforeSendingOverBackgroundWork = useCallback(
    (work: string[]) => new Promise<BackgroundSendChoice>((resolve) => {
      // Only one prompt at a time: a stale one is answered "cancel".
      backgroundSendResolverRef.current?.('cancel');
      backgroundSendResolverRef.current = resolve;
      setBackgroundSendPrompt({ work });
    }),
    [],
  );

  const resolveBackgroundSendPrompt = useCallback((choice: BackgroundSendChoice) => {
    const resolve = backgroundSendResolverRef.current;
    backgroundSendResolverRef.current = null;
    setBackgroundSendPrompt(null);
    resolve?.(choice);
  }, []);

  // An unmounted composer cannot answer; let the pending submit finish.
  useEffect(() => () => {
    backgroundSendResolverRef.current?.('cancel');
    backgroundSendResolverRef.current = null;
  }, []);

  // Persist a message to send "when this finishes" and show it as a queued
  // card. Used while a turn is in flight (or earlier queued messages still
  // wait) and when the user chooses to queue behind background work.
  // Attachments must already be uploaded. Every submission is its own receipt
  // at the end of the session's FIFO queue: the server dispatches them in
  // order, one turn each, and any one of them can be steered, edited or
  // deleted on its own.
  const queueMessage = useCallback(
    (durableDraft: QueuedDraft, queuedSessionKey: string | null) => {
      if (queuedSessionKey) {
        // Only explicit Send/Edit/Delete actions write the server-owned queue.
        enqueueQueuedMessage(queuedSessionKey, storedQueuedDraft(durableDraft));
      }

      // Recorded under the session the message was queued FOR, and before
      // the session-switch return below — the queued text must be
      // recallable even when it dispatches without this composer.
      recordSentMessage(durableDraft.content, queuedSessionKey);

      // The server owns dispatch after persistence. If the user changed
      // sessions during upload, the durable record is already enough; do
      // not attach its UI card to the newly opened composer.
      if (queuedSessionKey && sessionKeyRef.current !== queuedSessionKey) {
        // The composer they left still holds the text as its draft: clear it,
        // or going back and pressing Enter would queue the same message again.
        if (readDraftText(queuedSessionKey) === durableDraft.content) {
          writeDraftText(queuedSessionKey, '');
        }
        return;
      }

      queuedDraftSessionRef.current = queuedSessionKey;
      setQueuedDrafts(current => [...current.filter(draft => draft.id !== durableDraft.id), durableDraft]);
      setInput('');
      inputValueRef.current = '';
      setAttachedFiles([]);
      setFileErrors(new Map());
      resetCommandMenuState();
      setIsTextareaExpanded(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, '');
      }
    },
    [recordSentMessage, resetCommandMenuState, setInput],
  );

  const submitMessage = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => {
      event.preventDefault();
      let nativeCommandScope: string | null = null;
      let queueUploadScope: string | null = null;
      try {
      if (steeringInFlightRef.current === sessionKey && sessionKey) return;
      if (sessionKey && queueUploadsRef.current.has(sessionKey)) return;
      setSteeringState((current) => current?.scope === sessionKey ? null : current);
      const currentInput = queuedSubmission?.content ?? inputValueRef.current;
      const currentAttachments = queuedSubmission?.attachments ?? attachedFiles;
      const previouslyUploadedAttachments = queuedSubmission?.uploadedAttachments ?? [];
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      // A custom command's expanded body is the message itself, never a command.
      const nativeCommand = submitOptions?.skipCommandInterception
        ? null
        : currentInput.match(/^\/(goal|plan)(?:\s+([\s\S]*))?$/);
      let nativeSendOptions: QueuedSendOptions = {};
      if (nativeCommand) {
        const name = `/${nativeCommand[1]}`;
        const argumentsText = (nativeCommand[2] ?? '').trim();
        if (provider !== 'codex' || !slashCommands.some((command) =>
          command.name === name && isNativeCodexCommand(command))) {
          addMessage({
            type: 'error',
            content: provider !== 'codex' ? `${name} is available only for Codex.`
              : `This node has not advertised native ${name} support. Wait for commands to load, or update the node's Codey backend.`,
            timestamp: new Date(),
          });
          return;
        }
        if (editingAnchorId) {
          addMessage({ type: 'error', content: 'Use native commands in a new message, not while editing an earlier turn.', timestamp: new Date() });
          return;
        }
        const scope = draftScopeRef.current!;
        if (nativeCommandsInFlightRef.current.has(scope)) return;
        nativeCommandsInFlightRef.current.add(scope);
        nativeCommandScope = scope;

        if (name === '/goal') {
          if (currentAttachments.length || previouslyUploadedAttachments.length) {
            addMessage({ type: 'error', content: 'Goal commands do not accept attachments. Refer to a project file in the objective instead.', timestamp: new Date() });
            return;
          }
          const control = !argumentsText || /^(?:status|help|pause|clear|budget)(?:\s|$)/.test(argumentsText)
            || argumentsText === 'edit';
          if (control) {
            try {
              const response = await api.commands.goal(selectedSession?.id || currentSessionId || null, argumentsText);
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || `Goal command failed (${response.status})`);
              if (draftScopeRef.current !== scope) return;
              addMessage({ type: 'assistant', content: result.message, timestamp: new Date() });
              if (inputValueRef.current === currentInput) {
                const draft = typeof result.draft === 'string' ? result.draft : '';
                setInput(draft);
                inputValueRef.current = draft;
                resetCommandMenuState();
              }
            } catch (error) {
              if (draftScopeRef.current === scope) {
                addMessage({ type: 'error', content: error instanceof Error ? error.message : 'Goal command failed.', timestamp: new Date() });
              }
            }
            return;
          }
          if (permissionMode === 'plan') {
            addMessage({ type: 'error', content: 'Use /plan off before starting or resuming an autonomous goal.', timestamp: new Date() });
            return;
          }
        } else {
          if (!selectPermissionMode) return;
          if (resolvePermissionModeForProvider('codex', 'plan') !== 'plan') {
            addMessage({
              type: 'error',
              content: 'Native Plan Mode is not available in this node capability snapshot. Wait for capabilities to load or update the node backend.',
              timestamp: new Date(),
            });
            return;
          }
          const toggleOnly = !argumentsText || argumentsText === 'on' || argumentsText === 'off';
          if (toggleOnly && (currentAttachments.length || previouslyUploadedAttachments.length)) {
            addMessage({ type: 'error', content: 'Add a prompt after /plan to send attachments, or remove them before switching modes.', timestamp: new Date() });
            return;
          }
          if (toggleOnly) {
            // Leaving planning returns to normal approval mode, never silently
            // restores a previous full-access grant.
            const nextMode = argumentsText === 'off' || (!argumentsText && permissionMode === 'plan') ? 'default' : 'plan';
            selectPermissionMode(nextMode);
            addMessage({
              type: 'assistant',
              content: nextMode === 'plan'
                ? 'Codex Plan Mode enabled for the next message. Use /plan off to return to normal mode.'
                : 'Codex Plan Mode disabled. Normal approval mode will apply to the next message.',
              timestamp: new Date(),
            });
            setInput('');
            inputValueRef.current = '';
            resetCommandMenuState();
            return;
          }
          if (!isLoading) selectPermissionMode('plan');
          // React may not render the new mode before the first send.
          nativeSendOptions = { permissionMode: 'plan', codexPlanMode: true };
        }
        if (isLoading) {
          addMessage({ type: 'error', content: 'Wait for the current run to finish before starting a native command. /goal pause and /goal clear remain available while it runs.', timestamp: new Date() });
          return;
        }
      }

      // A turn is already in flight: stash this message instead of sending it.
      // Upload attached files now so the queued record contains durable image
      // descriptors that can be sent even if another session is open later.
      if (isLoading || (sessionKey && readQueuedMessages(sessionKey).length > 0)) {
        // A run can restart in the tiny gap between scheduling and flushing a
        // queued submission. Put the same durable draft back without uploading
        // its files again.
        if (queuedSubmission) {
          if (sessionKey) enqueueQueuedMessage(sessionKey, storedQueuedDraft(queuedSubmission));
          queuedDraftSessionRef.current = sessionKey;
          if (sessionKey) setQueuedDrafts(restoreQueuedDrafts(sessionKey));
          return;
        }

        const queuedOptions = { ...buildSendOptions(currentInput), ...nativeSendOptions };
        const queuedSessionKey = sessionKey;
        if (queuedSessionKey) {
          queueUploadScope = queuedSessionKey;
          queueUploadsRef.current.add(queuedSessionKey);
        }
        let uploadedAttachments: unknown[] = [];
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Queued file upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        queueMessage({
          id: crypto.randomUUID(),
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments,
          options: queuedOptions,
        }, queuedSessionKey);
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (
        !nativeCommand
        && !submitOptions?.skipCommandInterception
        && (commandInput.startsWith('/') || isHelpAlias)
      ) {
        // The name ends at the first whitespace of any kind, so "/cmd" followed
        // by a line break still runs /cmd (the Claude Code CLI splits the same way).
        const firstWhitespace = commandInput.search(/\s/);
        const commandName = isHelpAlias
          ? '/help'
          : firstWhitespace > 0 ? commandInput.slice(0, firstWhitespace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        // Skills and Claude Code's own commands are Claude's to run, so they
        // go out as an ordinary message.
        if (matchedCommand && matchedCommand.type !== 'skill' && !isNativeClaudeCommand(matchedCommand)) {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          recordSentMessage(currentInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      const messageContent = currentInput;

      let uploadedAttachments = previouslyUploadedAttachments;
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      if (nativeCommandScope && draftScopeRef.current !== nativeCommandScope) return;
      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        try {
          const response = await api.providers.createSession({
            provider,
            projectPath: resolvedProjectPath,
            initialMessage: messageContent,
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          const returnedSessionName = typeof body?.data?.sessionName === 'string'
            ? body.data.sessionName.trim()
            : '';
          if (returnedSessionName) {
            createdSessionName = returnedSessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        // Navigation during session allocation must not start a goal in the
        // background, route back to the old project, or clear the new draft.
        if (nativeCommandScope && draftScopeRef.current !== nativeCommandScope) return;
        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: createdSessionName,
        });
      }

      // A new turn replaces the CLI process a session's background work runs
      // under: the agents, workflows and commands it still has going are
      // stopped, or finish where nothing is listening. Sending is the user's
      // call, but not one to make for them — and queueing behind the work,
      // which the server holds until it finishes, is the safe alternative.
      const backgroundActivity = processingSessionsRef.current?.get(targetSessionId);
      if (backgroundActivity?.background) {
        const work = ownBackgroundTasks(backgroundActivity.tasks ?? [])
          .map((task) => describeBackgroundTask(task, t));
        const choice = await askBeforeSendingOverBackgroundWork(work);
        if (choice === 'cancel') {
          return;
        }
        if (choice === 'queue') {
          if (queuedSubmission) {
            if (sessionKey) {
              enqueueQueuedMessage(sessionKey, storedQueuedDraft(queuedSubmission));
              queuedDraftSessionRef.current = sessionKey;
              setQueuedDrafts(restoreQueuedDrafts(sessionKey));
            }
            return;
          }
          // Attachments were uploaded above; queue the same descriptors.
          queueMessage({
            id: crypto.randomUUID(),
            content: currentInput,
            attachments: currentAttachments,
            uploadedAttachments,
            options: { ...buildSendOptions(currentInput), ...nativeSendOptions },
          }, targetSessionId);
          return;
        }
      }

      const attachmentRecords = uploadedAttachments as ChatAttachment[];
      // A native correction can be persisted under a turn that started long
      // before this send. Correlate the echo by identity, not by its clock.
      // Claude keeps this id as the prompt row's uuid, which also pairs
      // identical repeated texts exactly. Claude Code names the rows of local
      // slash commands (/compact, /context) itself, so those keep the
      // text-and-time match an echo without an identity falls back to.
      const clientMessageId = provider === 'codex'
        || (provider === 'claude' && !messageContent.trimStart().startsWith('/'))
        ? crypto.randomUUID()
        : undefined;
      const userMessage: ChatMessage = {
        type: 'user',
        ...(clientMessageId ? { clientMessageId } : {}),
        content: currentInput,
        images: attachmentRecords.filter(isImageAttachment),
        files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
        timestamp: new Date(),
        // Tags this echo as the replacement, so the truncation the server
        // broadcasts a moment later cuts the turns being replaced without
        // taking the message the user just sent with them.
        ...(editingAnchorId ? { replacesAnchorId: editingAnchorId } : {}),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      sendMessage({
        // Replacing an already-sent message is its own frame: it changes the
        // shape of the conversation, so it gets validated separately and can
        // report why it was refused.
        type: editingAnchorId ? 'chat.edit-send' : 'chat.send',
        sessionId: targetSessionId,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(editingAnchorId ? { anchorId: editingAnchorId } : {}),
        content: messageContent,
        options: {
          ...(queuedSubmission?.options ?? buildSendOptions(messageContent)),
          ...nativeSendOptions,
          attachments: uploadedAttachments,
        },
      });
      setEditingAnchorId(null);

      // Recorded under the (possibly just-allocated) session id, so the first
      // message of a new chat lands in the history of the session the user is
      // navigated to. Queued drafts were recorded when they were queued; the
      // consecutive-duplicate check keeps this second call a no-op.
      recordSentMessage(currentInput, targetSessionId);
      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      setAttachedFiles([]);
      setFileErrors(new Map());
      setIsTextareaExpanded(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, '');
      }
      } finally {
        if (nativeCommandScope) nativeCommandsInFlightRef.current.delete(nativeCommandScope);
        if (queueUploadScope) queueUploadsRef.current.delete(queueUploadScope);
      }
    },
    [
      selectedSession,
      askBeforeSendingOverBackgroundWork,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      editingAnchorId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      permissionMode,
      selectPermissionMode,
      resolvePermissionModeForProvider,
      queueMessage,
      recordSentMessage,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      setInput,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
      t,
    ],
  );

  const handleSteerQueued = useCallback(async (messageId?: string) => {
    const scope = sessionKey;
    const saved = scope ? readQueuedMessages(scope).find((message, index) => messageId ? message.id === messageId : index === 0) : null;
    const draft = queuedDrafts.find(candidate => matchesQueuedDraft(candidate, saved ?? null));
    if (!scope || !isLoading || !steerMessage || editingAnchorId
      || steeringInFlightRef.current || queuedDraftSessionRef.current !== scope
      || !saved || saved.steerHold || !draft || draft.steerHold) return;

    steeringInFlightRef.current = scope;
    setSteeringState({ scope, message: saved, pending: true, error: null });
    try {
      // Send first persists the queue and uploads its files. Wait for that save,
      // then promote the exact receipt; never read or re-upload the new textarea draft.
      await flushChatDraft(scope);
      await steerMessage(scope, saved.content, saved.attachments ?? saved.images ?? [], saved);
      forgetQueuedMessage(scope, saved);
      if (sessionKeyRef.current === scope) {
        setQueuedDrafts(current => current.filter(candidate => !matchesQueuedDraft(candidate, saved)));
        setIsUserScrolledUp(false);
        scrollToBottom();
      }
      // No optimistic echo or new-run activity: the accepted
      // prompt arrives through the existing run's sequenced websocket stream.
      setSteeringState({ scope, message: saved, pending: false, error: null });
    } catch (error) {
      // A lost acknowledgement is not permission to send again. Mark only the
      // local receipt for review; the server restores/holds it atomically on failure.
      if (error && typeof error === 'object' && 'queueHeld' in error && error.queueHeld === true) {
        holdQueuedMessage(scope, saved);
        if (sessionKeyRef.current === scope) {
          setQueuedDrafts(current => current.map(candidate => matchesQueuedDraft(candidate, saved)
            ? { ...candidate, steerHold: 'unconfirmed' } : candidate));
        }
      }
      setSteeringState({
        scope, message: saved, pending: false, error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      steeringInFlightRef.current = null;
      // Reconcile another device's edit or the dispatcher's claim without ever
      // writing a stale React snapshot back into the queue.
      void hydrateChatDrafts();
    }
  }, [
    editingAnchorId, isLoading, queuedDrafts,
    scrollToBottom, sessionKey, setIsUserScrolledUp, steerMessage,
  ]);

  // Chat scopes with a submit still awaiting its upload or, for a brand-new
  // chat, its session id. The composer does not change until that returns (the
  // text stays, send stays enabled), so on a slow server the user submits
  // again — and each extra submit of a new chat allocated its own session and
  // sent it the same first message.
  const submittingScopesRef = useRef(new Set<string>());

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: QueuedDraft,
      submitOptions?: SubmitOptions,
    ) => {
      const scope = draftScopeRef.current ?? '';
      if (submittingScopesRef.current.has(scope)) {
        // Still cancel the event: an ignored form submit must not reload the page.
        event.preventDefault();
        return;
      }
      submittingScopesRef.current.add(scope);
      try {
        await submitMessage(event, queuedSubmission, submitOptions);
      } finally {
        submittingScopesRef.current.delete(scope);
      }
    },
    [submitMessage],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // The VPS dispatcher owns sending. While the card is visible, periodically
  // reconcile the server receipt so the UI notices claims and held/remote edits.
  useEffect(() => {
    if (!sessionKey || !queuedDraft) {
      return;
    }
    const timer = setInterval(() => void hydrateChatDrafts(), 5_000);
    // A hidden tab's timers are throttled (to about once a minute after a few
    // minutes), so its cards can be far behind; catch up as soon as it is shown.
    const reconcileWhenShown = () => {
      if (document.visibilityState === 'visible') {
        void hydrateChatDrafts();
      }
    };
    document.addEventListener('visibilitychange', reconcileWhenShown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', reconcileWhenShown);
    };
  }, [queuedDraft, sessionKey]);

  // Editing or deleting a card takes that message off the server's queue at
  // once, before the dispatcher's next poll can send it.
  const editQueuedDraft = useCallback((messageId?: string) => {
    const draft = queuedDrafts.find((candidate, index) => messageId ? candidate.id === messageId : index === 0);
    if (!draft || !sessionKey || queuedDraftSessionRef.current !== sessionKey
      || steeringInFlightRef.current === sessionKey) {
      return;
    }
    clearQueuedMessage(sessionKey, storedQueuedDraft(draft));
    setSteeringState(null);
    setQueuedDrafts(current => current.filter(candidate => candidate !== draft));
    setInput(draft.content);
    inputValueRef.current = draft.content;
    setAttachedFiles(draft.attachments);
    textareaRef.current?.focus();
  }, [queuedDrafts, sessionKey, setInput]);

  const deleteQueuedDraft = useCallback((messageId?: string) => {
    if (!sessionKey || steeringInFlightRef.current === sessionKey) return;
    const draft = queuedDrafts.find((candidate, index) => messageId ? candidate.id === messageId : index === 0);
    if (!draft) return;
    clearQueuedMessage(sessionKey, storedQueuedDraft(draft));
    setSteeringState(null);
    setQueuedDrafts(current => current.filter(candidate => candidate !== draft));
  }, [queuedDrafts, sessionKey]);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const prefix = base ? `${base} ` : '';
    const next = `${prefix}${text}`;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
    return { prefix, transcript: text, draft: next };
  }, [setInput]);

  // React's functional update is the final compare-and-set: a pending local
  // edit or a hydrated draft wins even if a network callback saw older props.
  const replaceComposerDraft = useCallback((expected: string, replacement: string) => {
    const scope = draftScope;
    if (draftScopeRef.current !== scope) return;
    setInputState((previous) => previous.scope === scope && previous.value === expected &&
      draftScopeRef.current === scope ? { scope, value: replacement } : previous);
  }, [draftScope]);

  // A committed rewrite/undo must reach the submit reader before the next
  // keyboard event, without sending anything from the rewrite callback itself.
  useLayoutEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    // Queue changes/other sessions also notify this store. They must not replace
    // freshly typed React text whose own persistence effect has not run yet.
    let lastSavedInput: string | undefined;
    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      if (savedInput === lastSavedInput) return;
      lastSavedInput = savedInput;
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    return subscribeToChatDrafts(restoreDraft);
  }, [draftScope]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  // Restoring, hydrating and accepting are read-only queue operations. Persisting
  // from an effect would resurrect a consumed queue or erase another device's edit.
  // Switching sessions swaps in that session's queued messages. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    let switched = queuedDraftSessionRef.current !== sessionKey;
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDrafts([]);
      return;
    }
    const restoreQueue = () => {
      if (steeringInFlightRef.current === sessionKey) return;
      const saved = readQueuedMessages(sessionKey);
      const retainFiles = !switched;
      switched = false;
      setQueuedDrafts(current => {
        const restored = restoreQueuedDrafts(sessionKey);
        return restored.map((draft, index) => {
          const existing = retainFiles ? current.find(candidate => matchesQueuedDraft(candidate, saved[index])) : undefined;
          return existing ? { ...existing, steerHold: draft.steerHold } : draft;
        });
      });
    };
    restoreQueue();
    return subscribeToChatDrafts(restoreQueue);
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (isComposerModeShortcut(event)) {
        event.preventDefault();
        if (!event.repeat) cyclePermissionMode();
        return;
      }
      // Modified Tab belongs to browser/focus navigation, not menus or permissions.
      if (event.key === 'Tab' && (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey)) return;
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      // ArrowUp in an empty composer recalls sent messages. A bare Tab is left
      // to the slash menu and to accepting an inline completion; the permission
      // mode cycles on the composer mode shortcut above.
      if (handleHistoryKeyDown(event)) {
        return;
      }

      if (event.key === 'Enter') {
        const endedJustNow =
          performance.now() - lastCompositionEndAtRef.current < SAFARI_IME_RACE_WINDOW_MS;
        if (event.nativeEvent.isComposing || isComposingRef.current || endedJustNow) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      handleSubmit,
      sendByCtrlEnter,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
      ...(activeRunId ? { expectedRunId: activeRunId } : {}),
    });
  }, [activeRunId, canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
    },
    [],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [setInput]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    setInput('');
    inputValueRef.current = '';
  }, [setInput]);

  return {
    input,
    setInput,
    insertFollowupPrompt,
    composerFocusRequest,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    handleSteerQueued,
    isSteering: steeringState?.scope === sessionKey && steeringState.pending,
    steeringMessageId: steeringState?.scope === sessionKey ? steeringState.message.id : undefined,
    steerError: steeringState?.scope === sessionKey && queuedDrafts.some(draft => matchesQueuedDraft(draft, steeringState.message))
      ? steeringState.error : null,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    queuedDraft,
    queuedDrafts,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    replaceVoiceDraft: replaceComposerDraft,
    replaceComposerDraft,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
