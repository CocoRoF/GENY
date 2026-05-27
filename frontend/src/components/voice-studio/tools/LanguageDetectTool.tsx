'use client';

import { useCallback, useState } from 'react';
import { Loader2, Languages, Sparkles } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { voiceStudioApi, type LangDetectResult } from '@/lib/voiceStudioApi';
import ToolCard from './ToolCard';

export default function LanguageDetectTool() {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LangDetectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await voiceStudioApi.detectLanguage(text);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [text]);

  return (
    <ToolCard
      icon={<Languages size={14} className="text-[var(--primary-color)]" />}
      title={t('voiceStudio.tools.langDetect.title')}
      hint={t('voiceStudio.tools.langDetect.hint')}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={t('voiceStudio.tools.langDetect.placeholder')}
        className="w-full px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.8125rem] outline-none focus:border-[var(--primary-color)] resize-none"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={run}
          disabled={busy || !text.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.75rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {t('voiceStudio.tools.langDetect.detect')}
        </button>
      </div>
      {error && (
        <div className="mt-2 px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}
      {result && (
        <div className="mt-3 px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)]">
          <div className="text-[0.8125rem]">
            <span className="text-[var(--text-muted)]">{t('voiceStudio.tools.langDetect.language')}:</span>{' '}
            <span className="font-mono font-medium text-[var(--text-primary)]">{result.language}</span>
            <span className="text-[var(--text-muted)] ml-3">
              {t('voiceStudio.tools.langDetect.confidence')}:
            </span>{' '}
            <span className="font-mono">{(result.confidence * 100).toFixed(1)}%</span>
          </div>
          <div className="mt-1 text-[0.6875rem] text-[var(--text-muted)] font-mono">
            {Object.entries(result.detail)
              .filter(([, v]) => v > 0)
              .sort(([, a], [, b]) => b - a)
              .map(([k, v]) => `${k}: ${(v * 100).toFixed(1)}%`)
              .join(' · ')}
          </div>
        </div>
      )}
    </ToolCard>
  );
}
