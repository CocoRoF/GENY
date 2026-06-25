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
import { RefreshCw, ShieldCheck, AlertTriangle, CheckCircle2, XCircle, Cloud } from 'lucide-react';

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
const btnCls =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50';
const primaryBtnCls =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium bg-[var(--primary-color)] text-white hover:bg-[var(--primary-color-hover,var(--primary-color))] transition-colors disabled:opacity-50';

export default function GaptSettingsPanel() {
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
      flash('err', e?.message || 'GAPT 설정을 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

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
      flash('ok', warnings.length ? `검증됨 (경고 ${warnings.length}): ${warnings[0]}` : '토큰 검증 성공 — 계정/존/터널을 선택하세요');
    } catch (e: any) {
      flash('err', e?.message || '토큰 검증 실패');
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
      flash('ok', 'Cloudflare 설정 저장됨');
      await loadAll();
    } catch (e: any) {
      flash('err', e?.message || '저장 실패');
    } finally {
      setSaving(false);
    }
  };

  const onEnsureWildcard = async () => {
    try {
      await gaptSettingsApi.ensureWildcard({});
      flash('ok', '와일드카드 인그레스 적용됨');
      await loadAll();
    } catch (e: any) {
      flash('err', e?.message || '와일드카드 적용 실패');
    }
  };

  const onEnableTls = async () => {
    try {
      await gaptSettingsApi.enableTotalTls({});
      flash('ok', 'Total TLS 활성화 요청됨');
    } catch (e: any) {
      flash('err', e?.message || 'Total TLS 활성화 실패');
    }
  };

  const tunnelOptions = accountId ? tunnelsByAccount[accountId] || [] : [];

  return (
    <div className="flex flex-col gap-5 w-full">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Cloud className="w-5 h-5 text-[var(--primary-color)]" />
        <h2 className="text-base font-semibold text-[var(--text-primary)]">GAPT — Cloudflare & 라우팅</h2>
        <button onClick={() => void loadAll()} className={`${btnCls} ml-auto`} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 새로고침
        </button>
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
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">라우팅 준비 상태</h3>
          {tunnelMode && (
            <span className="ml-auto text-xs px-2 py-0.5 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)]">
              tunnel: {tunnelMode}
            </span>
          )}
        </div>
        {diag ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <Light ok={diag.provider_configured} label="Provider 구성됨" />
            <Light ok={diag.dns_resolves} label="DNS 해석" />
            <Light ok={diag.caddy_admin_reachable} label="Caddy admin 도달" />
            <Light ok={diag.caddy_has_wildcard_server} label="Caddy 와일드카드 서버" />
            <Light ok={diag.tunnel_has_wildcard} label="터널 와일드카드 인그레스" />
            <Light ok={diag.e2e_reachable} label="E2E 도달" />
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">{loading ? '불러오는 중…' : '진단 정보 없음'}</p>
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
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Cloudflare 설정</h3>
          <span className={`text-xs px-2 py-0.5 rounded-md border ${configured ? 'border-emerald-500/30 text-emerald-300' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}>
            {configured ? '구성됨' : '미구성'}
          </span>
          {verifiedAt && <span className="ml-auto text-xs text-[var(--text-muted)]">verified: {new Date(verifiedAt).toLocaleString()}</span>}
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls}>API 토큰 {configured && <span className="text-[var(--text-muted)]">(비워두면 기존 유지)</span>}</label>
            <div className="flex gap-2">
              <input
                type="password"
                className={inputCls}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={configured ? '●●●●●●●● (설정됨)' : 'Cloudflare API 토큰'}
                autoComplete="off"
              />
              <button onClick={onVerify} className={btnCls} disabled={verifying}>
                <RefreshCw className={`w-3.5 h-3.5 ${verifying ? 'animate-spin' : ''}`} /> 검증
              </button>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1">검증하면 계정/존/터널 목록을 불러와 아래 드롭다운을 채웁니다.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Account</label>
              {accounts.length ? (
                <select className={inputCls} value={accountId} onChange={(e) => { setAccountId(e.target.value); setTunnelId(''); }}>
                  <option value="">선택…</option>
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
              <label className={labelCls}>Zone</label>
              {zones.length ? (
                <select className={inputCls} value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                  <option value="">선택…</option>
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
              <label className={labelCls}>Tunnel</label>
              {tunnelOptions.length ? (
                <select className={inputCls} value={tunnelId} onChange={(e) => setTunnelId(e.target.value)}>
                  <option value="">선택…</option>
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
              <label className={labelCls}>Preview domain</label>
              <input className={inputCls} value={previewDomain} onChange={(e) => setPreviewDomain(e.target.value)} placeholder="gapt.example.com" />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <label className={labelCls}>Upstream</label>
              <input className={inputCls} value={upstream} onChange={(e) => setUpstream(e.target.value)} placeholder="http://localhost:38080" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button onClick={onSave} className={primaryBtnCls} disabled={saving}>
              {saving ? '저장 중…' : '저장'}
            </button>
            <button onClick={onEnsureWildcard} className={btnCls}>와일드카드 인그레스 적용</button>
            <button onClick={onEnableTls} className={btnCls}>Total TLS 활성화</button>
          </div>
        </div>
      </section>
    </div>
  );
}
