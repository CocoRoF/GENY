/**
 * Browser-side audio conversion helpers for the Voice Studio.
 *
 * - ``decodeAudio`` — Blob (webm/opus, mp3, ...) → ``AudioBuffer``.
 * - ``encodeWav``  — ``AudioBuffer`` → 16-bit PCM mono WAV ``Blob``,
 *                    with optional slice + resample to a target rate.
 * - ``blobToWav``  — decode + encode in one step.
 *
 * OmniVoice expects mono 24 kHz wav for reference audio, so 24 kHz is
 * the default ``targetSampleRate``. The encoder downmixes multi-channel
 * input to mono by averaging.
 */

let _ctx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (_ctx) return _ctx;
  // Safari still exposes the prefixed constructor.
  const Ctor: typeof AudioContext =
    typeof window !== 'undefined'
      ? (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
      : (undefined as unknown as typeof AudioContext);
  if (!Ctor) throw new Error('AudioContext unavailable in this environment');
  _ctx = new Ctor();
  return _ctx;
}

export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const buf = await blob.arrayBuffer();
  const ctx = getAudioContext();
  // Some Safari builds return undefined from the promise variant.
  return await new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const ret = ctx.decodeAudioData(buf.slice(0), resolve, reject);
      if (ret && typeof (ret as Promise<AudioBuffer>).then === 'function') {
        (ret as Promise<AudioBuffer>).then(resolve, reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

export interface EncodeWavOptions {
  startSec?: number;
  endSec?: number;
  targetSampleRate?: number;
}

export function encodeWav(buffer: AudioBuffer, opts: EncodeWavOptions = {}): Blob {
  const targetRate = opts.targetSampleRate ?? 24000;
  const startSec = Math.max(0, opts.startSec ?? 0);
  const endSec = Math.max(startSec, opts.endSec ?? buffer.duration);

  // 1) Downmix to mono Float32 at the source rate, sliced to [start, end].
  const srcRate = buffer.sampleRate;
  const startSample = Math.floor(startSec * srcRate);
  const endSample = Math.min(buffer.length, Math.floor(endSec * srcRate));
  const sliceLength = Math.max(0, endSample - startSample);

  const monoFloat = new Float32Array(sliceLength);
  const channelCount = buffer.numberOfChannels;
  for (let ch = 0; ch < channelCount; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < sliceLength; i++) {
      monoFloat[i] += data[startSample + i] / channelCount;
    }
  }

  // 2) Resample (linear) to targetRate if needed.
  const resampled = srcRate === targetRate ? monoFloat : linearResample(monoFloat, srcRate, targetRate);

  // 3) Encode int16 PCM with WAV header.
  return encodeWavInt16(resampled, targetRate);
}

export async function blobToWav(blob: Blob, opts: EncodeWavOptions = {}): Promise<Blob> {
  const buffer = await decodeAudio(blob);
  return encodeWav(buffer, opts);
}

// ───────────────────────────────────────────────────────────────────────
// internals

function linearResample(input: Float32Array, srcRate: number, targetRate: number): Float32Array {
  if (srcRate === targetRate) return input;
  const ratio = srcRate / targetRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = srcIdx - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function encodeWavInt16(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF / WAVE header.
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size (PCM)
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, 1, true);           // num channels (mono)
  view.setUint32(24, sampleRate, true);  // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate (= sr * channels * bytesPerSample)
  view.setUint16(32, 2, true);           // block align (channels * bytesPerSample)
  view.setUint16(34, 16, true);          // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM int16 samples.
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// ───────────────────────────────────────────────────────────────────────
// MediaRecorder mime detection

/**
 * Pick the best ``MediaRecorder`` mime type supported by this browser.
 * Returns an empty string when the runtime should fall back to the
 * browser's default (still produces a usable Blob).
 */
export function pickMediaRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return '';
}
