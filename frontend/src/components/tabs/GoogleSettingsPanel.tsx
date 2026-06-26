'use client';

/**
 * GoogleSettingsPanel — connect a Google Workspace account from the Geny UI.
 *
 * Rendered as the "Google" virtual Settings category. The operator stores a
 * "Desktop / TV & Limited Input devices" OAuth client (id + secret), then runs
 * the OAuth Device Flow entirely in-browser: Connect → show a short user_code +
 * verification_url → poll until the backend reports the token exchange landed.
 * Once connected, the Gmail / Calendar / Drive / Tasks tools become available
 * to agents automatically. Mirrors GaptSettingsPanel's layout + design tokens.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { googleApi, type GoogleConnectResponse } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { toast } from 'sonner';
import { RefreshCw, CheckCircle2, XCircle, ExternalLink, Mail } from 'lucide-react';

const inputCls =
  'w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--primary-color)]';
const labelCls = 'block text-xs font-medium text-[var(--text-muted)] mb-1';
const btnCls =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50';
const primaryBtnCls =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium bg-[var(--primary-color)] text-white hover:bg-[var(--primary-color-hover,var(--primary-color))] transition-colors disabled:opacity-50';

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

  // Device flow.
  const [device, setDevice] = useState<GoogleConnectResponse | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Poll timers — cleared on cancel / unmount / terminal state.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    if (expiryTimer.current) {
      clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
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

  // Tear down timers on unmount.
  useEffect(() => () => clearTimers(), [clearTimers]);

  const stopPolling = useCallback(() => {
    clearTimers();
    setPolling(false);
    setDevice(null);
  }, [clearTimers]);

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

  const startPolling = useCallback(
    (dev: GoogleConnectResponse) => {
      clearTimers();
      setPolling(true);
      const intervalMs = Math.max(1, dev.interval || 5) * 1000;
      pollTimer.current = setInterval(async () => {
        try {
          const res = await googleApi.poll(dev.device_code);
          if (res.status === 'connected') {
            stopPolling();
            setConnected(true);
            toast.success(t('googleSettings.connectedToast'));
            void loadStatus();
          } else if (res.status === 'error') {
            stopPolling();
            toast.error(res.error || t('googleSettings.errorToast'));
          }
          // status === 'pending' → keep polling.
        } catch (e: any) {
          stopPolling();
          toast.error(e?.message || t('googleSettings.errorToast'));
        }
      }, intervalMs);

      const expiresMs = Math.max(1, dev.expires_in || 600) * 1000;
      expiryTimer.current = setTimeout(() => {
        stopPolling();
        toast.error(t('googleSettings.timeout'));
      }, expiresMs);
    },
    [clearTimers, stopPolling, loadStatus, t],
  );

  const onConnect = async () => {
    setConnecting(true);
    try {
      const dev = await googleApi.connect();
      setDevice(dev);
      startPolling(dev);
    } catch (e: any) {
      toast.error(e?.message || t('googleSettings.connectError'));
    } finally {
      setConnecting(false);
    }
  };

  const onCancel = () => {
    stopPolling();
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

      {/* Connect / device flow */}
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
        ) : polling && device ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-secondary)]">{t('googleSettings.deviceInstructions')}</p>
            <div className="flex flex-wrap items-center gap-3">
              <code className="text-2xl font-mono font-semibold tracking-[0.3em] text-[var(--text-primary)] bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-md px-4 py-2 select-all">
                {device.user_code}
              </code>
              <a
                href={device.verification_url}
                target="_blank"
                rel="noopener noreferrer"
                className={primaryBtnCls}
              >
                <ExternalLink className="w-3.5 h-3.5" /> {t('googleSettings.openVerification')}
              </a>
            </div>
            <p className="text-xs text-[var(--text-muted)] break-all">
              {t('googleSettings.verificationUrlLabel')}{' '}
              <a
                href={device.verification_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--primary-color)] hover:underline"
              >
                {device.verification_url}
              </a>
            </p>
            <div className="flex items-center gap-2 pt-1">
              <span className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> {t('googleSettings.waiting')}
              </span>
              <button onClick={onCancel} className={`${btnCls} ml-auto`}>
                {t('googleSettings.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <button onClick={onConnect} className={primaryBtnCls} disabled={connecting || !hasClient}>
              {connecting ? t('googleSettings.connecting') : t('googleSettings.connect')}
            </button>
            {!hasClient && <p className="text-xs text-[var(--text-muted)]">{t('googleSettings.connectNeedsClient')}</p>}
          </div>
        )}
      </section>

      <p className="text-xs text-[var(--text-muted)]">{t('googleSettings.toolsNote')}</p>
    </div>
  );
}
