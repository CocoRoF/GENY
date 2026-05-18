/**
 * ApiBackendModal — Phase G5 / Phase H. A small modal used by the four API
 * backends (Anthropic / OpenAI / Google / vLLM) to paste a credential
 * and re-probe the panel's health card in place. Single component
 * with per-provider field bindings keeps the UI uniform and the code
 * short.
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


type ApiProviderId = 'anthropic' | 'openai' | 'google' | 'vllm';


interface FieldSpec {
  configField: string;
  label: string;
  placeholder: string;
  password: boolean;
  helper: string;
}


const FIELDS: Record<ApiProviderId, FieldSpec> = {
  anthropic: {
    configField: 'anthropic_api_key',
    label: 'Anthropic API Key',
    placeholder: 'sk-ant-…',
    password: true,
    helper: 'Used for the Anthropic API provider. Also acts as the override fallback for Claude Code (CLI) when no host-mounted credential is found.',
  },
  openai: {
    configField: 'openai_api_key',
    label: 'OpenAI API Key',
    placeholder: 'sk-…',
    password: true,
    helper: 'OpenAI Platform API key. The OpenAI client + vLLM (OpenAI-compat) share this slot.',
  },
  google: {
    configField: 'google_api_key',
    label: 'Google API Key',
    placeholder: 'AIza…',
    password: true,
    helper: 'AI Studio / Gemini API key. Used by the google provider in geny-executor.',
  },
  vllm: {
    configField: 'base_url',
    label: 'vLLM Base URL',
    placeholder: 'http://host:8000/v1',
    password: false,
    helper: 'OpenAI-compatible endpoint of your local vLLM server. The provider does not require an API key.',
  },
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
  /** Called after save so the panel refreshes its row. */
  onChange?: () => void;
}) {
  const spec = FIELDS[providerId];
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [healthRow, setHealthRow] = useState<ProviderHealth | null>(null);
  const [probing, setProbing] = useState(false);

  // Pre-fill current value from /api/config/llm_credentials on open (so
  // the user sees the field is "configured" rather than always blank).
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await configApi.get('llm_credentials');
        if (!mounted) return;
        const raw = (res.values as Record<string, unknown> | undefined)?.[spec.configField];
        // Don't leak the actual secret — just indicate it's set.
        if (typeof raw === 'string' && raw) {
          setValue(spec.password ? '••••••••••••••••••••••••' : raw);
        }
      } catch {
        /* swallow — modal still usable */
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
    // Don't write back the masked placeholder if the user didn't edit it.
    if (spec.password && value.startsWith('•')) {
      setError('No new value entered — placeholder was not changed.');
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
  }, [spec.configField, spec.password, value, onChange, refreshHealth]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-full max-w-[560px] mx-4 p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center">
          <h3 className="text-[1rem] font-semibold">{providerLabel}</h3>
          <button type="button" className="w-8 h-8 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)]" onClick={onClose}>
            <X size={16} className="m-auto" />
          </button>
        </div>

        {/* Current status row */}
        <div className="rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-3 text-[0.8125rem]">
          {healthRow ? (
            <div className="flex items-center gap-2">
              {healthRow.available ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 text-[0.7rem]">
                  <CheckCircle2 className="w-3 h-3" /> Ready
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-rose-500/30 bg-rose-500/15 text-rose-300 text-[0.7rem]">
                  <AlertCircle className="w-3 h-3" /> Not configured
                </span>
              )}
              <span className="text-[var(--text-secondary)]">{healthRow.detail || ''}</span>
            </div>
          ) : (
            <span className="text-[var(--text-tertiary)]">{probing ? 'Probing…' : '—'}</span>
          )}
        </div>

        {/* Editable field */}
        <div className="flex flex-col gap-2">
          <label className="text-[0.8125rem] font-medium">{spec.label}</label>
          <div className="flex gap-2">
            <input
              type={spec.password && !visible ? 'password' : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={spec.placeholder}
              className="flex-1 px-3 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[0.8125rem]"
            />
            {spec.password && (
              <button
                type="button"
                className="px-2 rounded border border-[var(--border-color)] hover:bg-[var(--bg-hover)]"
                onClick={() => setVisible((v) => !v)}
              >
                {visible ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
          </div>
          <p className="text-[0.7rem] text-[var(--text-tertiary)] leading-relaxed">{spec.helper}</p>
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
            {probing ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : 'Re-check'}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] hover:bg-[var(--primary-color-hover)] disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : 'Save'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
