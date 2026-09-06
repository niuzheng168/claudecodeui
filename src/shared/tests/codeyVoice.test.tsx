import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { useCodeyVoice } from '@/shared/hooks/useCodeyVoice';
import { CodeyVoiceSelectors } from '@/shared/ui/CodeyVoiceSelectors';
import type { CodeyVoiceConfig } from '@/shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }));

const config: CodeyVoiceConfig = {
  userId: 'owner-a',
  providers: [
    { id: 'azure-speech', label: 'Azure Speech', configured: true },
    { id: 'mai-transcribe', label: 'MAI Transcribe 2', configured: false },
  ],
  defaultProvider: 'azure-speech', languages: ['auto', 'zh-CN', 'en-US'], maxDurationSeconds: 120,
};

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv('VITE_CODEY_PORTAL_SSO', 'true');
  Object.defineProperty(window, '__CLOUDCLI_BASE_PATH__', { value: '/cloudcli/node-a/', configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(window, '__CLOUDCLI_BASE_PATH__');
});

test('managed audio always uses the same-origin node-scoped broker and ignores browser API keys/custom URLs', async () => {
  localStorage.setItem('voiceConfig', JSON.stringify({ baseUrl: 'https://evil.example', apiKey: 'private-browser-key' }));
  const call = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', call);
  const body = new Blob(['audio'], { type: 'audio/wav' });
  const signal = new AbortController().signal;
  await api.voice.codeyTranscribe(body, { provider: 'azure-speech', language: 'zh-CN' }, signal);
  const [url, options] = call.mock.calls[0];
  expect(url).toBe('/cloudcli/node-a/api/voice/codey/transcribe?provider=azure-speech&language=zh-CN');
  expect(options.credentials).toBe('same-origin');
  expect(options.signal).toBe(signal);
  expect(options.body).toBe(body);
  expect(options.headers).toEqual({ 'Content-Type': 'audio/wav' });
  expect(JSON.stringify(options)).not.toContain('private-browser-key');
});

test('service preferences stay separate for each account and synchronize between composer/settings consumers', async () => {
  vi.spyOn(api.voice, 'codeyConfig').mockImplementation(async () => new Response(JSON.stringify(config)));
  const first = renderHook(() => useCodeyVoice(true));
  const second = renderHook(() => useCodeyVoice(true));
  await waitFor(() => expect(first.result.current.config?.userId).toBe('owner-a'));
  await waitFor(() => expect(second.result.current.config?.userId).toBe('owner-a'));
  act(() => first.result.current.update({ language: 'zh-CN' }));
  expect(second.result.current.preferences.language).toBe('zh-CN');
  expect(JSON.parse(localStorage.getItem('codey-voice:owner-a') || '{}')).toEqual({ provider: 'azure-speech', language: 'zh-CN' });
  first.unmount();
  second.unmount();
  vi.mocked(api.voice.codeyConfig).mockImplementation(async () => new Response(JSON.stringify({ ...config, userId: 'owner-b' })));
  const other = renderHook(() => useCodeyVoice(true));
  await waitFor(() => expect(other.result.current.config?.userId).toBe('owner-b'));
  expect(other.result.current.preferences.language).toBe('auto');
});

test('provider/language selectors expose availability, contain no key field and lock while recording', () => {
  const onChange = vi.fn();
  const { rerender } = render(<CodeyVoiceSelectors config={config} preferences={{ provider: 'azure-speech', language: 'auto' }} onChange={onChange} />);
  const provider = screen.getByRole('combobox', { name: 'voiceSettings.provider' }) as HTMLSelectElement;
  expect(provider.options[0].disabled).toBe(false);
  expect(provider.options[1].disabled).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.change(screen.getByRole('combobox', { name: 'voiceSettings.language' }), { target: { value: 'zh-CN' } });
  expect(onChange).toHaveBeenCalledWith({ language: 'zh-CN' });
  rerender(<CodeyVoiceSelectors config={config} preferences={{ provider: 'azure-speech', language: 'auto' }} onChange={onChange} disabled />);
  expect((screen.getByRole('combobox', { name: 'voiceSettings.provider' }) as HTMLSelectElement).disabled).toBe(true);
});
