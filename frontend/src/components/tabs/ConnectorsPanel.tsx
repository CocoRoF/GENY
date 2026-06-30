'use client';

/**
 * ConnectorsPanel — enable + configure MCP ecosystem connectors from the Geny UI.
 *
 * Rendered as the "Connectors" virtual Settings category. Each connector
 * (GitHub, Notion, Composio, Slack, Postgres, Brave, custom HTTP) is a card:
 * enabling it makes its MCP tools available to agents automatically — gated
 * until its required fields are filled. Secure field values come back masked
 * ("••••xxxx"); the UI shows them masked and never resends an untouched secret.
 * Mirrors GoogleSettingsPanel's layout + design tokens.
 */

import { useCallback, useEffect, useState } from 'react';
import { connectorsApi, type Connector, type ConnectorField } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { toast } from 'sonner';
import { EntityCard } from '@/components/common/layout';
import {
  RefreshCw,
  CheckCircle2,
  Circle,
  ExternalLink,
  Boxes,
  Github,
  Database,
  Globe,
  MessageSquare,
  Search,
  Puzzle,
  FileText,
  Plug,
  type LucideIcon,
} from 'lucide-react';

const inputCls =
  'w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary-color)]';
const labelCls = 'block text-xs font-medium text-[var(--text-muted)] mb-1';
const btnCls =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 rounded-md px-3 py-2 text-sm font-medium border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50';
const primaryBtnCls =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 rounded-md px-3 py-2 text-sm font-medium bg-[var(--primary-color)] text-white hover:bg-[var(--primary-color-hover,var(--primary-color))] transition-colors disabled:opacity-50';

/** Map the backend's icon hint to a lucide glyph; generic fallback otherwise. */
const ICONS: Record<string, LucideIcon> = {
  github: Github,
  notion: FileText,
  composio: Puzzle,
  slack: MessageSquare,
  postgres: Database,
  database: Database,
  brave: Search,
  search: Search,
  globe: Globe,
  custom: Globe,
  custom_http: Globe,
  http: Globe,
};

function iconFor(connector: Connector): LucideIcon {
  return ICONS[connector.icon] || ICONS[connector.id] || Plug;
}

/** A connector value is a still-masked secret the user hasn't edited. */
function isMasked(v: string | undefined): boolean {
  return typeof v === 'string' && v.startsWith('••••');
}

