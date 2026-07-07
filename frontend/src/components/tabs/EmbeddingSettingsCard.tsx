'use client';

/**
 * EmbeddingSettingsCard — the Model & Provider panel's "Embedding" card.
 *
 * The COMMON embedding setting: which provider/model embeds knowledge
 * documents. Saves to config `embedding_settings`; the API key comes from
 * the same panel's provider cards. The knowledge repository records the
 * model per document and offers re-embedding when this setting changes.
 */

import { useEffect, useState } from 'react';
import { Layers, Loader2, X } from 'lucide-react';

import { configApi, type ProviderHealth } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROVIDER,
  EMBEDDING_PROVIDERS,
  dimensionOf,
  modelsFor,
} from '@/lib/embeddingModels';
import { SettingsCard, type CardStatusTone } from '@/components/settings/SettingsCard';

const selectCls =
  'w-full rounded border border-[var(--border-color)] bg-[var(--bg-primary)] ' +
  'px-2.5 py-2 text-[0.8125rem] outline-none focus:border-[var(--primary-color)]';

export function EmbeddingSettingsCard({
  providers,
  onSaved,
}: {
  providers: ProviderHealth[];
  onSaved?: () => void;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = useState(DEFAULT_EMBEDDING_PROVIDER);
  const [model, setModel] = useState(DEFAULT_EMBEDDING_MODEL);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await configApi.get('embedding_settings');
        if (cancelled) return;
        const values = (res.values ?? {}) as { provider?: string; model?: string };
        if (values.provider) setProvider(values.provider);
        if (values.model) setModel(values.model);
      } catch {
        /* defaults stand */
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const keyRow = providers.find((p) => p.provider === provider);
  const keyReady = !!keyRow?.available && keyRow?.auth_ok !== false;

  let tone: CardStatusTone = 'good';
  let badge = t('settings.llmBackends.badge.ready');
  if (!loaded) {
    tone = 'neutral';
    badge = '…';
  } else if (!keyReady) {
    tone = 'bad';
    badge = t('settings.llmBackends.embedding.keyMissingBadge');
  }

  const dim = dimensionOf(provider, model);

  return (
    <>
      <SettingsCard
        onClick={() => setOpen(true)}
        ariaLabel={t('settings.llmBackends.embedding.cardAria')}
        icon={<Layers className="w-4 h-4" />}
        title={t('settings.llmBackends.embedding.title')}
        meta={
          <>
            <span className="font-mono">{provider}</span>
            <span className="opacity-50">·</span>
            <span className="font-mono">{model}</span>
            {dim != null && (
              <>
                <span className="opacity-50">·</span>
                <span>{dim}d</span>
              </>
            )}
          </>
        }
        status={{ tone, label: badge }}
      >
        <div className="text-[0.8125rem] text-[var(--text-secondary)]">
          {keyReady
            ? t('settings.llmBackends.embedding.detailReady', { provider })
            : t('settings.llmBackends.embedding.detailKeyMissing', { provider })}
        </div>
      </SettingsCard>

      {open && (
        <EmbeddingSettingsModal
          initialProvider={provider}
          initialModel={model}
          providers={providers}
          onClose={() => setOpen(false)}
          onSaved={(p, m) => {
            setProvider(p);
            setModel(m);
            setOpen(false);
            onSaved?.();
          }}
        />
      )}
    </>
  );
}

export function EmbeddingSettingsModal({
  initialProvider,
  initialModel,
  providers,
  onClose,
  onSaved,
}: {
  initialProvider: string;
  initialModel: string;
  providers: ProviderHealth[];
  onClose: () => void;
  onSaved: (provider: string, model: string) => void;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = useState(initialProvider);
  const [model, setModel] = useState(initialModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const models = modelsFor(provider);
  const effectiveModel = models.includes(model) ? model : models[0] ?? '';
  const keyRow = providers.find((p) => p.provider === provider);
  const keyReady = !!keyRow?.available && keyRow?.auth_ok !== false;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await configApi.update('embedding_settings', {
        provider,
        model: effectiveModel,
      });
      onSaved(provider, effectiveModel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[0.9375rem] font-semibold flex items-center gap-2">
            <Layers className="w-4 h-4" />
            {t('settings.llmBackends.embedding.modalTitle')}
          </h3>
          <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="mb-4 text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed">
          {t('settings.llmBackends.embedding.modalHelp')}
        </p>

        <label className="mb-1 block text-[0.75rem] font-medium text-[var(--text-tertiary)]">
          {t('settings.llmBackends.embedding.providerLabel')}
        </label>
        <select
          className={`${selectCls} mb-3`}
          value={provider}
          onChange={(e) => {
            const p = e.target.value;
            setProvider(p);
            const first = modelsFor(p)[0];
            if (first) setModel(first);
          }}
        >
          {EMBEDDING_PROVIDERS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>

        <label className="mb-1 block text-[0.75rem] font-medium text-[var(--text-tertiary)]">
          {t('settings.llmBackends.embedding.modelLabel')}
        </label>
        <select
          className={`${selectCls} mb-3`}
          value={effectiveModel}
          onChange={(e) => setModel(e.target.value)}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m} ({dimensionOf(provider, m)}d)
            </option>
          ))}
        </select>

        {!keyReady && (
          <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2.5 text-[0.78rem] text-amber-500">
            {t('settings.llmBackends.embedding.modalKeyWarning', { provider })}
          </div>
        )}

        <div className="mb-3 text-[0.75rem] text-[var(--text-tertiary)]">
          {t('settings.llmBackends.embedding.reembedHint')}
        </div>

        {error && (
          <div className="mb-3 text-[0.78rem] text-rose-400">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[var(--border-color)] px-3 py-1.5 text-[0.8125rem] hover:bg-[var(--bg-hover)]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !effectiveModel}
            className="inline-flex items-center gap-1.5 rounded bg-[var(--primary-color)] px-3 py-1.5 text-[0.8125rem] font-medium text-white disabled:opacity-50"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default EmbeddingSettingsCard;
