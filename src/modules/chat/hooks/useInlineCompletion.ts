import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

import { api } from '@/shared/api';
import {
  hasHydratedUserPreferences, readUserPreference, subscribeToUserPreferences,
  userPreferencesEpoch, writeUserPreference,
} from '@/shared/userSettings';
import { getDeploymentBasePath, selectComposerHistory } from '@/shared/utils';
import type {
  ChatMessage, ComposerCompletionCandidate, ComposerCompletionConfig,
  ComposerCompletionRequest, ComposerCompletionResult, ComposerPreferences,
} from '@/shared/types';

type Options = {
  managed: boolean;
  active: boolean;
  blocked: boolean;
  contextKey: string;
  draft: string;
  history: ChatMessage[];
  textareaRef: RefObject<HTMLTextAreaElement>;
  replaceDraft: (expected: string, replacement: string) => void;
};
type Undo = { scope: string; context: string; before: string; after: string };
type View = {
  candidate: ComposerCompletionCandidate | null;
  undo: Undo | null;
  phase: 'idle' | 'waiting' | 'requesting' | 'cooldown' | 'unavailable' | 'applying';
  notice: 'applied' | 'undone' | null;
};
const EMPTY_VIEW: View = { candidate: null, undo: null, phase: 'idle', notice: null };
const SECRET = /-----BEGIN [^-]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{4,}|\b(?:api[_-]?key|password|token|secret)\s*[:=]\s*["']?[^\s"',;]+/i;
const UNSAFE_SUFFIX = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

function preferencesSnapshot() {
  const value = readUserPreference<Partial<ComposerPreferences> | null>('composerPreferences', null);
  return {
    preferences: { completionEnabled: value?.completionEnabled === true, useHistory: value?.useHistory !== false },
    hydrated: hasHydratedUserPreferences(), epoch: userPreferencesEpoch(),
  };
}

function validConfig(value: ComposerCompletionConfig): boolean {
  const limits = value?.limits;
  return typeof value?.configured === 'boolean' && typeof value.userId === 'string' && value.userId.length > 0 &&
    typeof value.promptVersion === 'string' && Boolean(limits) &&
    limits.prefixBytes > 0 && limits.prefixBytes <= 4096 &&
    limits.historyBytes > 0 && limits.historyBytes <= 3000 && limits.historyMessages > 0 && limits.historyMessages <= 6 &&
    limits.historyMessageBytes > 0 && limits.historyMessageBytes <= 1000 &&
    limits.suffixCharacters > 0 && limits.suffixCharacters <= 80 &&
    limits.debounceMs >= 100 && limits.debounceMs <= 2000 &&
    limits.minIntervalMs >= 1000 && limits.minIntervalMs <= 10000;
}

function eligiblePrefix(prefix: string, maxBytes: number): boolean {
  const text = prefix.trim();
  if (!text || new TextEncoder().encode(prefix).length > maxBytes || SECRET.test(prefix) ||
      prefix.split('```').length % 2 === 0) return false;
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return cjk >= 2 || (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 4;
}

/** ChatComposer owns the only automatic text-assistance lifecycle; no proposal is a draft until a guarded edit commits. */
export function useInlineCompletion(options: Options) {
  // Consent comes from this login's hydrated preferences, never an unverified local mirror.
  const [preferenceState, setPreferenceState] = useState(preferencesSnapshot);
  // Scope-tagged capabilities cannot carry an identity from a previous node/login.
  const [capability, setCapability] = useState<{ key: string; data: ComposerCompletionConfig | null }>({ key: '', data: null });
  // Rendering state contains only transient proposals and the last confirmed local edit.
  const [view, setView] = useState<View>(EMPTY_VIEW);
  const configKey = JSON.stringify([getDeploymentBasePath(), preferenceState.epoch]);
  const hasContext = Boolean(options.contextKey);
  const config = options.managed && options.active && preferenceState.hydrated && hasContext &&
    capability.key === configKey ? capability.data : null;
  const history = useMemo(() => preferenceState.preferences.useHistory
    ? selectComposerHistory(options.history, {
      messages: config?.limits.historyMessages ?? 6, bytes: config?.limits.historyBytes ?? 3000,
      messageBytes: config?.limits.historyMessageBytes ?? 1000,
    }) : [], [options.history, preferenceState.preferences.useHistory, config]);
  const context = JSON.stringify(history);
  const scope = JSON.stringify([configKey, options.contextKey, config?.userId, preferenceState.preferences.useHistory]);
  const permitted = options.managed && options.active && !options.blocked && Boolean(config?.configured) &&
    preferenceState.hydrated && preferenceState.preferences.completionEnabled;
  // Callbacks only read the latest committed component state, not a network closure.
  const latest = useRef({ ...options, config, scope, context, history, permitted });
  // A monotonic edit/request generation protects even A → B → A input changes.
  const revision = useRef(0);
  // Only one debounce and one in-flight request belong to this composer.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  // The synchronous proposal ref makes two key events unable to accept the same text twice.
  const candidate = useRef<ComposerCompletionCandidate | null>(null);
  // Current-scope cache includes context and prefix and is never persisted or logged.
  const cache = useRef(new Map<string, { suffix: string; expiresAt: number }>());
  // Throttle/cooldown are deadlines, not timers that automatically retry without new input.
  const lastRequestAt = useRef(0);
  const cooldownUntil = useRef(0);
  // Composition and native edit receipts distinguish real input from restores/rewrite changes.
  const composing = useRef(false);
  const nativeEdit = useRef<{ scope: string; text: string } | null>(null);
  // A void replacement request is acknowledged only by a subsequent committed draft.
  const pendingEdit = useRef<(Undo & { kind: 'accept' | 'undo' }) | null>(null);
  // Dismissal suppresses the same snapshot until the user actually changes it.
  const dismissed = useRef<string | null>(null);
  const mounted = useRef(true);

  const abort = useCallback(() => {
    revision.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    request.current?.abort();
    request.current = null;
  }, []);

  const invalidate = useCallback(() => {
    abort();
    candidate.current = null;
    pendingEdit.current = null;
    setView((previous) => previous === EMPTY_VIEW ? previous : EMPTY_VIEW);
  }, [abort]);

  useEffect(() => subscribeToUserPreferences(() => setPreferenceState(preferencesSnapshot())), []);

  useEffect(() => {
    if (!options.managed || !options.active || !preferenceState.hydrated || !hasContext) {
      return;
    }
    const controller = new AbortController();
    void api.composer.config(controller.signal).then(async (response) => {
      if (!response.ok) return null;
      const value = await response.json() as ComposerCompletionConfig;
      return validConfig(value) ? value : null;
    }).then((data) => {
      if (!controller.signal.aborted) setCapability({ key: configKey, data });
    }).catch(() => {
      if (!controller.signal.aborted) setCapability({ key: configKey, data: null });
    });
    return () => controller.abort();
  }, [options.managed, options.active, hasContext, preferenceState.hydrated, configKey]);

  useLayoutEffect(() => {
    const previous = latest.current;
    latest.current = { ...options, config, scope, context, history, permitted };
    if (previous.config?.userId !== config?.userId) {
      lastRequestAt.current = 0;
      cooldownUntil.current = 0;
    }
    if (previous.scope !== scope || previous.context !== context || previous.permitted !== permitted) {
      invalidate();
      cache.current.clear();
      dismissed.current = null;
      nativeEdit.current = null;
      return;
    }
    const edit = pendingEdit.current;
    if (edit) {
      pendingEdit.current = null;
      if (options.draft === edit.after && edit.scope === scope && edit.context === context) {
        setView({ ...EMPTY_VIEW, undo: edit.kind === 'accept' ? edit : null, notice: edit.kind === 'accept' ? 'applied' : 'undone' });
        const textarea = options.textareaRef.current;
        if (textarea && options.active) {
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(edit.after.length, edit.after.length);
        }
      } else setView(EMPTY_VIEW);
      return;
    }
    if (previous.draft !== options.draft &&
        (nativeEdit.current?.text !== options.draft || nativeEdit.current.scope !== scope)) {
      invalidate();
    }
  }, [options, config, scope, context, history, permitted, invalidate, view.phase]);

  useEffect(() => {
    mounted.current = true;
    const activeCache = cache.current;
    const hidden = () => { if (document.visibilityState === 'hidden') invalidate(); };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      mounted.current = false; abort(); activeCache.clear();
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [abort, invalidate]);

  const keyFor = useCallback((prefix: string) => {
    const state = latest.current;
    return JSON.stringify([state.scope, state.context, state.config?.promptVersion, prefix]);
  }, []);

  const atEnd = useCallback((prefix: string, allowButtonFocus = false) => {
    const textarea = latest.current.textareaRef.current;
    return Boolean(textarea && textarea.value === prefix &&
      textarea.selectionStart === prefix.length && textarea.selectionEnd === prefix.length &&
      (allowButtonFocus || document.activeElement === textarea));
  }, []);

  const receiveUserInput = useCallback((text: string) => {
    const state = latest.current;
    const previousCandidate = candidate.current;
    const previousText = nativeEdit.current?.text ?? state.draft;
    abort();
    nativeEdit.current = { scope: state.scope, text };
    pendingEdit.current = null;
    candidate.current = null;
    setView(EMPTY_VIEW);
    if (previousText !== text) dismissed.current = null;
    if (!state.permitted || composing.current || document.visibilityState === 'hidden' ||
        !state.config || !atEnd(text) || !eligiblePrefix(text, state.config.limits.prefixBytes)) return;
    if (previousCandidate && previousCandidate.scope === state.scope && previousCandidate.context === state.context &&
        previousCandidate.expiresAt > Date.now() && text.startsWith(previousCandidate.prefix) &&
        text.length > previousCandidate.prefix.length) {
      const typed = text.slice(previousCandidate.prefix.length);
      if (previousCandidate.suffix.startsWith(typed)) {
        const suffix = previousCandidate.suffix.slice(typed.length);
        if (suffix) {
          const next = { ...previousCandidate, prefix: text, suffix };
          candidate.current = next; setView({ ...EMPTY_VIEW, candidate: next });
        }
        return;
      }
    }
    const key = keyFor(text);
    if (dismissed.current === key) return;
    for (const [entryKey, value] of cache.current) if (value.expiresAt <= Date.now()) cache.current.delete(entryKey);
    const cached = cache.current.get(key);
    if (cached) {
      if (cached.suffix) {
        const next = { prefix: text, suffix: cached.suffix, scope: state.scope, context: state.context, expiresAt: cached.expiresAt };
        candidate.current = next; setView({ ...EMPTY_VIEW, candidate: next });
      }
      return;
    }
    if (Date.now() < cooldownUntil.current) { setView({ ...EMPTY_VIEW, phase: 'cooldown' }); return; }
    const generation = revision.current;
    const delay = Math.max(state.config.limits.debounceMs, lastRequestAt.current + state.config.limits.minIntervalMs - Date.now());
    setView({ ...EMPTY_VIEW, phase: 'waiting' });
    timer.current = setTimeout(() => {
      timer.current = null;
      const current = latest.current;
      if (!mounted.current || generation !== revision.current || current.scope !== state.scope ||
          current.context !== state.context || !current.permitted || composing.current ||
          current.draft !== text || !atEnd(text) || document.visibilityState === 'hidden') return;
      const controller = new AbortController();
      request.current = controller;
      lastRequestAt.current = Date.now();
      const body: ComposerCompletionRequest = {
        requestId: crypto.randomUUID(), draftRevision: generation, contextRevision: `context-${generation}`,
        prefix: text, history: current.history, language: 'auto',
      };
      const stillCurrent = () => mounted.current && !controller.signal.aborted && revision.current === generation &&
        latest.current.scope === state.scope && latest.current.context === state.context &&
        latest.current.permitted && latest.current.draft === text && atEnd(text) &&
        document.visibilityState !== 'hidden' && !composing.current;
      setView({ ...EMPTY_VIEW, phase: 'requesting' });
      const timeout = setTimeout(() => {
        if (request.current === controller) {
          controller.abort(); request.current = null;
          cooldownUntil.current = Date.now() + 3000;
          if (mounted.current && revision.current === generation) setView({ ...EMPTY_VIEW, phase: 'unavailable' });
        }
      }, 4500);
      void api.composer.complete(body, controller.signal).then(async (response) => {
        if (!response.ok) {
          if (stillCurrent()) {
            const retry = Number(response.headers.get('retry-after'));
            cooldownUntil.current = Date.now() + (response.status === 429 && Number.isFinite(retry)
              ? Math.min(86400, Math.max(2, retry)) * 1000 : 3000);
            setView({ ...EMPTY_VIEW, phase: response.status === 429 ? 'cooldown' : 'unavailable' });
          }
          return;
        }
        const result = await response.json() as ComposerCompletionResult;
        if (!stillCurrent()) return;
        if (result.requestId !== body.requestId || result.draftRevision !== generation ||
            result.contextRevision !== body.contextRevision || result.promptVersion !== current.config?.promptVersion ||
            typeof result.suffix !== 'string' || [...result.suffix].length > (current.config?.limits.suffixCharacters ?? 80) ||
            UNSAFE_SUFFIX.test(result.suffix) || SECRET.test(result.suffix)) {
          setView({ ...EMPTY_VIEW, phase: 'unavailable' }); return;
        }
        const suffix = result.suffix.trim() ? result.suffix : '';
        const expiresAt = Date.now() + 30000;
        cache.current.set(key, { suffix, expiresAt });
        while (cache.current.size > 20) cache.current.delete(cache.current.keys().next().value!);
        const next = suffix ? { prefix: text, suffix, scope: state.scope, context: state.context, expiresAt } : null;
        candidate.current = next; setView({ ...EMPTY_VIEW, candidate: next });
      }).catch(() => {
        if (stillCurrent()) {
          cooldownUntil.current = Date.now() + 3000;
          setView({ ...EMPTY_VIEW, phase: 'unavailable' });
        }
      }).finally(() => {
        clearTimeout(timeout);
        if (request.current === controller) request.current = null;
      });
    }, delay);
  }, [abort, atEnd, keyFor]);

  const dismiss = useCallback(() => {
    dismissed.current = keyFor(latest.current.draft);
    invalidate();
  }, [invalidate, keyFor]);

  const accept = useCallback((allowButtonFocus = false): boolean => {
    const proposal = candidate.current;
    const state = latest.current;
    if (!proposal || !state.permitted || composing.current || proposal.scope !== state.scope ||
        proposal.context !== state.context || proposal.prefix !== state.draft || proposal.expiresAt <= Date.now() ||
        !atEnd(proposal.prefix, allowButtonFocus)) { invalidate(); return false; }
    abort(); candidate.current = null;
    const edit = { scope: state.scope, context: state.context, before: proposal.prefix, after: proposal.prefix + proposal.suffix, kind: 'accept' as const };
    pendingEdit.current = edit;
    setView({ ...EMPTY_VIEW, phase: 'applying' });
    state.replaceDraft(edit.before, edit.after);
    return true;
  }, [abort, atEnd, invalidate]);

  const undo = useCallback(() => {
    const state = latest.current;
    const edit = view.undo;
    if (!edit || edit.scope !== state.scope || edit.context !== state.context || state.draft !== edit.after) return;
    abort(); candidate.current = null;
    pendingEdit.current = { ...edit, before: edit.after, after: edit.before, kind: 'undo' };
    setView({ ...EMPTY_VIEW, phase: 'applying' });
    state.replaceDraft(edit.after, edit.before);
  }, [abort, view.undo]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.defaultPrevented || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape' && (candidate.current || timer.current || request.current)) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.repeat &&
        candidate.current && accept()) event.preventDefault();
  }, [accept, dismiss]);

  const onSelectionChange = useCallback(() => {
    if (!atEnd(latest.current.draft) && (candidate.current || timer.current || request.current)) invalidate();
  }, [atEnd, invalidate]);

  const visibleCandidate = permitted && view.candidate?.scope === scope && view.candidate.context === context &&
    view.candidate.prefix === options.draft ? view.candidate : null;
  return {
    candidate: visibleCandidate, phase: view.phase, notice: view.notice,
    configured: Boolean(config?.configured), ready: preferenceState.hydrated,
    preferences: preferenceState.preferences,
    setPreference: (patch: Partial<ComposerPreferences>) => {
      // Revoking consent must remain possible even while the service is unavailable.
      if (!preferenceState.hydrated || (patch.completionEnabled === true && !config?.configured)) return;
      invalidate();
      writeUserPreference('composerPreferences', { ...preferenceState.preferences, ...patch });
    },
    receiveUserInput, onKeyDown, accept, dismiss, invalidate, undo, onSelectionChange,
    canUndo: Boolean(view.undo && view.undo.scope === scope && view.undo.context === context && view.undo.after === options.draft),
    onCompositionStart: () => { composing.current = true; invalidate(); },
    onCompositionEnd: (text: string) => { composing.current = false; receiveUserInput(text); },
    isComposing: () => composing.current,
  };
}
