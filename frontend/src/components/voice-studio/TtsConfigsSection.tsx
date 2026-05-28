'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Loader2, RotateCcw, Save, Settings, X } from 'lucide-react';
import { configApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { ConfigField, ConfigItem, ConfigSchema } from '@/types';
import {
  ConfigFieldInput,
  getLocalizedField,
  getLocalizedGroup,
  getLocalizedSchema,
} from '@/components/tabs/SettingsTab';

const TTS_CATEGORY = 'tts';

const DEFAULT_GROUP_LABELS: Record<string, string> = {
  basic: 'Basic',
  emotion: 'Emotion',
  audio: 'Audio',
  cache: 'Cache',
  streaming: 'Streaming',
  generation: 'Generation',
  whisper: 'Whisper / ASR',
  server: 'Server',
  voice: 'Voice',
  output: 'Output',
  api: 'API',
};

/**
 * Voice Studio TTS configs section.
 *
 * Reads every config whose ``schema.category === 'tts'`` (Edge TTS,
 * ElevenLabs, OpenAI TTS, OmniVoice, General TTS), shows them as a
 * grid of cards mirroring the layout from Geny's main Settings page,
 * and opens a per-config modal editor that reuses the SettingsTab
 * schema-driven inputs. Saves go through the same ``configApi.update``
 * so the legacy /setup TTS section and this page stay in sync
 * automatically.
 */
export default function TtsConfigsSection() {
  const { t, locale } = useI18n();
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    name: string;
    schema: ConfigSchema;
    values: Record<string, unknown>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await configApi.list();
      const ttsOnly = (res.configs || []).filter((c) => c.schema?.category === TTS_CATEGORY);
      setConfigs(ttsOnly);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const tid = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(tid);
  }, [toast]);

  const openEditor = useCallback(async (name: string) => {
    try {
      const res = await configApi.get(name);
      setEditing({ name, schema: res.schema, values: { ...res.values } });
    } catch (e: unknown) {
      setToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const closeEditor = useCallback(() => setEditing(null), []);

  const updateField = useCallback((field: string, value: unknown) => {
    setEditing((prev) => (prev ? { ...prev, values: { ...prev.values, [field]: value } } : prev));
  }, []);

  const saveEditing = useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const values: Record<string, unknown> = {};
      editing.schema.fields.forEach((f) => {
        const v = editing.values[f.name];
        if (f.type === 'textarea' && f.name.includes('_ids') && typeof v === 'string') {
          const text = v.trim();
          values[f.name] = text ? text.split(',').map((s) => s.trim()).filter(Boolean) : [];
        } else {
          values[f.name] = v;
        }
      });
      const res = await configApi.update(editing.name, values);
      if (res.success) {
        setToast({ kind: 'success', text: t('voiceStudio.settings.ttsConfigs.saved') });
        setEditing(null);
        load();
      } else {
        setToast({ kind: 'error', text: 'save failed' });
      }
    } catch (e: unknown) {
      setToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [editing, load, t]);

  const resetEditing = useCallback(async () => {
    if (!editing) return;
    const localizedName = getLocalizedSchema(editing.schema, locale).display_name;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(t('voiceStudio.settings.ttsConfigs.resetConfirm', { name: localizedName }))
    ) {
      return;
    }
    setResetting(true);
    try {
      const res = await configApi.reset(editing.name);
      if (res.success) {
        setToast({ kind: 'success', text: t('voiceStudio.settings.ttsConfigs.resetDone') });
        setEditing(null);
        load();
      }
    } catch (e: unknown) {
      setToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setResetting(false);
    }
  }, [editing, load, locale, t]);

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Settings size={14} className="text-[var(--text-muted)]" />
        <h2 className="text-[0.9375rem] font-semibold">{t('voiceStudio.settings.ttsConfigs.title')}</h2>
        <span className="ml-1 text-[0.6875rem] text-[var(--text-muted)]">
          ({configs.length})
        </span>
      </div>
      <p className="text-[0.6875rem] text-[var(--text-muted)]">
        {t('voiceStudio.settings.ttsConfigs.hint')}
      </p>

      {error && (
        <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}
      {toast && (
        <div className={`px-3 py-2 rounded-lg text-[0.8125rem] ${
          toast.kind === 'success'
            ? 'bg-[rgba(34,197,94,0.1)] text-[var(--success-color)] border border-[rgba(34,197,94,0.2)]'
            : 'bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]'
        }`}>
          {toast.text}
        </div>
      )}

      {loading && configs.length === 0 ? (
        <p className="text-[0.875rem] text-[var(--text-muted)] py-6 text-center inline-flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          {t('voiceStudio.settings.ttsConfigs.loading')}
        </p>
      ) : configs.length === 0 ? (
        <p className="text-[0.875rem] text-[var(--text-muted)] py-6 text-center">
          {t('voiceStudio.settings.ttsConfigs.empty')}
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {configs.map((c) => (
            <ConfigCard key={c.schema.name} item={c} onClick={() => openEditor(c.schema.name)} locale={locale} t={t} />
          ))}
        </div>
      )}

      {editing && (
        <ConfigEditorModal
          item={{ name: editing.name, schema: editing.schema, values: editing.values }}
          locale={locale}
          saving={saving}
          resetting={resetting}
          onChangeField={updateField}
          onSave={saveEditing}
          onReset={resetEditing}
          onClose={closeEditor}
          t={t}
        />
      )}
    </section>
  );
}

