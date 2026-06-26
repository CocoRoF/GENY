'use client';

/**
 * GoogleSettingsPanel — connect a Google Workspace account from the Geny UI.
 *
 * Rendered as the "Google" virtual Settings category. The operator stores a
 * "Web application" OAuth client (id + secret), registers the page-origin
 * redirect URI shown below in the client's "Authorized redirect URIs", then
 * runs the OAuth authorization-code flow in a popup: Connect → fetch the
 * consent URL → open it in a popup window → the backend's public
 * /api/google/callback page posts a `google-oauth` message back here on
 * completion. Once connected, the Gmail / Calendar / Drive / Tasks tools
 * become available to agents automatically. Mirrors GaptSettingsPanel's
 * layout + design tokens.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { googleApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { toast } from 'sonner';
import { RefreshCw, CheckCircle2, XCircle, ExternalLink, Mail, Copy, Check } from 'lucide-react';

const inputCls =
  'w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary-color)]';
const labelCls = 'block text-xs font-medium text-[var(--text-muted)] mb-1';
const btnCls =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50';
const primaryBtnCls =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium bg-[var(--primary-color)] text-white hover:bg-[var(--primary-color-hover,var(--primary-color))] transition-colors disabled:opacity-50';

/** Path the backend exposes as the public OAuth callback page. */
const CALLBACK_PATH = '/api/google/callback';
/** Clear `connecting` if no postMessage lands within this window (ms). */
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

