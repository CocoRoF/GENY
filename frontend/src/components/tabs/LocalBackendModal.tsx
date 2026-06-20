/**
 * LocalBackendModal — configure a branded local (OpenAI-compatible)
 * backend: Ollama / LM Studio / Custom (executor 2.9.0).
 *
 * Unlike ApiBackendModal (a single secret field), local backends need:
 *   - a base URL (prefilled with the provider's default endpoint),
 *   - live model discovery (`/local-models`) so the user can see what the
 *     server actually serves and copy a model id into the env editor,
 *   - (Ollama only) a context-window field with an auto-detect button
 *     (`/local-context-window` → Ollama /api/show) so Geny's compaction
 *     can be sized to a small local model instead of the 200k cloud default.
 *
 * Save target (config name = ``llm_credentials``):
 *   ollama   → ollama_base_url (+ ollama_num_ctx)
 *   lmstudio → lmstudio_base_url
 *   custom   → custom_base_url
 */

import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, CheckCircle2, AlertCircle, Search, Copy, Cpu } from 'lucide-react';

import {
  configApi,
  llmBackendsApi,
  type ProviderHealth,
} from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useLLMBackendsHealthStore } from '@/store/useLLMBackendsHealthStore';

export type LocalProviderId = 'ollama' | 'lmstudio' | 'custom';

const URL_FIELD: Record<LocalProviderId, string> = {
  ollama: 'ollama_base_url',
  lmstudio: 'lmstudio_base_url',
  custom: 'custom_base_url',
};

const DEFAULT_URL: Record<LocalProviderId, string> = {
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  custom: '',
};

