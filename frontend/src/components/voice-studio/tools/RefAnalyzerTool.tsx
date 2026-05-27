'use client';

import { useCallback, useState } from 'react';
import { Activity, Loader2, Upload } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { voiceStudioApi, type RefAnalysisResult } from '@/lib/voiceStudioApi';
import ToolCard from './ToolCard';

export default function RefAnalyzerTool() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RefAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>('');

  const onFile = useCallback(async (file: File) => {
    setFilename(file.name);
    setBusy(true);
    setError(null);
    try {
      const r = await voiceStudioApi.analyzeRef(file);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <ToolCard
      icon={<Activity size={14} className="text-[var(--primary-color)]" />}
      title={t('voiceStudio.tools.refAnalyzer.title')}
      hint={t('voiceStudio.tools.refAnalyzer.hint')}
    >
      <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.75rem] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors">
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
        {t('voiceStudio.tools.refAnalyzer.upload')}
        <input
          type="file"
          accept=".wav,audio/wav"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
      </label>
      {filename && (
        <span className="ml-2 text-[0.6875rem] text-[var(--text-muted)] font-mono">{filename}</span>
      )}

      {error && (
        <div className="mt-2 px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[0.75rem]">
            <Stat label={t('voiceStudio.tools.refAnalyzer.duration')} value={`${result.duration_seconds.toFixed(2)}s`} />
            <Stat label={t('voiceStudio.tools.refAnalyzer.sampleRate')} value={`${result.sample_rate} Hz`} />
            <Stat label={t('voiceStudio.tools.refAnalyzer.channels')} value={result.channels} />
            <Stat label={t('voiceStudio.tools.refAnalyzer.rmsDb')} value={`${result.rms_db.toFixed(1)} dB`} />
            <Stat label={t('voiceStudio.tools.refAnalyzer.silenceRatio')} value={`${(result.silence_ratio * 100).toFixed(0)}%`} />
          </div>

          {result.suggested_windows.length > 0 && (
            <div>
              <p className="text-[0.6875rem] font-medium text-[var(--text-secondary)] mb-1">
                {t('voiceStudio.tools.refAnalyzer.suggestedWindows')}
              </p>
              <ul className="space-y-1">
                {result.suggested_windows.map((w, i) => (
                  <li
                    key={`${w.start}-${w.end}-${i}`}
                    className="rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-1.5 text-[0.75rem] font-mono text-[var(--text-secondary)]"
                  >
                    {w.start.toFixed(2)}s — {w.end.toFixed(2)}s · {(w.end - w.start).toFixed(2)}s · RMS {w.rms_db.toFixed(1)} dB · silent {(w.silent_ratio * 100).toFixed(0)}%
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </ToolCard>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2">
      <div className="text-[0.625rem] text-[var(--text-muted)]">{label}</div>
      <div className="font-mono text-[var(--text-primary)]">{value}</div>
    </div>
  );
}