export default function GoogleSettingsPanel() {
  const { t } = useI18n();

  const [loading, setLoading] = useState(true);
  const [hasClient, setHasClient] = useState(false);
  const [connected, setConnected] = useState(false);
  const [guideOpen, setGuideOpen] = useState(true);

  // Client (write-only) inputs.
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);

  // Auth-code popup flow.
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Page-origin redirect URI — read from window only after mount to avoid
  // SSR/hydration mismatch (this is a 'use client' component but it still
  // renders once on the server with no `window`).
  const [redirectUri, setRedirectUri] = useState('');

  // Fallback timer that clears `connecting` if the popup is closed / no
  // postMessage ever arrives.
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearConnectTimer = useCallback(() => {
    if (connectTimer.current) {
      clearTimeout(connectTimer.current);
      connectTimer.current = null;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await googleApi.status();
      setHasClient(!!s.has_client);
      setConnected(!!s.connected);
    } catch (e: any) {
      toast.error(e?.message || t('googleSettings.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Compute the redirect URI client-side after mount.
  useEffect(() => {
    setRedirectUri(window.location.origin + CALLBACK_PATH);
  }, []);

  // Listen for the popup's completion message (posted by the backend
  // /api/google/callback page via window.opener.postMessage).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; ok?: boolean; error?: string } | null;
      if (!data || data.type !== 'google-oauth') return;
      clearConnectTimer();
      setConnecting(false);
      if (data.ok) {
        toast.success(t('googleSettings.connectedToast'));
        void loadStatus();
      } else {
        toast.error(data.error || t('googleSettings.errorToast'));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [clearConnectTimer, loadStatus, t]);

  // Tear down the fallback timer on unmount.
  useEffect(() => () => clearConnectTimer(), [clearConnectTimer]);

  const onSaveClient = async () => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    setSaving(true);
    try {
      const res = await googleApi.setClient(clientId.trim(), clientSecret.trim());
      setHasClient(!!res.has_client);
      setClientSecret('');
      toast.success(t('googleSettings.clientSaved'));
    } catch (e: any) {
      toast.error(e?.message || t('googleSettings.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const onCopyRedirect = async () => {
    const uri = redirectUri || window.location.origin + CALLBACK_PATH;
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('googleSettings.copyError'));
    }
  };

  const onConnect = async () => {
    const uri = redirectUri || window.location.origin + CALLBACK_PATH;
    setConnecting(true);
    try {
      const res = await googleApi.authUrl(uri);
      const popup = window.open(res.auth_url, 'google-oauth', 'width=520,height=640');
      if (!popup) {
        setConnecting(false);
        toast.error(t('googleSettings.popupBlocked'));
        return;
      }
      // Fallback: if no postMessage lands (popup closed manually), stop the
      // spinner after a generous window.
      clearConnectTimer();
      connectTimer.current = setTimeout(() => setConnecting(false), CONNECT_TIMEOUT_MS);
    } catch (e: any) {
      setConnecting(false);
      toast.error(e?.message || t('googleSettings.connectError'));
    }
  };

  const onDisconnect = async () => {
    setDisconnecting(true);
    try {
      await googleApi.disconnect();
      toast.success(t('googleSettings.disconnectedToast'));
      await loadStatus();
    } catch (e: any) {
      toast.error(e?.message || t('googleSettings.disconnectError'));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 w-full">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Mail className="w-5 h-5 text-[var(--primary-color)]" />
        <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('googleSettings.title')}</h2>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-md border ${
            connected
              ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
              : 'border-[var(--border-color)] text-[var(--text-muted)]'
          }`}
        >
          {connected ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          {connected ? t('googleSettings.connected') : t('googleSettings.notConnected')}
        </span>
        <button onClick={() => void loadStatus()} className={btnCls} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('googleSettings.refresh')}
        </button>
      </div>

      <p className="text-sm text-[var(--text-secondary)]">{t('googleSettings.subtitle')}</p>

      {/* Setup guide — precise one-time steps to create the OAuth client.
          Open by default until a client is stored; collapsible afterwards. */}
      <details
        open={guideOpen}
        onToggle={(e) => setGuideOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4"
      >
        <summary className="text-sm font-semibold text-[var(--text-primary)] cursor-pointer select-none">
          {t('googleSettings.guideTitle')}
        </summary>
        <ol className="mt-3 flex flex-col gap-2 text-xs text-[var(--text-secondary)] list-decimal pl-5 leading-relaxed">
          <li>{t('googleSettings.guideStep1')}</li>
          <li>{t('googleSettings.guideStep2')}</li>
          <li>{t('googleSettings.guideStep3')}</li>
          <li className="text-[var(--text-primary)] font-medium">{t('googleSettings.guideStep4')}</li>
          <li>{t('googleSettings.guideStep5')}</li>
          <li>{t('googleSettings.guideStep6')}</li>
        </ol>
        <a
          href="https://console.cloud.google.com/apis/credentials"
          target="_blank"
          rel="noopener noreferrer"
          className={`${primaryBtnCls} mt-3`}
        >
          <ExternalLink className="w-3.5 h-3.5" /> {t('googleSettings.guideOpenConsole')}
        </a>
      </details>

      {/* OAuth client */}
      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('googleSettings.clientSection')}</h3>
          <span
            className={`text-xs px-2 py-0.5 rounded-md border ${
              hasClient ? 'border-emerald-500/30 text-emerald-300' : 'border-[var(--border-color)] text-[var(--text-muted)]'
            }`}
          >
            {hasClient ? t('googleSettings.clientSet') : t('googleSettings.clientUnset')}
          </span>
        </div>

        <p className="text-xs text-[var(--text-muted)] mb-3">{t('googleSettings.clientHelper')}</p>

        <div className="flex flex-col gap-3">
          <div>
            <label className={labelCls}>{t('googleSettings.clientId')}</label>
            <input
              type="password"
              className={inputCls}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={hasClient ? '●●●●●●●● (설정됨)' : 'xxxxxxxx.apps.googleusercontent.com'}
              autoComplete="off"
            />
          </div>
          <div>
            <label className={labelCls}>{t('googleSettings.clientSecret')}</label>
            <input
              type="password"
              className={inputCls}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={hasClient ? '●●●●●●●● (설정됨)' : 'GOCSPX-...'}
              autoComplete="off"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={onSaveClient}
              className={primaryBtnCls}
              disabled={saving || !clientId.trim() || !clientSecret.trim()}
            >
              {saving ? t('googleSettings.saving') : t('googleSettings.save')}
            </button>
          </div>
        </div>
      </section>

      {/* Connect / authorization-code popup flow */}
      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('googleSettings.connectSection')}</h3>
        </div>

        {connected ? (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-emerald-300">
              <CheckCircle2 className="w-4 h-4" /> {t('googleSettings.connectedNote')}
            </div>
            <button onClick={onDisconnect} className={`${btnCls} ml-auto`} disabled={disconnecting}>
              <XCircle className="w-3.5 h-3.5" /> {disconnecting ? t('googleSettings.disconnecting') : t('googleSettings.disconnect')}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Redirect URI — MUST be registered in the OAuth client's
                "Authorized redirect URIs". Shown prominently with copy. */}
            <div>
              <label className={labelCls}>{t('googleSettings.redirectUriLabel')}</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate text-xs font-mono text-[var(--text-primary)] bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-md px-3 py-2 select-all">
                  {redirectUri || '…'}
                </code>
                <button
                  type="button"
                  onClick={onCopyRedirect}
                  className={btnCls}
                  disabled={!redirectUri}
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? t('googleSettings.copied') : t('googleSettings.copy')}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-[var(--text-muted)]">{t('googleSettings.redirectUriNote')}</p>
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <button onClick={onConnect} className={primaryBtnCls} disabled={connecting || !hasClient}>
                {connecting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> {t('googleSettings.connecting')}
                  </>
                ) : (
                  <>
                    <ExternalLink className="w-3.5 h-3.5" /> {t('googleSettings.connect')}
                  </>
                )}
              </button>
              {!hasClient ? (
                <p className="text-xs text-[var(--text-muted)]">{t('googleSettings.connectNeedsClient')}</p>
              ) : (
                <p className="text-xs text-[var(--text-muted)]">{t('googleSettings.connectHelper')}</p>
              )}
            </div>
          </div>
        )}
      </section>

      <p className="text-xs text-[var(--text-muted)]">{t('googleSettings.toolsNote')}</p>
    </div>
  );
}
