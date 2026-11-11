import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import type { PendingSteer, SteerOutcome, BackgroundSendChoice, BackgroundSendPrompt, SessionOpenElsewhere, SessionTakeOverPrompt, StoredQueuedMessage, SteerChatMessage, CommandModalPayload, CostCommandData, HelpCommandData, MarkSessionProcessing, ModelCommandData, QueuedDraft, SessionActivityMap, StatusCommandData,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand } from '@/shared/types';
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
import { useAskSideQuestion } from '@/modules/chat/hooks/useSideQuestions';

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
  /** The running turn takes queued messages now (useChatSteering's `canSteerQueued`). */
  canSteerQueued?: boolean;
  /** Whether the chat socket is currently open; a side-question ask while it is not would send nothing and leave the optimistic entry pending forever. */
  isConnected?: boolean;
  sendByCtrlEnter?: boolean;
  /** From the capability matrix, like `supportsSideQuestions`: whether the provider can take a message into a running turn (`chat.steer`). Gates the send menu's Steer choice. */
  supportsSteering?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  /**
   * Asked before a brand-new conversation's session is allocated: the project
   * of a worktree made for it (useNewSessionWorktree), or null to start in the
   * selected project.
   */
  prepareNewSessionProject?: () => Promise<Project | null>;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /** From the capability matrix, exactly like `supportsSessionForking`; false until it has loaded. Gates the `/btw` branch. */
  supportsSideQuestions?: boolean;
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
  /**
   * Keep the message queued until the running turn ends, where a Claude turn
   * would take it at once (Alt+Enter, or the tools menu).
   */
  queueUntilTurnEnds?: boolean;
  /**
   * The send menu already answered the background-work question before
   * `submitMessage` runs, so the dialog that would ask it again never opens.
   */
  presetBackgroundChoice?: 'queue' | 'send';
  /**
   * The send menu's Steer row: while a turn runs, send the message into it
   * (read at the agent's next tool call) instead of queueing it for after.
   * Falls through to the ordinary send when no turn is running any more.
   */
  steerIntoTurn?: boolean;
};

// Claude Code runs a slash command as a turn of its own, so the node never
// steers one into a running turn (claude-runtime's steering); it stays queued.
const CLAUDE_SLASH_COMMAND = /^\/[\w:.-]+(?:\s|$)/;

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

/**
 * A v4 UUID for a steered message. The id becomes the message's transcript
 * uuid, so it must be a real one. `crypto.randomUUID` only exists in secure
 * contexts, and the app is often opened over plain http on a LAN address
 * (a phone on the same network), so this falls back to `getRandomValues`.
 */
const createSteerMessageId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Whether a live user message is the echo of the steered message with this id. */
const isEchoOfSteer = (echoId: string, messageId: string): boolean => (
  // A text-only message is echoed under its own id; one with images is split
  // into parts named `<id>_text_<n>` / `<id>_images`.
  echoId === messageId || echoId.startsWith(`${messageId}_`)
);

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

/**
 * A phone or tablet types through an on-screen keyboard: its return key is
 * labelled "new line", and Shift+Enter — the desktop combination for a newline
 * in Enter-to-send mode — cannot be typed on it at all. `(pointer: coarse)`
 * marks exactly those primary inputs; a touch laptop keeps its fine primary
 * pointer and with it the desktop Enter behaviour.
 */
function isSoftKeyboardEnvironment(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(pointer: coarse)').matches;
}

