import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { ChatMessage, ComposerHistoryMessage, LLMProvider, NativeTranscriptPosition, NormalizedMessage, Project, ProjectSession, SlashCommand } from '@/shared/types';

//----------------- NATIVE TRANSCRIPT ORDER ------------

/** Chat ordering and pagination accept only complete native positions; legacy/malformed metadata retains the timestamp compatibility path. */
export function nativeTranscriptPositionOf(message: NormalizedMessage): NativeTranscriptPosition | null {
  const position = message.nativePosition;
  return position && typeof position.turnId === 'string' && position.turnId
    && Number.isSafeInteger(position.itemIndex) && position.itemIndex >= 0
    && Number.isFinite(Date.parse(position.turnStartedAt)) ? position : null;
}

/** Chat's history bridge and older-page guards compare canonical item positions before clocks. Returns null when the two positions cannot establish an order, never comparing different sessions/providers. */
export function compareNativeTranscriptPositions(left: NormalizedMessage, right: NormalizedMessage): number | null {
  if (left.provider !== right.provider || left.sessionId !== right.sessionId) return null;
  const a = nativeTranscriptPositionOf(left), b = nativeTranscriptPositionOf(right);
  if (!a || !b) return null;
  if (a.turnId === b.turnId) return a.itemIndex - b.itemIndex;
  const difference = Date.parse(a.turnStartedAt) - Date.parse(b.turnStartedAt);
  return difference || null;
}

// ---------------------------

//----------------- COMPOSER INPUT HELPERS ------------

/** Chat's command palette and submit path recognize only server-advertised built-ins, not custom frontmatter claiming native support. */
export function isNativeCodexCommand(command: SlashCommand): boolean {
  return command.namespace === 'builtin' && (command.name === '/goal' || command.name === '/plan')
    && command.metadata?.type === 'native' && command.metadata.provider === 'codex';
}

/** Chat's canonical keyboard handler and input shell recognize the same explicit mode chord, excluding AltGr. */
export function isComposerModeShortcut(event: {
  key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean;
  getModifierState?: (key: 'AltGraph') => boolean;
}): boolean {
  return event.key.toLowerCase() === 'm' && event.ctrlKey && event.altKey &&
    !event.metaKey && !event.shiftKey && !event.getModifierState?.('AltGraph');
}

function boundedComposerReference(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let size = 0;
  let result = '';
  for (const character of text) {
    const bytes = encoder.encode(character).length;
    if (size + bytes > maxBytes) break;
    size += bytes;
    result += character;
  }
  return result.trim();
}

function composerReferenceText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, '[code omitted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[credential omitted]')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,})/gi, '[credential omitted]')
    .replace(/\b(?:api[_-]?key|password|token|secret)\s*[:=]\s*["']?[^\s"',;]+/gi, '[credential omitted]')
    .trim();
}

/**
 * Voice rewrite and completion share visible-prose filtering, with independently supplied byte/message budgets.
 * Uses at most three user turns, excludes partial/internal records, and preserves Unicode while bounding UTF-8.
 */
export function selectComposerHistory(messages: ChatMessage[], limits = { messages: 6, bytes: 3000, messageBytes: 1000 }): ComposerHistoryMessage[] {
  const selected: ComposerHistoryMessage[] = [];
  let userTurns = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!['user', 'assistant'].includes(message.type) || message.isStreaming || message.isThinking ||
        message.isToolUse || message.isLocalCommand || message.isLocalCommandStdout ||
        message.isCompactSummary || message.isSubagentContainer || message.isTaskNotification ||
        typeof message.content !== 'string' || !message.content.trim()) continue;
    if (message.type === 'user' && ++userTurns > 3) break;
    const content = composerReferenceText(message.content);
    if (!content) continue;
    const role = message.type as 'user' | 'assistant';
    const first = selected[0];
    if (role === 'assistant' && first?.role === role) first.content = `${content}\n${first.content}`;
    else selected.unshift({ role, content });
  }
  let remaining = limits.bytes;
  const result: ComposerHistoryMessage[] = [];
  for (const message of selected.slice(-limits.messages).reverse()) {
    const content = boundedComposerReference(message.content, Math.min(limits.messageBytes, remaining));
    if (!content) break;
    remaining -= new TextEncoder().encode(content).length;
    result.unshift({ role: message.role, content });
  }
  return result;
}

// ---------------------------

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

/**
 * Reports whether this build is deployed and updated by Codey rather than by
 * CloudCLI's built-in updater.
 */
export function isCodeyManagedDeployment(): boolean {
  return import.meta.env?.VITE_CODEY_MANAGED === 'true';
}

/** Auth, API and WebSocket modules use cookie-backed Codey SSO, never a local JWT. */
export function isCodeyPortalSso(): boolean {
  return import.meta.env?.VITE_CODEY_PORTAL_SSO === 'true';
}

/** Auth failures in either an iframe or a standalone Workspace return to Codey login. */
export function returnToCodeyLogin(): void {
  if (typeof window === 'undefined') return;
  try { (window.top ?? window).location.replace('/portal-auth/login'); }
  catch { window.location.replace('/portal-auth/login'); }
}

