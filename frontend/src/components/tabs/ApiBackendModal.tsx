/**
 * ApiBackendModal — Phase G5 / Phase H polish.
 *
 * A small modal used by the four API backends (Anthropic / OpenAI /
 * Google / vLLM) to paste a credential and re-probe the panel's health
 * card in place.
 *
 * Save target (config name = ``llm_credentials``, hidden from the
 * generic SettingsTab list — this modal is the only editor):
 *   - llm_credentials.anthropic_api_key  → Anthropic
 *   - llm_credentials.openai_api_key     → OpenAI
 *   - llm_credentials.google_api_key     → Google Gemini
 *   - llm_credentials.base_url           → vLLM (text instead of password)
 */

import { useCallback, useEffect, useState } from 'react';
import { X, Eye, EyeOff, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

import { configApi, llmBackendsApi, type ProviderHealth } from '@/lib/api';
import { useI18n } from '@/lib/i18n';


type ApiProviderId = 'anthropic' | 'openai' | 'google' | 'vllm';


interface FieldSpec {
  configField: string;
  password: boolean;
}


const FIELDS: Record<ApiProviderId, FieldSpec> = {
  anthropic: { configField: 'anthropic_api_key', password: true },
  openai:    { configField: 'openai_api_key',    password: true },
  google:    { configField: 'google_api_key',    password: true },
  vllm:      { configField: 'base_url',          password: false },
};


export default function ApiBackendModal({
  providerId,
  providerLabel,
  onClose,
  onChange,
}: {
  providerId: ApiProviderId;
  providerLabel: string;
  onClose: () => void;
  onChange?: () => void;
}) {
  const { t } = useI18n();
  const spec = FIELDS[providerId];
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [healthRow, setHealthRow] = useState<ProviderHealth | null>(null);
  const [probing, setProbing] = useState(false);

  // Pre-fill current value from /api/config/llm_credentials on open.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await configApi.get('llm_credentials');
        if (!mounted) return;
        const raw = (res.values as Record<string, unknown> | undefined)?.[spec.configField];
        if (typeof raw === 'string' && raw) {
          setValue(spec.password ? '••••••••••••••••••••••••' : raw);
        }
      } catch {
        /* swallow */
      }
    })();
    return () => { mounted = false; };
  }, [spec.configField, spec.password]);

  const refreshHealth = useCallback(async () => {
    setProbing(true);
    try {
      const res = await llmBackendsApi.health();
      const row = res.providers.find((p) => p.provider === providerId) || null;
      setHealthRow(row);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  }, [providerId]);

  useEffect(() => { refreshHealth(); }, [refreshHealth]);

  const save = useCallback(async () => {
    if (spec.password && value.startsWith('•')) {
      setError(t('settings.llmBackends.apiModal.placeholderUnchanged'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await configApi.update('llm_credentials', { [spec.configField]: value });
      onChange?.();
      await refreshHealth();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [spec.configField, spec.password, value, onChange, refreshHealth, t]);

  const fieldLabel = t(`settings.llmBackends.apiModal.fieldLabel.${providerId}`);
  const helper = t(`settings.llmBackends.apiModal.helper.${providerId}`);
  const placeholder = t(`settings.llmBackends.apiModal.placeholder.${providerId}`);

  // Render detail row using same code-path as panel
  let detailNode: React.ReactNode = '—';
  if (healthRow) {
    const code = healthRow.detail_code;
    if (code) {
      const key = `settings.llmBackends.detail.${code}`;
      const rendered = t(key, healthRow.detail_params ?? {});
      detailNode = rendered === key ? (healthRow.detail || '') : rendered;
    } else {
      detailNode = healthRow.detail || '';
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-full max-w-[560px] mx-4 p-5 flex flex-col gap-4"
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

        {/* Current status row */}
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
              <span className="text-[var(--text-secondary)] break-all">{detailNode}</span>
            </div>
          ) : (
            <span className="text-[var(--text-tertiary)]">
              {probing ? t('settings.llmBackends.common.probing') : '—'}
            </span>
          )}
        </div>

        {/* Editable field */}
        <div className="flex flex-col gap-2">
          <label className="text-[0.8125rem] font-medium">{fieldLabel}</label>
          <div className="flex gap-2">
            <input
              type={spec.password && !visible ? 'password' : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              className="flex-1 px-3 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[0.8125rem]"
            />
            {spec.password && (
              <button
                type="button"
                className="px-2 rounded border border-[var(--border-color)] hover:bg-[var(--bg-hover)]"
                onClick={() => setVisible((v) => !v)}
                aria-label={visible ? t('settings.hide') : t('settings.show')}
              >
                {visible ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
          </div>
          <p className="text-[0.7rem] text-[var(--text-tertiary)] leading-relaxed">{helper}</p>
        </div>

        {error && (
          <div className="text-[0.75rem] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border-color)]">
          <button
            type="button"
            onClick={refreshHealth}
            disabled={probing}
            className="px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {probing
              ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" />
              : t('settings.llmBackends.apiModal.reCheck')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] hover:bg-[var(--primary-hover)] transition-colors disabled:opacity-50"
          >
            {saving
              ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" />
              : t('settings.llmBackends.common.save')}
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