export default function LocalBackendModal({
  providerId,
  providerLabel,
  onClose,
  onChange,
}: {
  providerId: LocalProviderId;
  providerLabel: string;
  onClose: () => void;
  onChange?: () => void;
}) {
  const { t } = useI18n();
  const [baseUrl, setBaseUrl] = useState('');
  const [numCtx, setNumCtx] = useState<string>(''); // ollama only; '' = auto
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [healthRow, setHealthRow] = useState<ProviderHealth | null>(null);

  const [discovering, setDiscovering] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [detecting, setDetecting] = useState(false);

  const markHealthStale = useLLMBackendsHealthStore((s) => s.markStale);

  // Pre-fill from /api/config/llm_credentials; fall back to the default
  // endpoint so the field is ready to test on open.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await configApi.get('llm_credentials');
        if (!mounted) return;
        const values = (res.values as Record<string, unknown> | undefined) ?? {};
        const stored = values[URL_FIELD[providerId]];
        setBaseUrl(
          typeof stored === 'string' && stored ? stored : DEFAULT_URL[providerId],
        );
        if (providerId === 'ollama') {
          const ctx = values['ollama_num_ctx'];
          if (typeof ctx === 'number' && ctx > 0) setNumCtx(String(ctx));
        }
      } catch {
        setBaseUrl(DEFAULT_URL[providerId]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [providerId]);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await llmBackendsApi.health();
      setHealthRow(res.providers.find((p) => p.provider === providerId) || null);
    } catch {
      /* swallow — health is advisory here */
    }
  }, [providerId]);

  // Mount probe. The setState lands inside the async IIFE (after await),
  // not synchronously in the effect body — the pattern the prefill effect
  // above uses and that react-hooks/set-state-in-effect accepts.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await llmBackendsApi.health();
        if (mounted) {
          setHealthRow(res.providers.find((p) => p.provider === providerId) || null);
        }
      } catch {
        /* swallow */
      }
    })();
    return () => {
      mounted = false;
    };
  }, [providerId]);

  const discover = useCallback(async () => {
    setDiscovering(true);
    setError(null);
    setModels(null);
    try {
      const res = await llmBackendsApi.localModels(providerId, baseUrl || undefined);
      setReachable(res.reachable);
      setModels(res.models);
      if (!res.reachable) {
        setError(t('settings.llmBackends.local.unreachableHint'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  }, [providerId, baseUrl, t]);

  const detectCtx = useCallback(async () => {
    if (!selectedModel) return;
    setDetecting(true);
    setError(null);
    try {
      const res = await llmBackendsApi.localContextWindow(
        providerId,
        selectedModel,
        baseUrl || undefined,
      );
      if (res.context_window && res.context_window > 0) {
        setNumCtx(String(res.context_window));
      } else {
        setError(t('settings.llmBackends.local.ctxUnknown'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetecting(false);
    }
  }, [providerId, selectedModel, baseUrl, t]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = { [URL_FIELD[providerId]]: baseUrl.trim() };
      if (providerId === 'ollama') {
        const n = parseInt(numCtx, 10);
        patch['ollama_num_ctx'] = Number.isFinite(n) && n > 0 ? n : 0;
      }
      await configApi.update('llm_credentials', patch);
      markHealthStale();
      onChange?.();
      await refreshHealth();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [providerId, baseUrl, numCtx, onChange, refreshHealth, markHealthStale]);

  const detail = healthRow?.detail || '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-full max-w-[620px] mx-4 p-5 flex flex-col gap-4 max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center">
          <h3 className="text-[1rem] font-semibold">{providerLabel}</h3>
          <button
            type="button"
            className="w-8 h-8 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)]"
            onClick={onClose}
            aria-label={t('settings.llmBackends.common.close')}
          >
            <X size={16} className="m-auto" />
          </button>
        </div>

        {/* Status row */}
        <div className="rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-3 text-[0.8125rem]">
          {healthRow ? (
            <div className="flex items-center gap-2 flex-wrap">
              {healthRow.available ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 text-[0.7rem]">
                  <CheckCircle2 className="w-3 h-3" /> {t('settings.llmBackends.badge.ready')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-rose-500/30 bg-rose-500/15 text-rose-300 text-[0.7rem]">
                  <AlertCircle className="w-3 h-3" /> {t('settings.llmBackends.badge.notConfigured')}
                </span>
              )}
              <span className="text-[var(--text-secondary)] break-all">{detail}</span>
            </div>
          ) : (
            <span className="text-[var(--text-tertiary)]">—</span>
          )}
        </div>

        {/* Base URL */}
        <div className="flex flex-col gap-2">
          <label className="text-[0.8125rem] font-medium">
            {t('settings.llmBackends.local.baseUrlLabel')}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={DEFAULT_URL[providerId] || 'http://localhost:8080/v1'}
              className="flex-1 px-3 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[0.8125rem] font-mono"
            />
            <button
              type="button"
              onClick={discover}
              disabled={discovering || !baseUrl}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50 shrink-0"
            >
              {discovering ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Search className="w-3.5 h-3.5" />
              )}
              {t('settings.llmBackends.local.discover')}
            </button>
          </div>
          <p className="text-[0.7rem] text-[var(--text-tertiary)] leading-relaxed">
            {t('settings.llmBackends.local.baseUrlHelp')}
          </p>
        </div>

        {/* Discovered models */}
        {models !== null && (
          <div className="flex flex-col gap-2">
            <div className="text-[0.8125rem] font-medium flex items-center gap-2">
              {reachable ? (
                <span className="text-emerald-300">
                  {t('settings.llmBackends.local.modelsFound', { count: models.length })}
                </span>
              ) : (
                <span className="text-rose-300">{t('settings.llmBackends.local.unreachable')}</span>
              )}
            </div>
            {models.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setSelectedModel(m);
                      navigator.clipboard?.writeText(m).catch(() => {});
                    }}
                    title={t('settings.llmBackends.local.copyModel')}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[0.7rem] font-mono transition-colors ${
                      selectedModel === m
                        ? 'border-[var(--primary-color)] bg-[var(--primary-color)]/15 text-[var(--text-primary)]'
                        : 'border-[var(--border-color)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                    }`}
                  >
                    <Copy className="w-3 h-3" /> {m}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[0.7rem] text-[var(--text-tertiary)] leading-relaxed">
              {t('settings.llmBackends.local.modelsHint')}
            </p>
          </div>
        )}

        {/* Ollama context window */}
        {providerId === 'ollama' && (
          <div className="flex flex-col gap-2">
            <label className="text-[0.8125rem] font-medium flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5" /> {t('settings.llmBackends.local.ctxLabel')}
            </label>
            <div className="flex gap-2">
              <input
                type="number"
                min={0}
                value={numCtx}
                onChange={(e) => setNumCtx(e.target.value)}
                placeholder="0 (auto)"
                className="w-40 px-3 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[0.8125rem] font-mono"
              />
              <button
                type="button"
                onClick={detectCtx}
                disabled={detecting || !selectedModel}
                title={
                  selectedModel
                    ? ''
                    : t('settings.llmBackends.local.ctxDetectNeedsModel')
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                {detecting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Cpu className="w-3.5 h-3.5" />
                )}
                {t('settings.llmBackends.local.ctxDetect')}
              </button>
            </div>
            <p className="text-[0.7rem] text-[var(--text-tertiary)] leading-relaxed">
              {t('settings.llmBackends.local.ctxHelp')}
            </p>
          </div>
        )}

        {error && (
          <div className="text-[0.75rem] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-2 break-all">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border-color)]">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] hover:bg-[var(--primary-hover)] transition-colors disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin inline" />
            ) : (
              t('settings.llmBackends.common.save')
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)]"
          >
            {t('settings.llmBackends.common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
