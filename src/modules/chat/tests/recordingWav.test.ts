import { Blob as NodeBlob } from 'node:buffer';

import { afterEach, expect, test, vi } from 'vitest';

import { encodePcmWave, recordingToWave } from '@/modules/chat/utils/recordingWav';

afterEach(() => vi.unstubAllGlobals());

test('PCM encoder emits mono 16-bit WAV and safely clips non-finite/out-of-range samples', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const wave = encodePcmWave(new Float32Array([-2, -1, 0, 1, 2, NaN]));
  const bytes = new DataView(await wave.arrayBuffer());
  expect(wave.type).toBe('audio/wav');
  expect(bytes.getUint32(24, true)).toBe(16000);
  expect(bytes.getUint16(22, true)).toBe(1);
  expect(bytes.getUint16(34, true)).toBe(16);
  expect(bytes.getUint32(40, true)).toBe(12);
  expect([0, 1, 2, 3, 4, 5].map((index) => bytes.getInt16(44 + index * 2, true))).toEqual([-32768, -32768, 0, 32767, 32767, 0]);
});

test('oversized/aborted decoding never produces a request-ready clip and always closes its decoder', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('AudioContext', class {
    close = close;
    async decodeAudioData() { return { duration: 121 }; }
  });
  await expect(recordingToWave(new Blob(['audio']), new AbortController().signal, 120)).rejects.toThrow('VOICE_DURATION_INVALID');
  expect(close).toHaveBeenCalledTimes(1);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(recordingToWave(new Blob(['audio']), cancelled.signal, 120)).rejects.toThrow();
  expect(close).toHaveBeenCalledTimes(1);
});
