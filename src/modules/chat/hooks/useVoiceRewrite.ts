import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ChatMessage, VoiceDraftInsertion, VoiceRewriteMessage, VoiceRewriteResult } from '@/shared/types';
import { selectVoiceRewriteHistory } from '@/modules/chat/utils/voiceRewriteHistory';

type Target = VoiceDraftInsertion & { history: VoiceRewriteMessage[] };
type View = {
  scope: string;
  target: Target;
  phase: 'ready' | 'busy' | 'done' | 'review' | 'error';
  // Keep only the last applied/approved result; an unreviewed candidate is never a redo target.
  lastRewrittenDraft?: string;
  candidate?: VoiceRewriteResult;
  notice?: string;
};
type Options = {
  contextKey: string;
  draft: string;
  enabled: boolean;
  configured: boolean;
  useHistory: boolean;
  language: string;
  replaceDraft: (expected: string, replacement: string) => void;
};
type PendingRewrite = {
  controller: AbortController;
  scope: string;
  draft: string;
  timer?: ReturnType<typeof setTimeout>;
};

function abortRequest(request: PendingRewrite | null) {
  if (!request) return;
  clearTimeout(request.timer);
  request.controller.abort();
}

/** ChatComposer owns this manual rewrite and its local, compare-and-set undo/restore pair. */
export function useVoiceRewrite(options: Options) {
  // The receipt, last result and candidate belong only to this draft; none is persisted as extra history.
  const [view, setView] = useState<View | null>(null);
  const current = useRef(options);
  const viewRef = useRef(view);
  const pending = useRef<PendingRewrite | null>(null);
  useLayoutEffect(() => { current.current = options; viewRef.current = view; });

  const cancel = useCallback(() => {
    const request = pending.current;
    pending.current = null;
    abortRequest(request);
    setView((previous) => previous ? { ...previous, phase: 'ready', notice: 'cancelled' } : null);
  }, []);

  useLayoutEffect(() => {
    abortRequest(pending.current);
    pending.current = null;
    return () => {
      abortRequest(pending.current);
      pending.current = null;
    };
  }, [options.contextKey, options.enabled]);

  // Editing while a response is in flight invalidates that response, even when
  // the user subsequently types the old value again.
  useLayoutEffect(() => {
    const request = pending.current;
    if (request && request.draft !== options.draft) {
      pending.current = null;
      abortRequest(request);
      setView((previous) => previous ? { ...previous, phase: 'ready', notice: 'draftChanged' } : null);
    }
  }, [options.draft]);

  const remember = useCallback((insertion: VoiceDraftInsertion, messages: ChatMessage[]) => {
    abortRequest(pending.current);
    pending.current = null;
    setView({
      scope: current.current.contextKey, phase: 'ready',
      target: { ...insertion, history: selectVoiceRewriteHistory(messages) },
    });
  }, []);

  const clear = useCallback(() => {
    abortRequest(pending.current);
    pending.current = null;
    setView(null);
  }, []);

  const rewrite = useCallback(async () => {
    const snapshot = current.current;
    const previous = viewRef.current;
    if (pending.current || !snapshot.enabled || !snapshot.configured || !previous ||
        previous.scope !== snapshot.contextKey || previous.target.transcript.length > 8000 ||
        ![previous.target.draft, previous.lastRewrittenDraft].includes(snapshot.draft)) return;
    const request: PendingRewrite = { controller: new AbortController(), scope: snapshot.contextKey, draft: snapshot.draft };
    pending.current = request;
    setView({ ...previous, phase: 'busy', candidate: undefined, notice: undefined });
    request.timer = setTimeout(() => {
      if (pending.current !== request) return;
      pending.current = null;
      abortRequest(request);
      setView({ ...previous, phase: 'error', notice: 'VOICE_REWRITE_TIMEOUT' });
    }, 15000);
    const valid = () => pending.current === request && !request.controller.signal.aborted &&
      current.current.enabled && current.current.configured &&
      current.current.contextKey === request.scope && current.current.draft === request.draft;
    try {
      const response = await api.voice.codeyRewrite({
        transcript: previous.target.transcript,
        history: snapshot.useHistory ? previous.target.history : [],
        language: snapshot.language,
      }, request.controller.signal);
      const result = await response.json();
      if (!valid()) return;
      if (!response.ok) throw new Error(typeof result.code === 'string' ? result.code : 'VOICE_REWRITE_UNAVAILABLE');
      if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 8000 ||
          !Array.isArray(result.ambiguities) || result.ambiguities.length > 8 ||
          result.ambiguities.some((item: unknown) => typeof item !== 'string' || !item.trim() ||
            item.length > 120 || !previous.target.transcript.includes(item))) throw new Error('VOICE_REWRITE_UNAVAILABLE');
      const candidate: VoiceRewriteResult = { text: result.text.trim(), ambiguities: result.ambiguities };
      if (candidate.ambiguities.length) {
        setView({ ...previous, phase: 'review', candidate, notice: 'needsReview' });
      } else {
        const lastRewrittenDraft = previous.target.prefix + candidate.text;
        snapshot.replaceDraft(request.draft, lastRewrittenDraft);
        setView({
          ...previous, phase: 'done', lastRewrittenDraft, candidate: undefined,
          notice: lastRewrittenDraft === request.draft ? 'unchanged' : 'done',
        });
      }
    } catch (error) {
      if (valid()) setView({
        ...previous, phase: 'error', notice: error instanceof Error ? error.message : 'VOICE_REWRITE_UNAVAILABLE',
      });
    } finally {
      clearTimeout(request.timer);
      if (pending.current === request) pending.current = null;
    }
  }, []);

  const applyCandidate = useCallback(() => {
    const state = viewRef.current;
    const snapshot = current.current;
    if (pending.current || !state?.candidate || state.phase !== 'review' || state.scope !== snapshot.contextKey ||
        !snapshot.enabled || ![state.target.draft, state.lastRewrittenDraft].includes(snapshot.draft)) return;
    const lastRewrittenDraft = state.target.prefix + state.candidate.text;
    snapshot.replaceDraft(snapshot.draft, lastRewrittenDraft);
    setView({ ...state, phase: 'done', lastRewrittenDraft, candidate: undefined, notice: 'done' });
  }, []);

  const undo = useCallback(() => {
    const state = viewRef.current;
    const snapshot = current.current;
    if (!snapshot.enabled || !state?.lastRewrittenDraft || state.scope !== snapshot.contextKey ||
        state.lastRewrittenDraft !== snapshot.draft || pending.current) return;
    snapshot.replaceDraft(state.lastRewrittenDraft, state.target.draft);
    setView({ ...state, phase: 'ready', candidate: undefined, notice: 'undone' });
  }, []);

  const restore = useCallback(() => {
    const state = viewRef.current;
    const snapshot = current.current;
    // Local restore needs no configured model, but still cannot overwrite edits or an active request.
    if (pending.current || !snapshot.enabled || !state?.lastRewrittenDraft ||
        state.scope !== snapshot.contextKey || snapshot.draft !== state.target.draft ||
        state.lastRewrittenDraft === snapshot.draft) return;
    snapshot.replaceDraft(state.target.draft, state.lastRewrittenDraft);
    setView({ ...state, phase: 'done', candidate: undefined, notice: 'restored' });
  }, []);

  const active = view?.scope === options.contextKey && options.enabled ? view : null;
  // Reset scope-owned state during render, before a new scope can display it.
  // The layout-effect cleanup separately cancels the old external request.
  if (view && !active) setView(null);
  const matches = Boolean(active && [active.target.draft, active.lastRewrittenDraft].includes(options.draft));
  return {
    remember, clear, rewrite, cancel, undo, restore, applyCandidate,
    busy: active?.phase === 'busy',
    canRewrite: Boolean(active && matches && options.configured && active.target.transcript.length <= 8000 && active.phase !== 'busy'),
    hasPreviousRewrite: active?.lastRewrittenDraft !== undefined,
    canUndo: Boolean(active?.lastRewrittenDraft && active.lastRewrittenDraft !== active.target.draft &&
      options.draft === active.lastRewrittenDraft && active.phase !== 'busy'),
    canRestore: Boolean(active?.lastRewrittenDraft && active.lastRewrittenDraft !== active.target.draft &&
      options.draft === active.target.draft && active.phase !== 'busy'),
    needsAttention: active?.phase === 'review' || active?.phase === 'error',
    candidate: active?.phase === 'review' ? active.candidate : undefined,
    originalText: active?.target.transcript,
    canApply: Boolean(matches && active?.phase === 'review'),
    notice: active && !matches ? 'draftChanged' : active?.notice,
  };
}
