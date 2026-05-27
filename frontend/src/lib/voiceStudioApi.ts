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
  /** History row id (PR 2B). Empty string if history insert failed. */
  historyId?: string;
}

export interface LanguageItem {
  code: string;
  name: string;
}

export interface HistoryItem {
  id: string;
  created_at: string;
  text: string;
  profile?: string;
  engine: string;
  mode?: string;
  seed?: number;
  duration_seconds: number;
  rtf: number;
  sample_rate: number;
}

export interface SaveAsRefParams {
  history_id: string;
  profile: string;
  emotion: string;
  prompt_text?: string;
  prompt_lang?: string;
}

const PREVIEW_URL = '/api/voice-studio/synth/preview';
const HISTORY_URL = '/api/voice-studio/synth/history';
const SAVE_AS_REF_URL = '/api/voice-studio/synth/save-as-ref';
const LANGS_URL = '/api/voice-studio/languages';

function parsePreviewHeaders(res: Response, fallbackBlob: Blob): Omit<PreviewResult, 'blob' | 'blobUrl'> {
  const seedHdr = res.headers.get('X-VoiceStudio-Seed-Used');
  const historyHdr = res.headers.get('X-VoiceStudio-History-Id') || '';
  void fallbackBlob;
  return {
    sampleRate: parseInt(res.headers.get('X-VoiceStudio-Sample-Rate') || '24000', 10),
    rtf: parseFloat(res.headers.get('X-VoiceStudio-RTF') || '0'),
    seedUsed: seedHdr ? parseInt(seedHdr, 10) : undefined,
    durationSeconds: parseFloat(res.headers.get('X-VoiceStudio-Duration-Seconds') || '0'),
    engine: res.headers.get('X-VoiceStudio-Engine') || 'omnivoice',
    historyId: historyHdr || undefined,
  };
}

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
    return {
      blob,
      blobUrl: URL.createObjectURL(blob),
      ...parsePreviewHeaders(res, blob),
    };
  },

  /** GET /api/voice-studio/synth/history — recent rows (cap 20). */
  async getHistory(signal?: AbortSignal): Promise<HistoryItem[]> {
    const res = await fetch(HISTORY_URL, { signal });
    if (!res.ok) throw new Error(`history ${res.status}: ${res.statusText}`);
    const data = await res.json();
    return Array.isArray(data.items) ? (data.items as HistoryItem[]) : [];
  },

  /** Direct audio URL for a stored history row. Streams ``audio/wav``. */
  getHistoryAudioUrl(id: string): string {
    return `${HISTORY_URL}/${encodeURIComponent(id)}/audio`;
  },

  async deleteHistory(id: string): Promise<void> {
    const res = await fetch(`${HISTORY_URL}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`delete history ${res.status}: ${res.statusText}`);
    }
  },

  /**
   * POST /api/voice-studio/synth/history/{id}/replay — re-synthesize
   * with the stored parameters (seed included). Returns the same
   * ``PreviewResult`` shape as ``synthesizePreview``.
   */
  async replayHistory(id: string, signal?: AbortSignal): Promise<PreviewResult> {
    const res = await fetch(`${HISTORY_URL}/${encodeURIComponent(id)}/replay`, {
      method: 'POST',
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`replay ${res.status}: ${text}`);
    }
    const blob = await res.blob();
    return {
      blob,
      blobUrl: URL.createObjectURL(blob),
      ...parsePreviewHeaders(res, blob),
    };
  },

  /**
   * POST /api/voice-studio/synth/save-as-ref — promote a stored
   * synthesis into a profile/emotion ref slot, server-side copy.
   */
  async saveAsRef(body: SaveAsRefParams): Promise<{ ok: true; profile: string; emotion: string }> {
    const res = await fetch(SAVE_AS_REF_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const text = await res.text();
        try {
          detail = JSON.parse(text)?.detail ?? text;
        } catch {
          detail = text;
        }
      } catch {
        /* ignore */
      }
      throw new Error(`save-as-ref ${res.status}: ${detail}`);
    }
    return res.json();
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
