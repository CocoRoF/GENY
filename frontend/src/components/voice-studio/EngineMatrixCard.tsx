'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, RefreshCw, Loader2, Cloud, Cpu } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { voiceStudioApi, type EngineCard } from '@/lib/voiceStudioApi';

/**
 * Engine Compatibility Matrix card.
 *
 * Reads ``GET /api/voice-studio/engines`` and renders one row per
 * registered engine with its metadata + availability badge + a "set
 * default" radio. The default selection is mirrored into the chat
 * path's ``tts_general_config.provider`` server-side, so changing
 * here also flips which engine the agent chat uses.
 */
export default function EngineMatrixCard() {
  const { t } = useI18n();
  const [engines, setEngines] = useState<EngineCard[]>([]);
  const [defaultId, setDefaultId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await voiceStudioApi.getEngines(signal);
      setEngines(res.engines);
      setDefaultId(res.default);
      setError(null);
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const setDefault = useCallback(async (id: string) => {
    if (id === defaultId) return;
    setBusy(true);
    setError(null);
    try {
      await voiceStudioApi.setDefaultEngine(id);
      setDefaultId(id);
      setToast(t('voiceStudio.settings.engines.defaultSet', { id }));
      setTimeout(() => setToast(null), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [defaultId, t]);

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-[0.9375rem] font-semibold">{t('voiceStudio.settings.engines.title')}</h2>
        <button
          onClick={() => load()}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-[0.6875rem] text-[var(--text-muted)] hover:text-[var(--primary-color)] bg-transparent border-none cursor-pointer transition-colors disabled:opacity-50"
          title={t('voiceStudio.settings.engines.refresh')}
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          {t('voiceStudio.settings.engines.refresh')}
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}
      {toast && (
        <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(34,197,94,0.1)] text-[var(--success-color)] border border-[rgba(34,197,94,0.2)]">
          {toast}
        </div>
      )}

      {loading && engines.length === 0 ? (
        <p className="text-[0.875rem] text-[var(--text-muted)] py-6 text-center">
          {t('voiceStudio.settings.engines.loading')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[0.75rem] border-collapse">
            <thead>
              <tr className="border-b border-[var(--border-color)] text-[var(--text-muted)] text-left">
                <th className="py-2 pr-2 font-medium">{t('voiceStudio.settings.engines.default')}</th>
                <th className="py-2 pr-2 font-medium">{t('voiceStudio.settings.engines.engine')}</th>
                <th className="py-2 pr-2 font-medium">{t('voiceStudio.settings.engines.status')}</th>
                <th className="py-2 pr-2 font-medium">{t('voiceStudio.settings.engines.hw')}</th>
                <th className="py-2 pr-2 font-medium">{t('voiceStudio.settings.engines.langs')}</th>
                <th className="py-2 pr-2 font-medium">{t('voiceStudio.settings.engines.features')}</th>
                <th className="py-2 pr-2 font-medium">{t('voiceStudio.settings.engines.license')}</th>
              </tr>
            </thead>
            <tbody>
              {engines.map((e) => {
                const isDefault = e.id === defaultId;
                const isCloud = e.gpu_compat.includes('cloud');
                return (
                  <tr
                    key={e.id}
                    className={`border-b border-[var(--border-color)] ${
                      isDefault ? 'bg-[var(--primary-subtle)]' : ''
                    }`}
                  >
                    <td className="py-2 pr-2">
                      <input
                        type="radio"
                        name="default-engine"
                        checked={isDefault}
                        onChange={() => setDefault(e.id)}
                        disabled={busy || !e.available}
                        className="cursor-pointer disabled:cursor-not-allowed"
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <div className="font-medium text-[var(--text-primary)]">{e.display_name}</div>
                      <div className="text-[0.6875rem] text-[var(--text-muted)] font-mono">{e.id}</div>
                    </td>
                    <td className="py-2 pr-2">
                      {e.available ? (
                        <span className="inline-flex items-center gap-1 text-[var(--success-color)]">
                          <CheckCircle2 size={12} />
                          {e.reason || 'ok'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[var(--warning-color)]" title={e.reason}>
                          <AlertTriangle size={12} />
                          {e.reason || 'unavailable'}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <span className="inline-flex items-center gap-1 text-[var(--text-secondary)]">
                        {isCloud ? <Cloud size={11} /> : <Cpu size={11} />}
                        {e.gpu_compat.join(' / ')}
                      </span>
                    </td>
                    <td className="py-2 pr-2 text-[var(--text-secondary)]">
                      {e.supported_languages.length === 1 ? e.supported_languages[0] : `${e.supported_languages.length} langs`}
                    </td>
                    <td className="py-2 pr-2 text-[var(--text-secondary)]">
                      {e.supports_voice_design && (
                        <span className="inline-block mr-1 px-1.5 py-px rounded text-[0.625rem] bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
                          design
                        </span>
                      )}
                      {e.supports_clone && (
                        <span className="inline-block mr-1 px-1.5 py-px rounded text-[0.625rem] bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
                          clone
                        </span>
                      )}
                      {e.supports_emotion_vector && (
                        <span className="inline-block mr-1 px-1.5 py-px rounded text-[0.625rem] bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
                          emotion-vec
                        </span>
                      )}
                      {!e.supports_voice_design && !e.supports_clone && !e.supports_emotion_vector && (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-[0.6875rem] text-[var(--text-muted)]">
                      {e.license || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[0.6875rem] text-[var(--text-muted)]">
        {t('voiceStudio.settings.engines.note')}
      </p>
      {busy && (
        <p className="text-[0.6875rem] text-[var(--text-muted)] inline-flex items-center gap-1">
          <Loader2 size={11} className="animate-spin" />
          {t('voiceStudio.settings.engines.saving')}
        </p>
      )}
    </section>
  );
}