// ─── Card ──────────────────────────────────────────────────────────────

function ConfigCard({
  item,
  onClick,
  locale,
  t,
}: {
  item: ConfigItem;
  onClick: () => void;
  locale: 'ko' | 'en';
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const localized = getLocalizedSchema(item.schema, locale);
  const total = item.schema.fields.length;
  const configured = item.schema.fields.filter((f) => {
    const v = item.values?.[f.name];
    if (typeof v === 'string') return v.trim().length > 0;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'boolean') return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v === null || v === undefined) return false;
    return true;
  }).length;
  const enabled =
    item.schema.fields.some((f) => f.name === 'enabled') && item.values?.enabled === true;

  return (
    <button
      onClick={onClick}
      className={`text-left rounded-lg border p-3 cursor-pointer transition-colors ${
        enabled
          ? 'border-[rgba(34,197,94,0.35)] bg-[rgba(34,197,94,0.04)] hover:border-[var(--success-color)]'
          : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] hover:border-[var(--primary-color)]'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-[0.875rem] font-semibold text-[var(--text-primary)] truncate">
              {localized.display_name}
            </p>
            {enabled && (
              <span className="px-1.5 py-px rounded text-[0.6875rem] bg-[rgba(34,197,94,0.18)] text-[var(--success-color)] font-medium">
                {t('voiceStudio.settings.ttsConfigs.enabled')}
              </span>
            )}
          </div>
          {localized.description && (
            <p className="mt-0.5 text-[0.6875rem] text-[var(--text-muted)] truncate">
              {localized.description}
            </p>
          )}
          <p className="mt-1.5 text-[0.6875rem] text-[var(--text-muted)]">
            {t('voiceStudio.settings.ttsConfigs.fieldsConfigured', { n: configured, total })}
          </p>
        </div>
        <ChevronRight size={14} className="text-[var(--text-muted)] shrink-0" />
      </div>
    </button>
  );
}

// ─── Modal ─────────────────────────────────────────────────────────────

function ConfigEditorModal({
  item,
  locale,
  saving,
  resetting,
  onChangeField,
  onSave,
  onReset,
  onClose,
  t,
}: {
  item: { name: string; schema: ConfigSchema; values: Record<string, unknown> };
  locale: 'ko' | 'en';
  saving: boolean;
  resetting: boolean;
  onChangeField: (name: string, v: unknown) => void;
  onSave: () => void;
  onReset: () => void;
  onClose: () => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const localized = getLocalizedSchema(item.schema, locale);
  const groups: Record<string, ConfigField[]> = useMemo(() => {
    const out: Record<string, ConfigField[]> = {};
    item.schema.fields.forEach((f) => {
      const g = f.group || 'default';
      if (!out[g]) out[g] = [];
      out[g].push(f);
    });
    return out;
  }, [item.schema.fields]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] shrink-0">
          <div className="min-w-0">
            <h3 className="text-[0.9375rem] font-semibold truncate">{localized.display_name}</h3>
            {localized.description && (
              <p className="text-[0.6875rem] text-[var(--text-muted)] truncate">{localized.description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={saving || resetting}
            className="flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          {Object.entries(groups).map(([groupName, fields]) => (
            <div key={groupName} className="space-y-2.5">
              {groupName !== 'default' && (
                <p className="text-[0.75rem] font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
                  {getLocalizedGroup(groupName, item.schema, locale, DEFAULT_GROUP_LABELS)}
                </p>
              )}
              <div className="space-y-3">
                {fields.map((field) => {
                  const lf = getLocalizedField(field, item.schema, locale);
                  return (
                    <ConfigFieldInput
                      key={field.name}
                      field={field}
                      value={item.values[field.name]}
                      onChange={(v) => onChangeField(field.name, v)}
                      allValues={item.values}
                      allFields={item.schema.fields}
                      onChangeField={onChangeField}
                      localizedLabel={lf.label}
                      localizedDescription={lf.description}
                      localizedPlaceholder={lf.placeholder}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-color)] shrink-0">
          <button
            onClick={onReset}
            disabled={saving || resetting}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.8125rem] hover:text-[var(--danger-color)] hover:border-[var(--danger-color)] cursor-pointer transition-colors disabled:opacity-50"
          >
            {resetting ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
            {t('voiceStudio.settings.ttsConfigs.reset')}
          </button>
          <button
            onClick={onClose}
            disabled={saving || resetting}
            className="ml-auto px-3 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.8125rem] hover:text-[var(--text-primary)] cursor-pointer transition-colors disabled:opacity-50"
          >
            {t('voiceStudio.settings.ttsConfigs.cancel')}
          </button>
          <button
            onClick={onSave}
            disabled={saving || resetting}
            className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? t('voiceStudio.settings.ttsConfigs.saving') : t('voiceStudio.settings.ttsConfigs.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// (Type-only no-op import guard so unused imports don't trip the linter.)
void CheckCircle2;