export default function ConnectorsPanel() {
  const { t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [connectors, setConnectors] = useState<Connector[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await connectorsApi.list();
      setConnectors(res.connectors || []);
    } catch (e: any) {
      toast.error(e?.message || t('connectors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-5 w-full">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Boxes className="w-5 h-5 text-[var(--primary-color)]" />
        <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('connectors.title')}</h2>
        <button onClick={() => void load()} className={`${btnCls} ml-auto`} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('connectors.refresh')}
        </button>
      </div>

      <p className="text-sm text-[var(--text-secondary)]">{t('connectors.subtitle')}</p>
      <p className="text-xs text-[var(--text-muted)]">{t('connectors.intro')}</p>

      {loading && connectors.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{t('connectors.loading')}</p>
      ) : connectors.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{t('connectors.empty')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {connectors.map((c) => (
            <ConnectorCard key={c.id} connector={c} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectorCard({ connector, onChanged }: { connector: Connector; onChanged: () => void | Promise<void> }) {
  const { t } = useI18n();
  const Icon = iconFor(connector);

  const [enabled, setEnabled] = useState(connector.enabled);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false); // values prefilled?
  const [loadingValues, setLoadingValues] = useState(false);
  const [saving, setSaving] = useState(false);

  const active = enabled && connector.configured;

  // Lazily prefill field values the first time the configure area opens.
  const ensureValues = useCallback(async () => {
    if (loaded || loadingValues) return;
    setLoadingValues(true);
    try {
      const detail = await connectorsApi.get(connector.id);
      setValues(detail.values || {});
      setEnabled(detail.enabled);
      setLoaded(true);
    } catch (e: any) {
      toast.error(e?.message || t('connectors.loadFailed'));
    } finally {
      setLoadingValues(false);
    }
  }, [connector.id, loaded, loadingValues, t]);

  const setField = (name: string, v: string) => {
    setValues((prev) => ({ ...prev, [name]: v }));
  };

  const onSave = async () => {
    setSaving(true);
    try {
      // Drop fields the user left as a masked secret — resending the mask
      // would overwrite the stored value with literal "••••…".
      const out: Record<string, string> = {};
      for (const f of connector.fields) {
        const v = values[f.name];
        if (v === undefined) continue;
        if (f.secure && isMasked(v)) continue;
        out[f.name] = v;
      }
      await connectorsApi.update(connector.id, { enabled, values: out });
      toast.success(t('connectors.saved'));
      await onChanged();
    } catch (e: any) {
      toast.error(e?.message || t('connectors.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // Toggle enable inline (without opening configure) — persists immediately,
  // but only resends fields the user actually edited (none, here).
  const onToggleEnabled = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    try {
      await connectorsApi.update(connector.id, { enabled: next, values: {} });
      toast.success(t('connectors.saved'));
      await onChanged();
    } catch (e: any) {
      setEnabled(!next); // revert optimistic flip
      toast.error(e?.message || t('connectors.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <EntityCard
      icon={<Icon className="text-[var(--text-secondary)]" />}
      iconTone="neutral"
      title={connector.name}
      badges={[
        { label: connector.transport === 'stdio' ? 'stdio' : 'HTTP', tone: 'neutral' },
        {
          label: active
            ? t('connectors.active')
            : !connector.configured
              ? t('connectors.notConfigured')
              : t('connectors.inactive'),
          tone: active ? 'good' : 'neutral',
          icon: active ? CheckCircle2 : Circle,
        },
      ]}
      toggle={{
        checked: enabled,
        onChange: (v) => void onToggleEnabled(v),
        disabled: saving,
        label: t('connectors.enable'),
      }}
      expandable
      expandLabel={t('connectors.configure')}
      onExpandChange={(o) => {
        if (o) void ensureValues();
      }}
      renderExpanded={() => (
        <div className="flex flex-col gap-3">
          {loadingValues ? (
            <p className="text-sm text-[var(--text-muted)]">{t('connectors.loading')}</p>
          ) : connector.fields.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">{t('connectors.noFields')}</p>
          ) : (
            connector.fields.map((field: ConnectorField) => (
              <div key={field.name}>
                <label className={labelCls}>
                  {field.label}
                  {field.required && <span className="text-[var(--danger-color)] ml-0.5">*</span>}
                </label>
                <input
                  type={field.secure ? 'password' : 'text'}
                  className={inputCls}
                  value={values[field.name] ?? ''}
                  onChange={(e) => setField(field.name, e.target.value)}
                  placeholder={field.placeholder}
                  autoComplete="off"
                />
                {field.description && (
                  <p className="text-xs text-[var(--text-muted)] mt-1">{field.description}</p>
                )}
              </div>
            ))
          )}
          <div className="flex items-center gap-2 pt-1">
            <button onClick={onSave} className={primaryBtnCls} disabled={saving || loadingValues}>
              {saving ? t('connectors.saving') : t('connectors.save')}
            </button>
          </div>
        </div>
      )}
    >
      <p>{connector.description}</p>
      {connector.docs_url && (
        <a
          href={connector.docs_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-[var(--primary-color)] hover:underline mt-1"
        >
          <ExternalLink className="w-3 h-3" /> {t('connectors.docs')}
        </a>
      )}
      {connector.transport === 'stdio' && (
        <p className="text-xs text-[var(--text-muted)] mt-2">{t('connectors.stdioNote')}</p>
      )}
    </EntityCard>
  );
}
