'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { voiceStudioApi, type HistoryItem } from '@/lib/voiceStudioApi';

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

interface SaveAsRefModalProps {
  open: boolean;
  /** History row to promote. Required for the request. */
  item: HistoryItem | null;
  /** Initial emotion (the one the user was working on in the Synthesize card). */
  defaultEmotion?: Emotion;
  /** Initial profile to suggest (auto-falls back to the active non-template). */
  defaultProfile?: string;
  onClose: () => void;
  /** Fires after a successful save; parent typically refreshes its profile list. */
  onSaved: (info: { profile: string; emotion: Emotion }) => void;
}

/**
 * Promotes a stored synthesis row into a profile's reference-audio slot.
 * The profile picker excludes templates (back-end also enforces a 403).
 */
export default function SaveAsRefModal({
  open, item, defaultEmotion, defaultProfile, onClose, onSaved,
}: SaveAsRefModalProps) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<string>(defaultProfile ?? '');
  const [selectedEmotion, setSelectedEmotion] = useState<Emotion>(defaultEmotion ?? 'neutral');
  const [promptText, setPromptText] = useState<string>(item?.text ?? '');
  const [promptLang, setPromptLang] = useState<string>('ko');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Sync internal state with new item / new defaults whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setSelectedEmotion(defaultEmotion ?? 'neutral');
    setSelectedProfile(defaultProfile ?? '');
    setPromptText(item?.text ?? '');
    setPromptLang('ko');
    setError(null);
    setSuccessMsg(null);
  }, [open, item?.text, defaultEmotion, defaultProfile]);

  // Lazy-load the profile list when the modal opens.
  useEffect(() => {
    if (!open) return;
    setLoadingProfiles(true);
    ttsApi
      .listProfiles()
      .then((res) => {
        const list = (res.profiles || []).filter((p) => !p.is_template);
        setProfiles(list);
        setSelectedProfile((prev) => {
          if (prev && list.some((p) => p.name === prev)) return prev;
          const active = list.find((p) => p.active);
          return (active || list[0])?.name || '';
        });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingProfiles(false));
  }, [open]);

  const eligibleProfiles = useMemo(() => profiles, [profiles]);

  const confirm = useCallback(async () => {
    if (!item || !selectedProfile) return;
    setBusy(true);
    setError(null);
    try {
      await voiceStudioApi.saveAsRef({
        history_id: item.id,
        profile: selectedProfile,
        emotion: selectedEmotion,
        prompt_text: promptText || undefined,
        prompt_lang: promptLang || undefined,
      });
      setSuccessMsg(t('voiceStudio.saveAsRef.success', {
        profile: selectedProfile, emotion: selectedEmotion,
      }));
      onSaved({ profile: selectedProfile, emotion: selectedEmotion });
      // brief pause so the toast is legible, then close
      setTimeout(() => onClose(), 700);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [item, selectedProfile, selectedEmotion, promptText, promptLang, t, onSaved, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-[0.9375rem] font-semibold">{t('voiceStudio.saveAsRef.title')}</h3>
          <button
            onClick={onClose}
            className="flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-4 space-y-3">
          {item && (
            <div className="rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] px-3 py-2 text-[0.75rem] text-[var(--text-secondary)]">
              <span className="text-[var(--text-muted)] mr-1">↻</span>
              {item.text.slice(0, 80)}{item.text.length > 80 ? '…' : ''}
            </div>
          )}

          {/* Profile */}
          <div>
            <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-1">
              {t('voiceStudio.saveAsRef.profile')}
            </label>
            {loadingProfiles ? (
              <p className="text-[0.75rem] text-[var(--text-muted)]">
                {t('voiceStudio.saveAsRef.loadingProfiles')}
              </p>
            ) : eligibleProfiles.length === 0 ? (
              <p className="text-[0.75rem] text-[var(--warning-color)]">
                {t('voiceStudio.saveAsRef.noNonTemplate')}
              </p>
            ) : (
              <select
                value={selectedProfile}
                onChange={(e) => setSelectedProfile(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[0.8125rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)]"
              >
                {eligibleProfiles.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.display_name || p.name}{p.active ? ' ★' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Emotion */}
          <div>
            <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-1">
              {t('voiceStudio.saveAsRef.emotion')}
            </label>
            <div className="flex items-center flex-wrap gap-1">
              {EMOTIONS.map((e) => (
                <button
                  key={e}
                  onClick={() => setSelectedEmotion(e)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[0.6875rem] font-medium border cursor-pointer transition-colors ${
                    selectedEmotion === e
                      ? 'bg-[var(--primary-subtle)] border-[var(--primary-color)] text-[var(--primary-color)]'
                      : 'bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  title={e}
                >
                  <span className={`w-2 h-2 rounded-full ${EMOTION_COLORS[e] || 'bg-gray-400'}`} />
                  {t(`voiceStudio.cloneDesign.emotion.${e}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Prompt text */}
          <div>
            <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-1">
              {t('voiceStudio.saveAsRef.promptText')}
            </label>
            <input
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder={t('voiceStudio.saveAsRef.promptTextPlaceholder')}
              className="w-full px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[0.8125rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)]"
            />
          </div>

          {/* Prompt lang */}
          <div>
            <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-1">
              {t('voiceStudio.saveAsRef.promptLang')}
            </label>
            <select
              value={promptLang}
              onChange={(e) => setPromptLang(e.target.value)}
              className="px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[0.8125rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)]"
            >
              <option value="ko">한국어 (ko)</option>
              <option value="en">English (en)</option>
              <option value="ja">日本語 (ja)</option>
              <option value="zh">中文 (zh)</option>
            </select>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(34,197,94,0.1)] text-[var(--success-color)] border border-[rgba(34,197,94,0.2)]">
              {successMsg}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-color)]">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.8125rem] hover:text-[var(--text-primary)] cursor-pointer transition-colors disabled:opacity-50"
          >
            {t('voiceStudio.saveAsRef.cancel')}
          </button>
          <button
            onClick={confirm}
            disabled={busy || !item || !selectedProfile || eligibleProfiles.length === 0}
            className="ml-auto inline-flex items-center gap-1 px-3.5 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {t('voiceStudio.saveAsRef.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
