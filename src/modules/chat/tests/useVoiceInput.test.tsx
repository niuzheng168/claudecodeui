import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { api, transcribeVoice } from '@/shared/api';
import { recordingToWave } from '@/modules/chat/utils/recordingWav';
import type { CodeyVoiceProvider } from '@/shared/types';

vi.mock('@/shared/api', () => ({
  api: { voice: { codeyTranscribe: vi.fn() } }, transcribeVoice: vi.fn(),
}));
vi.mock('@/modules/chat/utils/recordingWav', () => ({ recordingToWave: vi.fn() }));

class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported() { return true; }
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { Recorder.instances.push(this); }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array(512)], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const trackStop = vi.fn();
const media = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
const getUserMedia = vi.fn();
const wave = new Blob([new Uint8Array(32044)], { type: 'audio/wav' });
const managed = { provider: 'azure-speech' as CodeyVoiceProvider, language: 'auto' as const, maxDurationSeconds: 120 };

beforeEach(() => {
  vi.clearAllMocks();
  Recorder.instances = [];
  vi.stubGlobal('MediaRecorder', Recorder);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  getUserMedia.mockResolvedValue(media);
  vi.mocked(recordingToWave).mockResolvedValue(wave);
  vi.mocked(api.voice.codeyTranscribe).mockResolvedValue(new Response(JSON.stringify({ text: '请检查测试结果。' })));
  vi.mocked(transcribeVoice).mockResolvedValue(new Response(JSON.stringify({ text: 'standalone transcript' })));
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('managed recording only starts after a user action, uses the broker and fills the draft without auto-send', async () => {
  const transcript = vi.fn();
  const { result } = renderHook(() => useVoiceInput(transcript, vi.fn(), { managed, contextKey: 'project/session-a' }));
  expect(getUserMedia).not.toHaveBeenCalled();
  await act(async () => { result.current.toggle(); result.current.toggle(); });
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(result.current.state).toBe('recording');
  await act(async () => { result.current.stop(); });
  await waitFor(() => expect(result.current.state).toBe('idle'));
  expect(transcript).toHaveBeenCalledWith('请检查测试结果。', false);
  expect(api.voice.codeyTranscribe).toHaveBeenCalledWith(wave, { provider: 'azure-speech', language: 'auto' }, expect.any(AbortSignal));
  expect(transcribeVoice).not.toHaveBeenCalled();
  expect(trackStop).toHaveBeenCalledTimes(1);
});

test('cancelling a pending permission request stops a late microphone stream and never uploads it', async () => {
  let grant: (stream: MediaStream) => void = () => {};
  getUserMedia.mockReturnValue(new Promise((resolve) => { grant = resolve; }));
  const transcript = vi.fn();
  const { result } = renderHook(() => useVoiceInput(transcript, vi.fn(), { managed, contextKey: 'a' }));
  act(() => result.current.toggle());
  expect(result.current.state).toBe('requesting');
  act(() => result.current.cancel());
  await act(async () => { grant(media); });
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(Recorder.instances).toHaveLength(0);
  expect(api.voice.codeyTranscribe).not.toHaveBeenCalled();
  expect(transcript).not.toHaveBeenCalled();
});

test('cancel during capture discards audio; session switches and unmount also stop microphone tracks', async () => {
  const transcript = vi.fn();
  const { result, rerender, unmount } = renderHook(({ scope }) => useVoiceInput(transcript, vi.fn(), { managed, contextKey: scope }), { initialProps: { scope: 'a' } });
  await act(async () => result.current.toggle());
  act(() => result.current.cancel());
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(api.voice.codeyTranscribe).not.toHaveBeenCalled();
  await act(async () => result.current.toggle());
  rerender({ scope: 'b' });
  expect(trackStop).toHaveBeenCalledTimes(2);
  expect(result.current.state).toBe('idle');
  await act(async () => result.current.toggle());
  unmount();
  expect(trackStop).toHaveBeenCalledTimes(3);
  expect(transcript).not.toHaveBeenCalled();
  expect(api.voice.codeyTranscribe).not.toHaveBeenCalled();
});

test('a late transcript cannot enter another session and cancellation aborts its request', async () => {
  let complete: (response: Response) => void = () => {};
  vi.mocked(api.voice.codeyTranscribe).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  const transcript = vi.fn();
  const { result, rerender } = renderHook(({ scope }) => useVoiceInput(transcript, vi.fn(), { managed, contextKey: scope }), { initialProps: { scope: 'a' } });
  await act(async () => result.current.toggle());
  await act(async () => result.current.stop());
  expect(result.current.state).toBe('transcribing');
  const signal = vi.mocked(api.voice.codeyTranscribe).mock.calls[0][2];
  rerender({ scope: 'b' });
  expect(signal.aborted).toBe(true);
  await act(async () => { complete(new Response(JSON.stringify({ text: 'old session transcript' }))); });
  expect(transcript).not.toHaveBeenCalled();
  expect(result.current.state).toBe('idle');
});

test('the provider is captured when recording starts and is not silently changed by another preference update', async () => {
  const { result, rerender } = renderHook(({ provider }) => useVoiceInput(vi.fn(), vi.fn(), {
    managed: { ...managed, provider }, contextKey: 'same-session',
  }), { initialProps: { provider: 'azure-speech' as CodeyVoiceProvider } });
  await act(async () => result.current.toggle());
  rerender({ provider: 'mai-transcribe' });
  await act(async () => result.current.stop({ send: true }));
  expect(vi.mocked(api.voice.codeyTranscribe).mock.calls[0][1].provider).toBe('azure-speech');
});

test('microphone errors release state and disabled voice cannot start recording', async () => {
  const error = vi.fn();
  getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  const { result, rerender } = renderHook(({ enabled }) => useVoiceInput(vi.fn(), error, { managed, enabled }), { initialProps: { enabled: true } });
  await act(async () => result.current.toggle());
  expect(result.current.state).toBe('idle');
  expect(error).toHaveBeenCalledWith('VOICE_MIC_DENIED');
  rerender({ enabled: false });
  await act(async () => result.current.toggle());
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

test('a recording is automatically stopped at its duration limit without auto-sending', async () => {
  vi.useFakeTimers();
  const transcript = vi.fn();
  const { result } = renderHook(() => useVoiceInput(transcript, vi.fn(), { managed: { ...managed, maxDurationSeconds: 2 } }));
  await act(async () => result.current.toggle());
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(transcript).toHaveBeenCalledWith('请检查测试结果。', false);
  expect(result.current.state).toBe('idle');
});

test('the ordinary standalone backend remains available outside managed mode', async () => {
  const transcript = vi.fn();
  const { result } = renderHook(() => useVoiceInput(transcript));
  await act(async () => result.current.toggle());
  await act(async () => result.current.stop());
  expect(transcribeVoice).toHaveBeenCalledTimes(1);
  expect(api.voice.codeyTranscribe).not.toHaveBeenCalled();
  expect(transcript).toHaveBeenCalledWith('standalone transcript', false);
});
