/** Chat's recording hook encodes bounded PCM for both managed STT providers with this helper. */
export function encodePcmWave(samples: Float32Array, sampleRate = 16000): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/** Chat's hook decodes WebM/MP4 locally; VM servers never receive recordings or provider keys. */
export async function recordingToWave(blob: Blob, signal: AbortSignal, maxSeconds: number): Promise<Blob> {
  signal.throwIfAborted();
  const decoder = new AudioContext();
  try {
    const buffer = await decoder.decodeAudioData(await blob.arrayBuffer());
    signal.throwIfAborted();
    if (!Number.isFinite(buffer.duration) || buffer.duration < 0.25 || buffer.duration > maxSeconds + 0.25) {
      throw new Error('VOICE_DURATION_INVALID');
    }
    const frames = Math.min(Math.ceil(buffer.duration * 16000), Math.floor(maxSeconds * 16000));
    const context = new OfflineAudioContext(1, frames, 16000);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    const pcm = await context.startRendering();
    signal.throwIfAborted();
    return encodePcmWave(pcm.getChannelData(0));
  } finally { await decoder.close().catch(() => {}); }
}