/** The composer's input state machine — text, drafts, sending, queueing and the keyboard handling around them; used by ChatInterface. */
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
  canSteerQueued = false,
  isConnected = true,
  supportsSideQuestions = false,
  sendByCtrlEnter,
  supportsSteering = false,
  onSessionProcessing,
  onSessionEstablished,
  prepareNewSessionProject,
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
  // Always the composer's own `sendMessage`, never `useWebSocket()` directly,
  // which throws outside a provider and would break the composer's tests.
  const askSideQuestion = useAskSideQuestion(sendMessage);
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
  // Queued messages sent while a Claude turn runs, by receipt id, that join
  // that turn as soon as it takes them (see the effect after handleSteerQueued).
  const joiningTurnIdsRef = useRef(new Set<string>());
  // Reserve native submissions per draft/session while a control or new-session request is awaiting acknowledgement.
  const nativeCommandsInFlightRef = useRef(new Set<string>());
  // Messages this tab sent into a running turn that the agent has not read
  // yet. Each is a card above the composer until its echo reaches the
  // transcript; the run ending without it puts the text back in the composer,
  // and a refusal (the turn had already ended) queues it as the next turn.
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  // Read by the outcome handler, which the realtime listener calls between
  // renders: a refusal can follow an acceptance before React re-renders.
  // Written only through `updatePendingSteers` below, with the state.
  const pendingSteersRef = useRef(pendingSteers);

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
      ...(selectedProject?.workbenchProjectId ? { workbenchProjectId: selectedProject.workbenchProjectId } : {}),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
    selectedProject?.workbenchProjectId,
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

  // The last turn this composer sent to each session, so a Claude turn the
  // node refused because `claude` in a terminal has the session open can be
  // resent once the user agrees to end that process.
  const lastSentTurnsRef = useRef(new Map<string, { clientMessageId?: string; options: Record<string, unknown> }>());
  const [takeOverPrompt, setTakeOverPrompt] = useState<SessionTakeOverPrompt | null>(null);
  const takeOverPromptRef = useRef<SessionTakeOverPrompt | null>(null);
  // A side question never touches the session: on a successful ask, the
  // typed text is cleared the same way a sent message is, without the parts
  // (queued draft, session processing) that belong only to an actual turn.
  // A side question cannot carry attachments, so they are left untouched — unlike a real
  // send, which takes them. Called only when `askSideQuestion` returned
  // `true`; a refusal (no connection) leaves the text in place too, so the
  // user does not lose what they typed.
  //
  // Also ends edit mode, matching `cancelEditMessage`: a side question asked
  // while editing a sent message must not leave `editingAnchorId` set over
  // the now-empty composer, which previously turned the next plain send into
  // a `chat.edit-send` that replaced the edited turn and everything after it.
  const clearComposerAfterSideQuestion = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    setEditingAnchorId(null);
    resetCommandMenuState();
    setIsTextareaExpanded(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    if (draftScopeRef.current) {
      writeDraftText(draftScopeRef.current, '');
    }
  }, [resetCommandMenuState, setInput]);

  // Shared by the `/btw` command, Option/Alt+Enter, the background-send
  // dialog's side question choice and the send menu's side question row: all
  // four ask the same way and clear the composer the same way on success, and
  // refuse the same way when there is nothing to ask it on — no connection,
  // no provider support, or (a brand-new chat) no session yet. Without this
  // check here, a caller with no session relied on `useAskSideQuestion`
  // refusing a null `sessionId` on its own, which it does silently: the
  // keypress did nothing, with no error and no explanation. Checking it once,
  // here, means every caller gets the same `noSession` message instead of
  // each needing its own copy of the check.
  const askSideQuestionAndClear = useCallback(
    (sessionId: string | null, text: string) => {
      if (!supportsSideQuestions) {
        addMessage({
          type: 'error',
          content: t('sideQuestion.unsupported'),
          timestamp: Date.now(),
        });
        return;
      }
      if (!sessionId) {
        addMessage({
          type: 'error',
          content: t('sideQuestion.noSession'),
          timestamp: Date.now(),
        });
        return;
      }
      if (askSideQuestion(sessionId, text, { model: currentProviderModel }, isConnected)) {
        clearComposerAfterSideQuestion();
      }
    },
    [addMessage, askSideQuestion, clearComposerAfterSideQuestion, currentProviderModel, isConnected, supportsSideQuestions, t],
  );


  // Asks only about a refusal of the turn this composer sent last: a refusal
  // replayed to a reopened tab, or one of another tab's sends, is just shown.
  const askToTakeOverSession = useCallback((sessionId: string, holder: SessionOpenElsewhere) => {
    const turn = lastSentTurnsRef.current.get(sessionId);
    if (!turn || !holder.messageId || turn.clientMessageId !== holder.messageId) {
      return;
    }
    const prompt = { sessionId, pid: holder.pid, entrypoint: holder.entrypoint };
    takeOverPromptRef.current = prompt;
    setTakeOverPrompt(prompt);
  }, []);

  // Confirming resends the refused turn, with the same identity, as one that
  // may end the terminal's process; the bubble already on screen stays its own.
  const resolveTakeOverPrompt = useCallback((confirmed: boolean) => {
    const prompt = takeOverPromptRef.current;
    takeOverPromptRef.current = null;
    setTakeOverPrompt(null);
    const turn = prompt ? lastSentTurnsRef.current.get(prompt.sessionId) : undefined;
    if (!prompt || !turn) {
      return;
    }
    lastSentTurnsRef.current.delete(prompt.sessionId);
    if (confirmed) {
      onSessionProcessing?.(prompt.sessionId, { statusText: null, canInterrupt: true });
      sendMessage({ ...turn, options: { ...turn.options, takeOver: true } });
    }
  }, [onSessionProcessing, sendMessage]);

  // Persist a message to send "when this finishes" and show it as a queued
  // card. Used while a turn is in flight (or earlier queued messages still
  // wait) and when the user chooses to queue behind background work.
  // Attachments must already be uploaded. Every submission is its own receipt
  // at the end of the session's FIFO queue: the server dispatches them in
  // order, one turn each, and any one of them can be steered, edited or
  // deleted on its own.
  const queueMessage = useCallback(
    (durableDraft: QueuedDraft, queuedSessionKey: string | null, { fromComposer = true } = {}) => {
      durableDraft = { ...durableDraft, id: durableDraft.id ?? crypto.randomUUID() };
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
        if (fromComposer && readDraftText(queuedSessionKey) === durableDraft.content) {
          writeDraftText(queuedSessionKey, '');
        }
        return;
      }

      queuedDraftSessionRef.current = queuedSessionKey;
      setQueuedDrafts(current => [...current.filter(draft => draft.id !== durableDraft.id), durableDraft]);
      if (!fromComposer) return;
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

  // Every change to the pending steers goes through here so the ref the
  // outcome handler reads is never behind the state.
  const updatePendingSteers = useCallback((update: (current: PendingSteer[]) => PendingSteer[]) => {
    const next = update(pendingSteersRef.current);
    pendingSteersRef.current = next;
    setPendingSteers(next);
  }, []);

  // Sends a message into the session's running turn (`chat.steer`): the agent
  // reads it at its next tool call, without the turn stopping. It leaves the
  // composer at once, as a sent message does, and waits as a card until the
  // agent reads it. Attachments must already be uploaded.
  const steerIntoRunningTurn = useCallback(
    (message: { content: string; attachments: File[]; uploadedAttachments: unknown[] }, steerSessionKey: string) => {
      const messageId = createSteerMessageId();
      updatePendingSteers((current) => [...current, {
        messageId,
        sessionKey: steerSessionKey,
        content: message.content,
        attachments: message.attachments,
        uploadedAttachments: message.uploadedAttachments,
        status: 'sending',
      }]);
      sendMessage({
        type: 'chat.steer',
        sessionId: steerSessionKey,
        messageId,
        content: message.content,
        options: { attachments: message.uploadedAttachments },
      });
      recordSentMessage(message.content, steerSessionKey);

      if (sessionKeyRef.current === steerSessionKey) {
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
      } else if (readDraftText(steerSessionKey) === message.content) {
        // The user changed sessions during the upload; the composer they left
        // must not still hold the message as its draft.
        writeDraftText(steerSessionKey, '');
      }
    },
    [recordSentMessage, resetCommandMenuState, sendMessage, setInput, updatePendingSteers],
  );

  /**
   * Settles a steered message as the realtime handler reports on it. Used by
   * ChatInterface, which hands it to the realtime handler.
   */
  const handleSteerOutcome = useCallback(
    (_sessionId: string, messageId: string, outcome: SteerOutcome) => {
      if (outcome === 'delivered') {
        if (pendingSteersRef.current.some((steer) => isEchoOfSteer(messageId, steer.messageId))) {
          updatePendingSteers((current) => current.filter((steer) => !isEchoOfSteer(messageId, steer.messageId)));
        }
        return;
      }

      const steer = pendingSteersRef.current.find((candidate) => candidate.messageId === messageId);
      if (!steer) {
        return;
      }
      if (outcome === 'accepted') {
        updatePendingSteers((current) => current.map((candidate) => (
          candidate.messageId === messageId ? { ...candidate, status: 'accepted' } : candidate
        )));
        return;
      }

      // Refused: the turn had already ended when it arrived. The user meant it
      // for this conversation now, so it goes out as the next turn — the
      // queue sends it as soon as the session is idle, which it about is.
      updatePendingSteers((current) => current.filter((candidate) => candidate.messageId !== messageId));
      void queueMessage({
        content: steer.content,
        attachments: steer.attachments,
        uploadedAttachments: steer.uploadedAttachments,
        options: buildSendOptions(steer.content),
      }, steer.sessionKey, { fromComposer: false });
    },
    [buildSendOptions, queueMessage, updatePendingSteers],
  );

  // The run ended with a steered message the server took but the agent never
  // read — the user stopped the run, or it failed. Nothing will send it now,
  // so it goes back into the composer (ahead of anything typed since) rather
  // than vanishing or being sent behind the user's back after a stop.
  const wasLoadingRef = useRef(isLoading);
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoading;
    if (!wasLoading || isLoading || !sessionKey) {
      return;
    }
    const unread = pendingSteersRef.current.filter(
      (steer) => steer.sessionKey === sessionKey && steer.status === 'accepted',
    );
    if (unread.length === 0) {
      return;
    }
    updatePendingSteers((current) => current.filter((steer) => !unread.includes(steer)));
    const restored = [...unread.map((steer) => steer.content), inputValueRef.current]
      .filter((part) => part.trim())
      .join('\n\n');
    setInput(restored);
    inputValueRef.current = restored;
    setAttachedFiles((current) => [...unread.flatMap((steer) => steer.attachments), ...current]);
    writeDraftText(sessionKey, restored);
  }, [isLoading, sessionKey, setInput, updatePendingSteers]);

  // Cards belong to the session they were sent into; switching away drops
  // them (the messages themselves are already the run's, on the server).
  useEffect(() => {
    if (pendingSteersRef.current.some((steer) => steer.sessionKey !== sessionKey)) {
      updatePendingSteers((current) => current.filter((steer) => steer.sessionKey === sessionKey));
    }
  }, [sessionKey, updatePendingSteers]);

  // Only the open session's cards are shown.
  const visiblePendingSteers = useMemo(
    () => pendingSteers.filter((steer) => steer.sessionKey === sessionKey),
    [pendingSteers, sessionKey],
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

      // `/btw <question>` never becomes a turn: checked before the in-flight
      // queue below, since that branch runs before slash-command
      // interception ever would. Recognised in every state, including a
      // brand-new chat that has no session yet — there is nothing to ask it
      // on the side of, so `askSideQuestionAndClear` refuses it with an error
      // instead of falling through to the normal send path below, which
      // would otherwise allocate a session and send the raw `/btw ...` text
      // as a turn. A queued re-dispatch never carries this prefix, so it is
      // skipped.
      if (!queuedSubmission && !submitOptions?.skipCommandInterception) {
        const btwMatch = currentInput.trim().match(/^\/btw(?:\s+([\s\S]*))?$/i);
        if (btwMatch) {
          askSideQuestionAndClear(sessionKey, btwMatch[1] ?? '');
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

        // Steering sends the message into the running turn instead of after
        // it, when the send menu asked for that and the provider can take it.
        // A slash command is a turn of its own, so it always waits in the queue.
        const steersIntoTurn = submitOptions?.steerIntoTurn === true
          && supportsSteering && !steerMessage
          && Boolean(sessionKey)
          && !currentInput.trimStart().startsWith('/');
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

        if (steersIntoTurn && queuedSessionKey) {
          steerIntoRunningTurn({
            content: currentInput,
            attachments: currentAttachments,
            uploadedAttachments,
          }, queuedSessionKey);
          return;
        }

        const receiptId = crypto.randomUUID();
        queueMessage({
          id: receiptId,
          content: currentInput,
          attachments: currentAttachments,
          uploadedAttachments,
          options: queuedOptions,
        }, queuedSessionKey);
        // Like Claude Desktop, a Claude turn takes what is sent while it runs.
        // A card left behind by a session switch during the upload just waits.
        if (provider === 'claude' && isLoading && steerMessage && !submitOptions?.queueUntilTurnEnds
          && !CLAUDE_SLASH_COMMAND.test(currentInput.trimStart())
          && queuedSessionKey && queuedSessionKey === sessionKeyRef.current) {
          joiningTurnIdsRef.current.add(receiptId);
        }
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
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        let sessionProject = selectedProject;
        if (prepareNewSessionProject) {
          try {
            sessionProject = (await prepareNewSessionProject()) ?? selectedProject;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            addMessage({
              type: 'error',
              content: t('newSessionWorktree.failed', {
                message,
                defaultValue: 'Failed to create the worktree: {{message}}',
              }),
              timestamp: new Date(),
            });
            return;
          }
        }
        let createdSessionName = sessionSummary;
        try {
          const response = await api.providers.createSession({
            provider,
            projectPath: sessionProject.fullPath || sessionProject.path || '',
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
          project: sessionProject,
          summary: createdSessionName,
        });
      }

      // A new turn replaces the CLI process a session's background work runs
      // under: the agents, workflows and commands it still has going are
      // stopped, or finish where nothing is listening. Sending is the user's
      // call, but not one to make for them — and queueing behind the work,
      // which the server holds until it finishes, is the safe alternative.
      // Tasks the session scheduled are no reason to ask: Claude Code takes
      // them over when it resumes the session for the new turn.
      const backgroundActivity = processingSessionsRef.current?.get(targetSessionId);
      if (backgroundActivity?.background && (backgroundActivity.tasks?.length ?? 0) > 0) {
        const work = ownBackgroundTasks(backgroundActivity.tasks ?? [])
          .map((task) => describeBackgroundTask(task, t));
        const choice = submitOptions?.presetBackgroundChoice ?? await askBeforeSendingOverBackgroundWork(work);
        if (choice === 'cancel') {
          return;
        }
        if (choice === 'sideQuestion') {
          askSideQuestionAndClear(targetSessionId, currentInput);
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
      const sentTurn = {
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
      };
      // An edit has already rewound the conversation when it is refused, so
      // only a plain send can be resent as it was.
      if (clientMessageId && !editingAnchorId) {
        lastSentTurnsRef.current.set(targetSessionId, sentTurn);
      }
      sendMessage(sentTurn);
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
      askSideQuestionAndClear,
      attachedFiles,
      buildSendOptions,
      currentSessionId,
      editingAnchorId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      prepareNewSessionProject,
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
      steerMessage,
      steerIntoRunningTurn,
      supportsSteering,
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

  // A message sent while a Claude turn runs joins that turn, as in Claude
  // Desktop: it is queued first, so nothing is lost, then appended like
  // 立即追加 once the run takes queued messages, one at a time and in order.
  // Claude Code reads it at its next tool boundary. One the turn did not take
  // stays queued and is sent after the turn, like any other.
  useEffect(() => {
    const joining = joiningTurnIdsRef.current;
    if (!isLoading) {
      joining.clear();
      return;
    }
    if (joining.size === 0 || !sessionKey || !canSteerQueued || editingAnchorId || steeringInFlightRef.current) {
      return;
    }
    const nextId = readQueuedMessages(sessionKey).find((message) => message.id && joining.has(message.id))?.id;
    if (!nextId) {
      return;
    }
    joining.delete(nextId);
    void handleSteerQueued(nextId);
  }, [canSteerQueued, editingAnchorId, handleSteerQueued, isLoading, sessionKey, steeringState]);

  // Another session's composer does not carry this one's messages into its turn.
  useEffect(() => () => joiningTurnIdsRef.current.clear(), [sessionKey]);

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

  // The send menu's entry point: side question never becomes a turn, so it never goes
  // through `submitMessage`; Queue and Send anyway answer the background-work
  // question the menu already asked, so the dialog never opens for them; Steer
  // goes through the submit like Queue does (same upload and validation) and
  // only diverges once the message is ready to leave the composer.
  const handleSendMenuChoice = useCallback(
    async (choice: 'queue' | 'steer' | 'sideQuestion' | 'send'): Promise<void> => {
      if (choice === 'sideQuestion') {
        askSideQuestionAndClear(sessionKey, inputValueRef.current);
        return;
      }
      if (choice === 'steer') {
        await handleSubmit(createFakeSubmitEvent(), undefined, { steerIntoTurn: true });
        return;
      }
      await handleSubmit(createFakeSubmitEvent(), undefined, { presetBackgroundChoice: choice, queueUntilTurnEnds: choice === 'queue' });
    },
    [askSideQuestionAndClear, handleSubmit, sessionKey],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // The tools menu's way to keep a message for after the running Claude turn.
  const handleQueueUntilTurnEnds = useCallback(() => {
    void handleSubmit(createFakeSubmitEvent(), undefined, { queueUntilTurnEnds: true });
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
      if (event.key === 'Enter') {
        const endedJustNow =
          performance.now() - lastCompositionEndAtRef.current < SAFARI_IME_RACE_WINDOW_MS;
        if (event.nativeEvent.isComposing || isComposingRef.current || endedJustNow) {
          return;
        }

        // Option/Alt+Enter asks a side question in every state (loading,
        // background, idle) and even with the command menu or file-mention
        // dropdown open, so this has to run ahead of
        // `handleCommandMenuKeyDown`/`handleFileMentionsKeyDown` below: both
        // consume a plain Enter to select their highlighted entry and never
        // check altKey, so they would otherwise run the highlighted command
        // or mention instead of asking the side question.
        if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && !(isLoading && provider === 'claude' && steerMessage)) {
          event.preventDefault();
          askSideQuestionAndClear(sessionKey, inputValueRef.current);
          return;
        }
      }

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

        // Alt with the send key keeps the message for after the running turn.
        const submitOptions = event.altKey ? { queueUntilTurnEnds: true } : undefined;
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event, undefined, submitOptions);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter && !isSoftKeyboardEnvironment()) {
          event.preventDefault();
          handleSubmit(event, undefined, submitOptions);
        }
      }
    },
    [
      askSideQuestionAndClear,
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      sessionKey,
      provider,
      isLoading,
      steerMessage,
      showCommandMenu,
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
    handleQueueUntilTurnEnds,
    handleSteerQueued,
    isSteering: steeringState?.scope === sessionKey && steeringState.pending,
    steeringMessageId: steeringState?.scope === sessionKey ? steeringState.message.id : undefined,
    steerError: steeringState?.scope === sessionKey && queuedDrafts.some(draft => matchesQueuedDraft(draft, steeringState.message))
      ? steeringState.error : null,
    handleSendMenuChoice,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    takeOverPrompt,
    askToTakeOverSession,
    resolveTakeOverPrompt,
    queuedDraft,
    queuedDrafts,
    editQueuedDraft,
    deleteQueuedDraft,
    pendingSteers: visiblePendingSteers,
    handleSteerOutcome,
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