/** Every provider exposed by the ordinary self-hosted CloudCLI build. */
const cloudCliProviders: readonly LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

/**
 * Returns the providers users may select in this deployment. Codey nodes expose
 * only Codex because their runtime and credentials are centrally configured.
 */
export function getEnabledProviders(
  codeyManaged = isCodeyManagedDeployment(),
): LLMProvider[] {
  return codeyManaged ? ['codex'] : [...cloudCliProviders];
}

/**
 * Returns the provider a new workspace should start with. This also provides a
 * safe fallback when a stored preference is unavailable in the current build.
 */
export function getDefaultProvider(
  codeyManaged = isCodeyManagedDeployment(),
): LLMProvider {
  return codeyManaged ? 'codex' : 'claude';
}

/**
 * Keeps a provider only when the current deployment exposes it; otherwise it
 * resolves to that deployment's default provider.
 */
export function resolveEnabledProvider(
  candidate: unknown,
  codeyManaged = isCodeyManagedDeployment(),
): LLMProvider {
  const enabledProviders = getEnabledProviders(codeyManaged);
  return enabledProviders.includes(candidate as LLMProvider)
    ? candidate as LLMProvider
    : getDefaultProvider(codeyManaged);
}

// ---------------------------

//----------------- DEPLOYMENT PATHS ------------

/**
 * Returns the public path prefix that hosts this CloudCLI instance. Codey sets
 * it to `/cloudcli/<node>/`; ordinary self-hosted installs keep `/`.
 */
export function getDeploymentBasePath(): string {
  const runtimeBase =
    typeof window !== 'undefined'
      ? (window as Window & { __CLOUDCLI_BASE_PATH__?: string }).__CLOUDCLI_BASE_PATH__
      : '';
  const configuredBase = String(runtimeBase || import.meta.env?.BASE_URL || '/').trim();
  const normalized = `/${configuredBase.replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '/' : `${normalized}/`;
}

/**
 * Prefixes an application-owned root-relative URL with the active deployment
 * path. Absolute/external URLs are returned unchanged, and an already-prefixed
 * URL is not prefixed twice.
 */
export function withDeploymentBasePath(value: string): string {
  if (!value || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
    return value;
  }

  const base = getDeploymentBasePath();
  const path = `/${value.replace(/^\/+/, '')}`;
  if (base === '/') {
    return path;
  }

  const baseWithoutTrailingSlash = base.replace(/\/$/, '');
  return path === baseWithoutTrailingSlash || path.startsWith(`${baseWithoutTrailingSlash}/`)
    ? path
    : `${baseWithoutTrailingSlash}${path}`;
}

/**
 * Shared UI icons use the build's static resource base, not the active node's
 * API/router prefix. In ordinary CloudCLI builds the two prefixes remain equal.
 */
export function withFrontendAssetBasePath(value: string): string {
  if (!value || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return value;
  const base = String(import.meta.env?.BASE_URL || '/').replace(/\/+$/, '');
  const assetPath = `/${value.replace(/^\/+/, '')}`;
  return base && (assetPath === base || assetPath.startsWith(`${base}/`)) ? assetPath : `${base}${assetPath}`;
}

/**
 * Namespaces browser persistence by deployment path so two Codey node
 * workspaces hosted on the same origin cannot overwrite each other's login.
 */
export function deploymentStorageKey(key: string): string {
  const base = getDeploymentBasePath();
  return base === '/' ? key : `${key}:${base.replace(/^\/|\/$/g, '')}`;
}

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'CloudCLI UI';

/**
 * Resolves the human-readable label for a session, accounting for Cursor sessions that
 * carry a `name` instead of the summary the other providers return.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  if (session.__provider === 'cursor') {
    return (session.name as string) || 'Untitled Session';
  }

  return (session.summary as string) || 'New Session';
};

/**
 * Main, sidebar and completion notifications keep the authorized machine name
 * first in the tab title. Older portals fall back to the routed node ID;
 * standalone CloudCLI retains its session/project titles.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  // Use the node API/router prefix, never the shared asset release or the
  // current SPA route, so session navigation cannot rename or lose the node.
  const nodeId = getDeploymentBasePath().match(/^\/cloudcli\/([a-z0-9][a-z0-9_-]{0,31})\/$/i)?.[1];
  const displayName = selectedProject?.displayName?.trim();
  if (nodeId) {
    const identity = typeof window !== 'undefined'
      ? (window as Window & { __CLOUDCLI_NODE__?: { id?: unknown; name?: unknown } }).__CLOUDCLI_NODE__
      : undefined;
    // Metadata belongs to this node only. A stale/foreign label must never
    // make another workspace look like the machine the user intended to open.
    const nodeName = identity?.id === nodeId && typeof identity.name === 'string'
      ? identity.name.trim() : '';
    const workspaceTitle = `cloudcli - ${nodeName || nodeId}`;
    const selectionTitle = selectedSession ? getSessionTitle(selectedSession) : displayName;
    return selectionTitle ? `${workspaceTitle} · ${selectionTitle}` : workspaceTitle;
  }

  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};
