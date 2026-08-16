'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2, Upload, Loader2, Play, Square, Mic, Scissors } from 'lucide-react';
import { withAuthHeaders, ttsApi, type VoiceProfile } from '@/lib/api';
import { voiceStudioApi } from '@/lib/voiceStudioApi';
import { useI18n } from '@/lib/i18n';
import RecorderModal from './RecorderModal';
import TrimmerModal from './TrimmerModal';

const EMOTIONS = [
  'neutral', 'joy', 'anger', 'sadness', 'fear', 'surprise', 'disgust', 'smirk',
] as const;
type Emotion = (typeof EMOTIONS)[number];

const EMOTION_COLORS: Record<string, string> = {
  neutral: 'bg-gray-400',
  joy: 'bg-yellow-400',
  anger: 'bg-red-500',
  sadness: 'bg-blue-400',
  fear: 'bg-purple-400',
  surprise: 'bg-orange-400',
  disgust: 'bg-green-500',
  smirk: 'bg-pink-400',
};

const LANGUAGES = [
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];

interface EmotionRefSectionProps {
  profile: VoiceProfile;
  onRefresh: () => Promise<void>;
}

/**
 * Voice Studio port of the EmotionRefCard grid from the legacy
 * ``/tts-voice`` page. Same backend endpoints (``ttsApi.uploadRef`` /
 * ``deleteRef`` / ``updateEmotionRef`` / ``getRefAudioUrl``); UI just
 * lives in the new studio shell.
 *
 * Inline mic-record / waveform-trim actions land in PR 2A.
 */
