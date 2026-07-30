'use client';

/**
 * GaptSettingsPanel — manage a connected GAPT instance's settings from Geny.
 *
 * Rendered as the "GAPT" virtual Settings category (only when GAPT is running).
 * Proxies GAPT's own runtime-mutable provider settings via /api/gapt/settings/*:
 * primarily Cloudflare (token → verify → account/zone/tunnel selection → save),
 * plus a routing-readiness traffic-light (/diagnose) and cert controls. Boot-time
 * GAPT env settings (Caddy domains/ports) are not editable over the API.
 */

import { useCallback, useEffect, useState } from 'react';
import { gaptSettingsApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { RefreshCw, ShieldCheck, AlertTriangle, CheckCircle2, XCircle, Cloud } from 'lucide-react';
import { IconButton, ActionButton } from '@/components/common/layout';

type AnyObj = Record<string, any>;

function pick(o: AnyObj, ...keys: string[]): string {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
}

function Light({ ok, label }: { ok: boolean | null | undefined; label: string }) {
  const Icon = ok === true ? CheckCircle2 : ok === false ? XCircle : AlertTriangle;
  const color = ok === true ? 'text-emerald-400' : ok === false ? 'text-rose-400' : 'text-amber-400';
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className={`w-4 h-4 ${color}`} />
      <span className="text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary-color)]';
const labelCls = 'block text-xs font-medium text-[var(--text-muted)] mb-1';

export default function GaptSettingsPanel() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Cloudflare config (editable)
  const [configured, setConfigured] = useState(false);
  const [verifiedAt, setVerifiedAt] = useState<string>('');
  const [token, setToken] = useState(''); // write-only; blank = keep existing
  const [accountId, setAccountId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [tunnelId, setTunnelId] = useState('');
  const [previewDomain, setPreviewDomain] = useState('');
  const [upstream, setUpstream] = useState('');

  // Verify discovery (drives dropdowns)
  const [accounts, setAccounts] = useState<AnyObj[]>([]);
  const [zones, setZones] = useState<AnyObj[]>([]);
  const [tunnelsByAccount, setTunnelsByAccount] = useState<Record<string, AnyObj[]>>({});

  // Readiness + tunnel mode
  const [diag, setDiag] = useState<AnyObj | null>(null);
  const [tunnelMode, setTunnelMode] = useState<string>('');

  const flash = (tone: 'ok' | 'err', text: string) => {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 5000);
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const cf = await gaptSettingsApi.getCloudflare().catch(() => null);
      if (cf) {
        setConfigured(!!cf.configured);
        setVerifiedAt(cf.verified_at || '');
        const c = cf.config || {};
        setAccountId(pick(c, 'account_id'));
        setZoneId(pick(c, 'zone_id'));
        setTunnelId(pick(c, 'tunnel_id'));
        setPreviewDomain(pick(c, 'preview_domain'));
        setUpstream(pick(c, 'upstream'));
      }
      const [d, snap] = await Promise.all([
        gaptSettingsApi.diagnose().catch(() => null),
        gaptSettingsApi.tunnelSnapshot().catch(() => null),
      ]);
      if (d) setDiag(d);
      if (snap?.mode) setTunnelMode(snap.mode);
      else if (d?.tunnel_mode) setTunnelMode(d.tunnel_mode);
    } catch (e: any) {
      flash('err', e?.message || t('gaptSettings.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const onVerify = async () => {
    setVerifying(true);
    try {
      const res = await gaptSettingsApi.verifyCloudflare(token ? { api_token: token } : {});
      setAccounts(res.accounts || []);
      setZones(res.zones || []);
      setTunnelsByAccount(res.tunnels_by_account || {});
      const warnings: string[] = res.warnings || [];
      flash('ok', warnings.length ? t('gaptSettings.verifyWarning', { count: warnings.length, warning: warnings[0] }) : t('gaptSettings.verifySuccess'));
    } catch (e: any) {
      flash('err', e?.message || t('gaptSettings.verifyFailed'));
    } finally {
      setVerifying(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const body: { api_token?: string; config: AnyObj } = {
        config: {
          account_id: accountId || undefined,
          zone_id: zoneId || undefined,
          tunnel_id: tunnelId || undefined,
          preview_domain: previewDomain || undefined,
          upstream: upstream || undefined,
        },
      };
      if (token) body.api_token = token;
      await gaptSettingsApi.putCloudflare(body);
      setToken('');
      flash('ok', t('gaptSettings.cloudflareSaved'));
      await loadAll();
    } catch (e: any) {
      flash('err', e?.message || t('gaptSettings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const onEnsureWildcard = async () => {
    try {
      await gaptSettingsApi.ensureWildcard({});
      flash('ok', t('gaptSettings.wildcardApplied'));
      await loadAll();
    } catch (e: any) {
      flash('err', e?.message || t('gaptSettings.wildcardFailed'));
    }
  };

  const onEnableTls = async () => {
    try {
      await gaptSettingsApi.enableTotalTls({});
      flash('ok', t('gaptSettings.totalTlsRequested'));
    } catch (e: any) {
      flash('err', e?.message || t('gaptSettings.totalTlsFailed'));
    }
  };

  const tunnelOptions = accountId ? tunnelsByAccount[accountId] || [] : [];

  return (
    <div className="flex flex-col gap-5 w-full">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Cloud className="w-5 h-5 text-[var(--primary-color)] shrink-0" />
        <h2 className="text-base font-semibold text-[var(--text-primary)] min-w-0 truncate">{t('gaptSettings.title')}</h2>
        <IconButton
          icon={RefreshCw}
          title={t('gaptSettings.refresh')}
          spin={loading}
          onClick={() => void loadAll()}
          disabled={loading}
          className="ml-auto"
        />
      </div>

      {msg && (
        <div className={`rounded-md px-3 py-2 text-sm border ${msg.tone === 'ok' ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10' : 'border-rose-500/30 text-rose-300 bg-rose-500/10'}`}>
          {msg.text}
        </div>
      )}

      {/* Readiness traffic-light (/diagnose) */}
      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck className="w-4 h-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('gaptSettings.readinessTitle')}</h3>
          {tunnelMode && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)]">
              tunnel: {tunnelMode}
            </span>
          )}
        </div>
        {diag ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <Light ok={diag.provider_configured} label={t('gaptSettings.providerConfigured')} />
            <Light ok={diag.dns_resolves} label={t('gaptSettings.dnsResolves')} />
            <Light ok={diag.caddy_admin_reachable} label={t('gaptSettings.caddyAdminReachable')} />
            <Light ok={diag.caddy_has_wildcard_server} label={t('gaptSettings.caddyWildcardServer')} />
            <Light ok={diag.tunnel_has_wildcard} label={t('gaptSettings.tunnelWildcardIngress')} />
            <Light ok={diag.e2e_reachable} label={t('gaptSettings.e2eReachable')} />
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">{loading ? t('gaptSettings.loading') : t('gaptSettings.noDiagnostics')}</p>
        )}
        {Array.isArray(diag?.next_steps) && diag!.next_steps.length > 0 && (
          <ul className="mt-3 list-disc pl-5 text-xs text-[var(--text-secondary)] space-y-1">
            {diag!.next_steps.map((s: string, i: number) => <li key={i}>{s}</li>)}
          </ul>
        )}
      </section>

      {/* Cloudflare config */}
      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('gaptSettings.cloudflareSection')}</h3>
          <span className={`text-xs px-2 py-0.5 rounded-md border ${configured ? 'border-emerald-500/30 text-emerald-300' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}>
            {configured ? t('gaptSettings.configured') : t('gaptSettings.notConfigured')}
          </span>
          {verifiedAt && <span className="ml-auto text-xs text-[var(--text-muted)]">verified: {new Date(verifiedAt).toLocaleString()}</span>}
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls}>{t('gaptSettings.apiToken')} {configured && <span className="text-[var(--text-muted)]">{t('gaptSettings.keepExistingHint')}</span>}</label>
            <div className="flex items-stretch gap-2">
              <input
                type="password"
                className={`${inputCls} flex-1 min-w-0`}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={configured ? t('gaptSettings.tokenPlaceholderSet') : t('gaptSettings.tokenPlaceholder')}
                autoComplete="off"
              />
              <ActionButton icon={RefreshCw} spinIcon={verifying} onClick={onVerify} disabled={verifying}>
                {t('gaptSettings.verify')}
              </ActionButton>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1">{t('gaptSettings.verifyHelp')}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>{t('gaptSettings.account')}</label>
              {accounts.length ? (
                <select className={inputCls} value={accountId} onChange={(e) => { setAccountId(e.target.value); setTunnelId(''); }}>
                  <option value="">{t('gaptSettings.selectPlaceholder')}</option>
                  {accounts.map((a, i) => {
                    const id = pick(a, 'id', 'account_id'); const name = pick(a, 'name') || id;
                    return <option key={id || i} value={id}>{name}</option>;
                  })}
                </select>
              ) : (
                <input className={inputCls} value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="account id" />
              )}
            </div>
            <div>
              <label className={labelCls}>{t('gaptSettings.zone')}</label>
              {zones.length ? (
                <select className={inputCls} value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                  <option value="">{t('gaptSettings.selectPlaceholder')}</option>
                  {zones.map((z, i) => {
                    const id = pick(z, 'id', 'zone_id'); const name = pick(z, 'name') || id;
                    return <option key={id || i} value={id}>{name}</option>;
                  })}
                </select>
              ) : (
                <input className={inputCls} value={zoneId} onChange={(e) => setZoneId(e.target.value)} placeholder="zone id" />
              )}
            </div>
            <div>
              <label className={labelCls}>{t('gaptSettings.tunnel')}</label>
              {tunnelOptions.length ? (
                <select className={inputCls} value={tunnelId} onChange={(e) => setTunnelId(e.target.value)}>
                  <option value="">{t('gaptSettings.selectPlaceholder')}</option>
                  {tunnelOptions.map((tn, i) => {
                    const id = pick(tn, 'id', 'tunnel_id'); const name = pick(tn, 'name') || id;
                    return <option key={id || i} value={id}>{name}</option>;
                  })}
                </select>
              ) : (
                <input className={inputCls} value={tunnelId} onChange={(e) => setTunnelId(e.target.value)} placeholder="tunnel id" />
              )}
            </div>
            <div>
              <label className={labelCls}>{t('gaptSettings.previewDomain')}</label>
              <input className={inputCls} value={previewDomain} onChange={(e) => setPreviewDomain(e.target.value)} placeholder="gapt.example.com" />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className={labelCls}>{t('gaptSettings.upstream')}</label>
              <input className={inputCls} value={upstream} onChange={(e) => setUpstream(e.target.value)} placeholder="http://localhost:38080" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <ActionButton variant="primary" onClick={onSave} disabled={saving}>
              {saving ? t('gaptSettings.saving') : t('gaptSettings.save')}
            </ActionButton>
            <ActionButton onClick={onEnsureWildcard}>{t('gaptSettings.applyWildcard')}</ActionButton>
            <ActionButton onClick={onEnableTls}>{t('gaptSettings.enableTotalTls')}</ActionButton>
          </div>
        </div>
      </section>
    </div>
  );
}
