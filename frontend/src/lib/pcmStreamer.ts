/**
 * pcmStreamer — continuous 16 kHz int16 mono PCM capture for server-side VAD.
 *
 * The realtime voice loop's `server_vad` mode streams raw audio to the
 * backend, which runs Silero VAD and decides end-of-speech. To feed it we
 * open an AudioContext pinned to 16 kHz (so no resampling is needed), route
 * the mic through a tiny AudioWorklet that converts float32→int16 and
 * batches ~128 ms chunks, and hand each chunk to `onFrame`.
 *
 * The worklet source is injected as a Blob URL so nothing extra ships in
 * /public and the bundler stays untouched.
 */

const WORKLET_SRC = `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Batch ~128 ms (2048 samples @ 16 kHz) before posting, to keep the
    // WebSocket message rate low without adding meaningful latency.
    this._batch = new Int16Array(2048);
    this._n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const ch = input[0];
      for (let i = 0; i < ch.length; i++) {
        let s = ch[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        this._batch[this._n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this._n === this._batch.length) {
          this.port.postMessage(this._batch.buffer.slice(0));
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
`;

export interface PcmStreamHandle {
  stop: () => void;
}

export interface PcmStreamOptions {
  /** Called with each ~128 ms int16 PCM chunk (ArrayBuffer, 16 kHz mono). */
  onFrame: (pcm: ArrayBuffer) => void;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  /** Capture from a specific input device ('' / undefined = system default). */
  deviceId?: string;
}

export async function startPcmStream(opts: PcmStreamOptions): Promise<PcmStreamHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: opts.echoCancellation ?? true,
      noiseSuppression: opts.noiseSuppression ?? true,
      autoGainControl: opts.autoGainControl ?? true,
      // Prefer the chosen device but fall back to default if it's gone.
      ...(opts.deviceId ? { deviceId: { ideal: opts.deviceId } } : {}),
    },
  });

  // Everything after getUserMedia can throw (AudioContext unsupported at
  // 16 kHz, CSP blocking the blob: worklet, worklet parse error). If it does,
  // the mic is already live — release it (and the ctx) before rethrowing, or
  // the mic stays hot forever with no handle to stop it.
  let ctx: AudioContext | null = null;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // 16 kHz context = Silero's native rate, so no resampling in the worklet.
    ctx = new AudioCtx({ sampleRate: 16000 });
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* resumed on first gesture elsewhere */
      }
    }
    // If the browser ignored the 16 kHz hint we'd ship wrong-rate PCM that the
    // server VAD/Whisper silently misread — fail loudly instead.
    if (ctx.sampleRate !== 16000) {
      throw new Error(`AudioContext gave ${ctx.sampleRate} Hz, need 16000`);
    }

    const blobUrl = URL.createObjectURL(
      new Blob([WORKLET_SRC], { type: 'application/javascript' }),
    );
    try {
      await ctx.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-processor');
    node.port.onmessage = (e) => opts.onFrame(e.data as ArrayBuffer);
    source.connect(node);
    // A muted sink keeps the graph pulling on some browsers without audible echo.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);

    return _makeHandle(stream, ctx, node, source, sink);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    if (ctx) void ctx.close().catch(() => {});
    throw err;
  }
}

function _makeHandle(
  stream: MediaStream,
  ctx: AudioContext,
  node: AudioWorkletNode,
  source: MediaStreamAudioSourceNode,
  sink: GainNode,
): PcmStreamHandle {

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        node.port.onmessage = null;
        node.disconnect();
        source.disconnect();
        sink.disconnect();
      } catch {
        /* already torn down */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
    },
  };
}