export default function EmotionRefSection({ profile, onRefresh }: EmotionRefSectionProps) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const isTemplate = !!profile.is_template;

  // Modal state (recorder + trimmer) — outer-managed so 8 cards share a single instance.
  const [activeEmotion, setActiveEmotion] = useState<Emotion | null>(null);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [trimmerOpen, setTrimmerOpen] = useState(false);
  const [trimSource, setTrimSource] = useState<Blob | null>(null);

  const showMsg = useCallback((type: 'success' | 'error', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  }, []);

  const handleUpload = useCallback(
    async (emotion: Emotion, file: File, text?: string, lang?: string) => {
      setUploading(emotion);
      try {
        await ttsApi.uploadRef(profile.name, emotion, file, text, lang);
        showMsg('success', `${emotion} ${t('ttsVoice.uploaded')}`);
        await onRefresh();
      } catch (e: unknown) {
        showMsg('error', e instanceof Error ? e.message : String(e));
      }
      setUploading(null);
    },
    [profile.name, onRefresh, showMsg, t],
  );

  const openRecorder = useCallback((emotion: Emotion) => {
    setActiveEmotion(emotion);
    setRecorderOpen(true);
  }, []);

  const openTrimmerForExistingRef = useCallback(
    async (emotion: Emotion) => {
      setActiveEmotion(emotion);
      try {
        const url = ttsApi.getRefAudioUrl(profile.name, emotion);
        const res = await fetch(url, { headers: withAuthHeaders() });
        if (!res.ok) throw new Error(`ref audio ${res.status}`);
        const blob = await res.blob();
        setTrimSource(blob);
        setTrimmerOpen(true);
      } catch (e: unknown) {
        showMsg('error', e instanceof Error ? e.message : String(e));
      }
    },
    [profile.name, showMsg],
  );

  const handleRecorderConfirm = useCallback(
    (wav: Blob) => {
      if (!activeEmotion) return;
      const file = new File([wav], `ref_${activeEmotion}.wav`, { type: 'audio/wav' });
      handleUpload(activeEmotion, file);
    },
    [activeEmotion, handleUpload],
  );

  const handleRecorderRequestTrim = useCallback((wav: Blob) => {
    setTrimSource(wav);
    setTrimmerOpen(true);
  }, []);

  const handleTrimmerConfirm = useCallback(
    (wav: Blob) => {
      if (!activeEmotion) return;
      const file = new File([wav], `ref_${activeEmotion}.wav`, { type: 'audio/wav' });
      handleUpload(activeEmotion, file);
      setTrimSource(null);
    },
    [activeEmotion, handleUpload],
  );

  const closeAllModals = useCallback(() => {
    setRecorderOpen(false);
    setTrimmerOpen(false);
    setTrimSource(null);
    setActiveEmotion(null);
  }, []);

  const handleDelete = useCallback(
    async (emotion: string) => {
      try {
        await ttsApi.deleteRef(profile.name, emotion);
        showMsg('success', `${emotion} ${t('ttsVoice.deleted')}`);
        await onRefresh();
      } catch (e: unknown) {
        showMsg('error', e instanceof Error ? e.message : String(e));
      }
    },
    [profile.name, onRefresh, showMsg, t],
  );

  const handleUpdatePrompt = useCallback(
    async (emotion: string, body: { prompt_text?: string; prompt_lang?: string }) => {
      try {
        await ttsApi.updateEmotionRef(profile.name, emotion, body);
        showMsg('success', t('ttsVoice.saved'));
        await onRefresh();
      } catch (e: unknown) {
        showMsg('error', e instanceof Error ? e.message : String(e));
      }
    },
    [profile.name, onRefresh, showMsg, t],
  );

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[0.875rem] font-semibold mb-1 text-[var(--text-primary)]">
          {t('ttsVoice.emotionRefs')}
        </h3>
        <p className="text-[0.6875rem] text-[var(--text-muted)]">{t('ttsVoice.emotionRefsHint')}</p>
      </div>

      {msg && (
        <div className={`px-3 py-2 rounded-lg text-[0.8125rem] font-medium ${
          msg.type === 'success'
            ? 'bg-[rgba(34,197,94,0.1)] text-[var(--success-color)] border border-[rgba(34,197,94,0.2)]'
            : 'bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]'
        }`}>
          {msg.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2">
        {EMOTIONS.map((emotion) => (
          <EmotionRefCard
            key={emotion}
            profileName={profile.name}
            emotion={emotion}
            hasRef={!!profile.has_refs?.[emotion]}
            emotionRef={profile.emotion_refs?.[emotion]}
            uploading={uploading === emotion}
            isTemplate={isTemplate}
            onUpload={(file, text, lang) => handleUpload(emotion, file, text, lang)}
            onDelete={() => handleDelete(emotion)}
            onUpdatePrompt={(body) => handleUpdatePrompt(emotion, body)}
            onRecord={() => openRecorder(emotion)}
            onTrim={() => openTrimmerForExistingRef(emotion)}
            t={t}
          />
        ))}
      </div>

      {/* Modals (mounted once, driven by activeEmotion + open flags) */}
      <RecorderModal
        open={recorderOpen}
        onClose={() => {
          setRecorderOpen(false);
          // Keep activeEmotion alive so the trimmer can still tag the upload
          // if the recorder closed via "trim next".
          if (!trimmerOpen) setActiveEmotion(null);
        }}
        onConfirm={handleRecorderConfirm}
        onRequestTrim={handleRecorderRequestTrim}
      />
      <TrimmerModal
        open={trimmerOpen}
        source={trimSource}
        onClose={closeAllModals}
        onConfirm={handleTrimmerConfirm}
      />
    </section>
  );
}

interface EmotionRefCardProps {
  profileName: string;
  emotion: Emotion;
  hasRef: boolean;
  emotionRef?: { file: string; prompt_text?: string; prompt_lang?: string };
  uploading: boolean;
  isTemplate?: boolean;
  onUpload: (file: File, text?: string, lang?: string) => void;
  onDelete: () => void;
  onUpdatePrompt: (body: { prompt_text?: string; prompt_lang?: string }) => void;
  onRecord: () => void;
  onTrim: () => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}

function EmotionRefCard({
  profileName, emotion, hasRef, emotionRef, uploading, isTemplate,
  onUpload, onDelete, onUpdatePrompt, onRecord, onTrim, t,
}: EmotionRefCardProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playStartingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [localPromptText, setLocalPromptText] = useState(emotionRef?.prompt_text || '');
  const [localPromptLang, setLocalPromptLang] = useState(emotionRef?.prompt_lang || 'ko');

  // Sync local state when the parent passes a new ref payload (e.g. after upload).
  const syncKey = `${profileName}|${emotion}|${emotionRef?.prompt_text}|${emotionRef?.prompt_lang}`;
  useEffect(() => {
    setLocalPromptText(emotionRef?.prompt_text || '');
    setLocalPromptLang(emotionRef?.prompt_lang || 'ko');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey]);

  const togglePlay = useCallback(() => {
    if (!hasRef) return;
    if (playStartingRef.current) return; // a play is already in flight
    if (playing && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      if (audioRef.current.src?.startsWith('blob:')) {
        URL.revokeObjectURL(audioRef.current.src);
      }
      setPlaying(false);
      return;
    }
    // bare <audio src> can't carry the Bearer header and the auth
    // cookie is unreliable (7d expiry) — fetch the bytes authed and
    // play a blob object URL instead (same pattern audioManager uses)
    playStartingRef.current = true;
    void (async () => {
      try {
        const objectUrl = await voiceStudioApi.fetchAuthedObjectUrl(
          ttsApi.getRefAudioUrl(profileName, emotion),
        );
        // a previous play's blob may still be attached — release it
        if (audioRef.current?.src?.startsWith('blob:')) {
          URL.revokeObjectURL(audioRef.current.src);
        }
        const audio = new Audio(objectUrl);
        audioRef.current = audio;
        await audio.play();
        setPlaying(true);
        const cleanup = () => {
          URL.revokeObjectURL(objectUrl);
          setPlaying(false);
        };
        audio.onended = cleanup;
        audio.onerror = cleanup;
      } catch {
        setPlaying(false);
      } finally {
        playStartingRef.current = false;
      }
    })();
  }, [hasRef, playing, profileName, emotion]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        if (audioRef.current.src?.startsWith('blob:')) {
          URL.revokeObjectURL(audioRef.current.src);
        }
        audioRef.current = null;
      }
    };
  }, []);

  return (
    <div className={`rounded-xl border transition-colors ${
      hasRef
        ? 'border-[rgba(34,197,94,0.3)] bg-[rgba(34,197,94,0.03)]'
        : 'border-[var(--border-color)] bg-[var(--bg-secondary)]'
    }`}>
      {/* Top row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={`w-3 h-3 rounded-full shrink-0 ${EMOTION_COLORS[emotion] || 'bg-gray-400'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-[0.8125rem] font-medium capitalize">{emotion}</p>
          <p className="text-[0.6875rem] text-[var(--text-muted)]">
            {hasRef ? `ref_${emotion}.wav` : t('ttsVoice.noRef')}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {uploading ? (
            <Loader2 size={14} className="animate-spin text-[var(--primary-color)]" />
          ) : (
            <>
              {hasRef && (
                <button
                  onClick={togglePlay}
                  className={`flex items-center justify-center w-7 h-7 rounded-md border cursor-pointer transition-all ${
                    playing
                      ? 'bg-[var(--primary-color)] border-[var(--primary-color)] text-white'
                      : 'bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)]'
                  }`}
                  title={playing ? t('ttsVoice.stop') : t('ttsVoice.play')}
                >
                  {playing ? <Square size={10} /> : <Play size={12} />}
                </button>
              )}
              {!isTemplate && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".wav"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUpload(f, localPromptText || undefined, localPromptLang || undefined);
                      e.target.value = '';
                    }}
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-all"
                    title={t('ttsVoice.upload')}
                  >
                    <Upload size={12} />
                  </button>
                  <button
                    onClick={onRecord}
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-all"
                    title={t('voiceStudio.recorder.openTitle')}
                  >
                    <Mic size={12} />
                  </button>
                  {hasRef && (
                    <button
                      onClick={onTrim}
                      className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-all"
                      title={t('voiceStudio.trimmer.openTitle')}
                    >
                      <Scissors size={12} />
                    </button>
                  )}
                  {hasRef && (
                    <button
                      onClick={onDelete}
                      className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--danger-color)] hover:border-[var(--danger-color)] cursor-pointer transition-all"
                      title={t('ttsVoice.delete')}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Bottom row: per-emotion prompt */}
      {hasRef && (
        <div className="px-4 pb-3 border-t border-[var(--border-color)] pt-2">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-0.5">
                {t('ttsVoice.refPromptText')}
              </label>
              {isTemplate ? (
                <p className="px-2.5 py-1.5 text-[0.75rem] text-[var(--text-primary)]">
                  {localPromptText || (
                    <span className="text-[var(--text-muted)] italic">{t('ttsVoice.noPromptText')}</span>
                  )}
                </p>
              ) : (
                <input
                  value={localPromptText}
                  onChange={(e) => setLocalPromptText(e.target.value)}
                  onBlur={() => {
                    if (localPromptText !== (emotionRef?.prompt_text || '')) {
                      onUpdatePrompt({ prompt_text: localPromptText });
                    }
                  }}
                  placeholder={t('ttsVoice.refPromptPlaceholder')}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.75rem] outline-none focus:border-[var(--primary-color)]"
                />
              )}
            </div>
            <div className="shrink-0">
              <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-0.5">
                {t('ttsVoice.refLang')}
              </label>
              {isTemplate ? (
                <p className="px-2 py-1.5 text-[0.75rem] text-[var(--text-primary)]">
                  {LANGUAGES.find((l) => l.value === localPromptLang)?.label || localPromptLang}
                </p>
              ) : (
                <select
                  value={localPromptLang}
                  onChange={(e) => {
                    setLocalPromptLang(e.target.value);
                    onUpdatePrompt({ prompt_lang: e.target.value });
                  }}
                  className="px-2 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.75rem] outline-none focus:border-[var(--primary-color)]"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.value} value={l.value}>{l.label}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
