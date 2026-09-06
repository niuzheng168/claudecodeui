import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { api, transcribeVoice } from '@/shared/api';
import type { CodeyVoicePreferences, VoiceInputState } from '@/shared/types';
import { recordingToWave } from '@/modules/chat/utils/recordingWav';

type VoiceOptions = {
  contextKey?: string;
  enabled?: boolean;
  managed?: CodeyVoicePreferences & { maxDurationSeconds: number };
};

type Recording = {
  controller: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
  chunks: Blob[];
  bytes: number;
  send: boolean;
  options: VoiceOptions;
  onTranscript: (text: string, send?: boolean) => void;
};

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

function stopTracks(recording: Recording) {
  recording.stream?.getTracks().forEach((track) => track.stop());
  recording.stream = undefined;
}

/** ChatComposer owns this cancellable recorder; session switches cannot deliver audio to another draft. */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (message: string) => void,
  options: VoiceOptions = {},
) {
  // The UI snapshot retains the original destination even if another tab changes preferences mid-recording.
  const [view, setView] = useState<{ state: VoiceInputState; activePreferences?: VoiceOptions['managed'] }>({ state: 'idle' });
  const state = view.state;
  const setState = useCallback((next: VoiceInputState) => {
    setView((previous) => next === 'idle' ? { state: next } : { ...previous, state: next });
  }, []);
  const current = useRef<Recording | null>(null);
  const mounted = useRef(false);
  const callbacks = useRef({ onTranscript, onError, options });
  useLayoutEffect(() => {
    callbacks.current = { onTranscript, onError, options };
  }, [onTranscript, onError, options]);

  const dispose = useCallback(() => {
    const recording = current.current;
    current.current = null;
    if (!recording) return;
    clearTimeout(recording.timer);
    recording.controller.abort();
    if (recording.recorder) {
      recording.recorder.onstop = null;
      recording.recorder.ondataavailable = null;
      recording.recorder.onerror = null;
      try { if (recording.recorder.state !== 'inactive') recording.recorder.stop(); } catch { /* Tracks must still stop. */ }
    }
    stopTracks(recording);
    recording.chunks = [];
  }, []);

  const cancel = useCallback(() => {
    dispose();
    if (mounted.current) setState('idle');
  }, [dispose, setState]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; dispose(); };
  }, [dispose]);

  useEffect(() => {
    cancel();
    return dispose;
  }, [options.contextKey, options.enabled, cancel, dispose]);

  const stop = useCallback((intent?: { send?: boolean }) => {
    const recording = current.current;
    if (!recording?.recorder || recording.recorder.state === 'inactive') return;
    recording.send = intent?.send === true;
    clearTimeout(recording.timer);
    recording.recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (current.current || callbacks.current.options.enabled === false) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      callbacks.current.onError?.('VOICE_BROWSER_UNSUPPORTED');
      return;
    }
    const recording: Recording = {
      controller: new AbortController(), chunks: [], bytes: 0, send: false,
      options: {
        ...callbacks.current.options,
        managed: callbacks.current.options.managed && { ...callbacks.current.options.managed },
      },
      onTranscript: callbacks.current.onTranscript,
    };
    current.current = recording;
    setView({ state: 'requesting', activePreferences: recording.options.managed });
    const active = () => mounted.current && current.current === recording && !recording.controller.signal.aborted
      && callbacks.current.options.contextKey === recording.options.contextKey
      && callbacks.current.options.enabled !== false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (!active()) { stream.getTracks().forEach((track) => track.stop()); return; }
      recording.stream = stream;
      let mimeType = '';
      for (const candidate of MIME_CANDIDATES) {
        try { if (MediaRecorder.isTypeSupported(candidate)) { mimeType = candidate; break; } } catch { /* Browser fallback. */ }
      }
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recording.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (!active() || !event.data.size) return;
        recording.bytes += event.data.size;
        if (recording.bytes > 8 * 1024 * 1024) {
          cancel();
          callbacks.current.onError?.('VOICE_AUDIO_TOO_LARGE');
          return;
        }
        recording.chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (!active()) return;
        cancel();
        callbacks.current.onError?.('VOICE_RECORDING_FAILED');
      };
      recorder.onstop = async () => {
        clearTimeout(recording.timer);
        stopTracks(recording);
        if (!active()) return;
        setState('transcribing');
        const type = recorder.mimeType || 'audio/webm';
        const audio = new Blob(recording.chunks, { type });
        recording.chunks = [];
        try {
          if (audio.size < 100) throw new Error('VOICE_DURATION_INVALID');
          const { managed } = recording.options;
          let response: Response;
          if (managed) {
            const wave = await recordingToWave(audio, recording.controller.signal, managed.maxDurationSeconds);
            response = await api.voice.codeyTranscribe(
              wave, { provider: managed.provider, language: managed.language }, recording.controller.signal,
            );
          } else {
            const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
            response = await transcribeVoice(audio, `recording.${extension}`, recording.controller.signal);
          }
          const result = await response.json();
          if (!active()) return;
          if (!response.ok) throw new Error(typeof result.code === 'string' ? result.code : 'VOICE_TRANSCRIPTION_FAILED');
          const text = typeof result.text === 'string' ? result.text.trim() : '';
          if (!text) throw new Error('VOICE_NO_SPEECH');
          recording.onTranscript(text, recording.send);
        } catch (error) {
          if (active()) callbacks.current.onError?.(error instanceof Error ? error.message : 'VOICE_TRANSCRIPTION_FAILED');
        } finally {
          if (current.current === recording) {
            dispose();
            if (mounted.current) setState('idle');
          }
        }
      };
      recorder.start(1000);
      setState('recording');
      recording.timer = setTimeout(() => stop(), Math.min(recording.options.managed?.maxDurationSeconds || 120, 120) * 1000);
    } catch (error) {
      if (!active()) return;
      cancel();
      const name = (error as { name?: string })?.name;
      callbacks.current.onError?.(name === 'NotAllowedError' ? 'VOICE_MIC_DENIED' : name === 'NotFoundError' ? 'VOICE_MIC_MISSING' : 'VOICE_RECORDING_FAILED');
    }
  }, [cancel, dispose, stop, setState]);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') void start();
    else cancel();
  }, [state, stop, start, cancel]);

  return { state, toggle, stop, cancel, activePreferences: view.activePreferences };
}
