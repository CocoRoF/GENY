/**
 * Voice Studio API client.
 *
 * Talks to ``/api/voice-studio/*`` — the new prefix that landed in
 * PR 1B alongside the Clone & Design page. The legacy ``ttsApi`` object
 * in ``./api.ts`` keeps owning ``/api/tts/*`` and is untouched.
 */

export type PreviewMode = 'clone' | 'design' | 'auto';
export type PreviewAudioFormat = 'wav' | 'mp3' | 'ogg' | 'pcm';

export interface PreviewParams {
  text: string;
  profile?: string;
  emotion?: string;
  mode?: PreviewMode;
  instruct?: string;
  /** ISO code or '' = let OmniVoice auto-detect. */
  language?: string;
  speed?: number;
  duration_seconds?: number;
  num_step?: number;
  guidance_scale?: number;
  denoise?: boolean;
  auto_asr?: boolean;
  seed?: number;
  audio_format?: PreviewAudioFormat;
  sample_rate?: number;
}

export interface PreviewResult {
  blob: Blob;
  /** Caller is responsible for ``URL.revokeObjectURL`` when done. */
  blobUrl: string;
  sampleRate: number;
  rtf: number;
  seedUsed?: number;
  durationSeconds: number;
  engine: string;
}

export interface LanguageItem {
  code: string;
  name: string;
}

const PREVIEW_URL = '/api/voice-studio/synth/preview';
const LANGS_URL = '/api/voice-studio/languages';

let _languagesCache: LanguageItem[] | null = null;
let _languagesPromise: Promise<LanguageItem[]> | null = null;

export const voiceStudioApi = {
  /** POST /api/voice-studio/synth/preview — full-parameter Synthesize card. */
  async synthesizePreview(params: PreviewParams, signal?: AbortSignal): Promise<PreviewResult> {
    const res = await fetch(PREVIEW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const text = await res.text();
        // FastAPI HTTPException body: {"detail": "..."}
        try {
          const json = JSON.parse(text);
          detail = json?.detail ?? text;
        } catch {
          detail = text;
        }
      } catch {
        /* ignore */
      }
      throw new Error(`synth/preview ${res.status}: ${detail}`);
    }
    const blob = await res.blob();
    const seedHdr = res.headers.get('X-VoiceStudio-Seed-Used');
    return {
      blob,
      blobUrl: URL.createObjectURL(blob),
      sampleRate: parseInt(res.headers.get('X-VoiceStudio-Sample-Rate') || '24000', 10),
      rtf: parseFloat(res.headers.get('X-VoiceStudio-RTF') || '0'),
      seedUsed: seedHdr ? parseInt(seedHdr, 10) : undefined,
      durationSeconds: parseFloat(res.headers.get('X-VoiceStudio-Duration-Seconds') || '0'),
      engine: res.headers.get('X-VoiceStudio-Engine') || 'omnivoice',
    };
  },

  /**
   * GET /api/voice-studio/languages — cached in-process for the page lifetime.
   * 646 languages is ~30KB; a single fetch per session is plenty.
   */
  async getLanguages(signal?: AbortSignal): Promise<LanguageItem[]> {
    if (_languagesCache) return _languagesCache;
    if (_languagesPromise) return _languagesPromise;
    _languagesPromise = (async () => {
      const res = await fetch(LANGS_URL, { signal });
      if (!res.ok) throw new Error(`languages ${res.status}: ${res.statusText}`);
      const data = await res.json();
      _languagesCache = Array.isArray(data.languages) ? (data.languages as LanguageItem[]) : [];
      return _languagesCache;
    })();
    try {
      return await _languagesPromise;
    } finally {
      _languagesPromise = null;
    }
  },
};
