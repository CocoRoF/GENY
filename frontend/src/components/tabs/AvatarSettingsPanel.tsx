'use client';

/**
 * AvatarSettingsPanel — manage a connected geny-avatar instance from Geny.
 *
 * Rendered as the "Avatar" virtual Settings category (only when avatar is
 * running). The image-gen provider keys are Geny-owned (LLM/Media credentials,
 * auto-synced); this panel shows the avatar's LIVE key status, a one-click
 * re-sync from Geny, and direct edit of the avatar-only keys (fal/replicate).
 */

import { useCallback, useEffect, useState } from 'react';
import { avatarApi, syncApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { RefreshCw, Image as ImageIcon, CheckCircle2, XCircle } from 'lucide-react';
import { IconButton, ActionButton } from '@/components/common/layout';

type AnyObj = Record<string, any>;

export default function AvatarSettingsPanel() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [status, setStatus] = useState<{ configured: boolean; running: boolean; base_url: string } | null>(null);
  const [keys, setKeys] = useState<AnyObj[]>([]);

  const flash = (tone: 'ok' | 'err', text: string) => {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 6000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await avatarApi.status().catch(() => null);
      setStatus(s);
      if (s?.running) {
        const k = await avatarApi.getKeys().catch(() => null);
        // The avatar returns { configPath, keys: [{id,label,configured,inEffect,preview,...}] }
        setKeys(Array.isArray(k?.keys) ? k.keys : []);
      } else {
        setKeys([]);
      }
    } catch (e: any) {
      flash('err', e?.message || t('avatarSettings.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSync = async () => {
    setSyncing(true);
    try {
      const r = await syncApi.providerKeysNow();
      const av = Object.entries(r.results || {})
        .map(([k, v]) => (v && typeof v === 'object' && 'avatar' in v ? `${k.replace(/_API_KEY|_API_TOKEN|_KEY/g, '')}=${(v as AnyObj).avatar}` : null))
        .filter(Boolean);
      flash('ok', av.length ? t('avatarSettings.syncResult', { keys: av.join(', ') }) : t('avatarSettings.syncDone'));
      await load();
    } catch (e: any) {
      flash('err', e?.message || t('avatarSettings.syncFailed'));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 w-full">
      <div className="flex items-center gap-2">
        <ImageIcon className="w-5 h-5 text-[var(--primary-color)]" />
        <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('avatarSettings.title')}</h2>
        <div className="ml-auto flex items-center gap-2">
          <ActionButton icon={RefreshCw} spinIcon={syncing} onClick={onSync} disabled={syncing || !status?.running}>
            {t('avatarSettings.syncFromGeny')}
          </ActionButton>
          <IconButton
            icon={RefreshCw}
            title={t('avatarSettings.refresh')}
            spin={loading}
            onClick={() => void load()}
            disabled={loading}
          />
        </div>
      </div>

      {msg && (
        <div className={`rounded-md px-3 py-2 text-sm border ${msg.tone === 'ok' ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10' : 'border-rose-500/30 text-rose-300 bg-rose-500/10'}`}>
          {msg.text}
        </div>
      )}

      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('avatarSettings.connection')}</h3>
          <span className={`text-xs px-2 py-0.5 rounded-md border ${status?.running ? 'border-emerald-500/30 text-emerald-300' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}>
            {status?.running ? t('avatarSettings.connected') : status?.configured ? t('avatarSettings.configuredUnresponsive') : t('avatarSettings.notConfigured')}
          </span>
          {status?.base_url && <span className="ml-auto text-xs text-[var(--text-muted)] font-mono">{status.base_url}</span>}
        </div>
        <p className="text-xs text-[var(--text-secondary)]">
          {t('avatarSettings.descIntro')} <b>{t('avatarSettings.descLlmBackend')}</b>{t('avatarSettings.descMid')}
          <b>{t('avatarSettings.descImageGenKeys')}</b>{t('avatarSettings.descOutro')}
        </p>
      </section>

      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">{t('avatarSettings.keyStatus')}</h3>
        {loading ? (
          <p className="text-sm text-[var(--text-muted)]">{t('avatarSettings.loading')}</p>
        ) : keys.length ? (
          <div className="overflow-auto rounded-md border border-[var(--border-color)]">
            <table className="min-w-full text-sm">
              <thead className="bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                <tr>
                  <th className="text-left font-medium px-3 py-2 text-xs uppercase tracking-wide">{t('avatarSettings.colProvider')}</th>
                  <th className="text-left font-medium px-3 py-2 text-xs uppercase tracking-wide">{t('avatarSettings.colStatus')}</th>
                  <th className="text-left font-medium px-3 py-2 text-xs uppercase tracking-wide">{t('avatarSettings.colPreview')}</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k, i) => {
                  const set = !!(k.configured ?? k.inEffect ?? k.preview);
                  return (
                    <tr key={k.id || i} className="border-t border-[var(--border-color)]">
                      <td className="px-3 py-2 text-[var(--text-primary)]">{k.label || k.id}</td>
                      <td className="px-3 py-2">
                        {set ? <span className="inline-flex items-center gap-1 text-emerald-400 text-xs"><CheckCircle2 className="w-3.5 h-3.5" /> {t('avatarSettings.set')}</span>
                             : <span className="inline-flex items-center gap-1 text-[var(--text-muted)] text-xs"><XCircle className="w-3.5 h-3.5" /> {t('avatarSettings.none')}</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-[var(--text-muted)]">{k.preview || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">{status?.running ? t('avatarSettings.keysUnavailable') : t('avatarSettings.notConnected')}</p>
        )}
      </section>
    </div>
  );
}
