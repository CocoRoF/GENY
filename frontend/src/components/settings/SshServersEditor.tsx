'use client';

/**
 * SshServersEditor — the bespoke list editor for the SSH Tool config.
 *
 * The generic Settings auto-form has no list-of-dicts widget, so the modal
 * splices this in for the `ssh` config's `servers` field. Each row is one
 * server (name/host/port/user/password/key…) with an inline "연결 테스트"
 * button (POST /api/ssh/test — dry-runs the draft without saving). Secrets are
 * masked with an eye toggle. Edits emit the whole array via `onChange`, which
 * the modal saves through the normal configApi.update path.
 */

import { useState } from 'react';
import { Plus, X, Eye, EyeOff, CheckCircle2, XCircle, Loader2, Server } from 'lucide-react';
import { sshApi, type SshServer, type SshTestResponse } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const inputCls =
  'w-full py-2 px-3 rounded-[var(--border-radius)] border border-[var(--border-color)] ' +
  'bg-[var(--bg-primary)] text-[var(--text-primary)] text-[0.8125rem] outline-none ' +
  'focus:border-[var(--accent-color,#7c5cff)] transition-colors';

function blankServer(): SshServer {
  return { name: '', host: '', port: 22, user: '', password: '', private_key: '', passphrase: '', description: '', strict_host_key: false };
}

interface TestState {
  testing: boolean;
  result?: SshTestResponse;
}

export default function SshServersEditor({
  value,
  onChange,
}: {
  value?: SshServer[];
  onChange: (v: SshServer[]) => void;
}) {
  const { t } = useI18n();
  const servers: SshServer[] = Array.isArray(value) ? value : [];
  const [tests, setTests] = useState<Record<number, TestState>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  const update = (i: number, patch: Partial<SshServer>) => {
    onChange(servers.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
    setTests((prev) => {
      const n = { ...prev };
      delete n[i]; // a changed row invalidates its last test result
      return n;
    });
  };
  const add = () => onChange([...servers, blankServer()]);
  const remove = (i: number) => {
    onChange(servers.filter((_, idx) => idx !== i));
    setTests({}); // indices shift — drop ephemeral results
  };
  const runTest = async (i: number) => {
    setTests((prev) => ({ ...prev, [i]: { testing: true } }));
    try {
      const res = await sshApi.testServer(servers[i]);
      setTests((prev) => ({ ...prev, [i]: { testing: false, result: res } }));
    } catch (e) {
      setTests((prev) => ({
        ...prev,
        [i]: { testing: false, result: { success: false, error: e instanceof Error ? e.message : String(e) } },
      }));
    }
  };

  const secretField = (
    i: number,
    key: 'password' | 'passphrase',
    label: string,
    placeholder?: string,
  ) => {
    const rk = `${i}-${key}`;
    const shown = !!reveal[rk];
    return (
      <label className="flex flex-col gap-1">
        <span className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{label}</span>
        <div className="relative">
          <input
            type={shown ? 'text' : 'password'}
            value={(servers[i][key] as string) || ''}
            placeholder={placeholder}
            onChange={(e) => update(i, { [key]: e.target.value } as Partial<SshServer>)}
            className={inputCls + ' pr-10'}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => setReveal((p) => ({ ...p, [rk]: !shown }))}
            className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-7 h-7 rounded-[var(--border-radius)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] border-none bg-transparent cursor-pointer"
            aria-label={shown ? t('settings.hide') : t('settings.show')}
          >
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </label>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {servers.length === 0 && (
        <div className="text-[0.8125rem] text-[var(--text-muted)] py-4 text-center border border-dashed border-[var(--border-color)] rounded-[var(--border-radius)]">
          {t('settings.ssh.empty')}
        </div>
      )}

      {servers.map((s, i) => {
        const ts = tests[i];
        return (
          <div
            key={i}
            className="border border-[var(--border-color)] rounded-[var(--border-radius)] p-3 flex flex-col gap-3 bg-[var(--bg-secondary)]"
          >
            <div className="flex items-center gap-2">
              <Server size={15} className="text-[var(--text-muted)] shrink-0" />
              <span className="text-[0.8125rem] font-semibold text-[var(--text-primary)] truncate">
                {s.name?.trim() || t('settings.ssh.untitled')}
              </span>
              <span className="text-[0.6875rem] text-[var(--text-muted)] tabular-nums truncate">
                {s.user && s.host ? `${s.user}@${s.host}:${s.port || 22}` : ''}
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="ml-auto flex items-center justify-center w-7 h-7 rounded-[var(--border-radius)] text-[var(--text-muted)] hover:text-[var(--danger-color,#e5484d)] hover:bg-[var(--bg-tertiary)] border-none bg-transparent cursor-pointer"
                aria-label={t('settings.ssh.remove')}
              >
                <X size={15} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <label className="flex flex-col gap-1">
                <span className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('settings.ssh.name')}</span>
                <input value={s.name || ''} placeholder="prod" onChange={(e) => update(i, { name: e.target.value })} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('settings.ssh.host')}</span>
                <input value={s.host || ''} placeholder="1.2.3.4" onChange={(e) => update(i, { host: e.target.value })} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('settings.ssh.user')}</span>
                <input value={s.user || ''} placeholder="root" onChange={(e) => update(i, { user: e.target.value })} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('settings.ssh.port')}</span>
                <input
                  type="number"
                  value={s.port ?? 22}
                  min={1}
                  max={65535}
                  onChange={(e) => update(i, { port: Number(e.target.value) || 22 })}
                  className={inputCls}
                />
              </label>
              {secretField(i, 'password', t('settings.ssh.password'), t('settings.ssh.passwordHint'))}
              <label className="flex flex-col gap-1">
                <span className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('settings.ssh.description')}</span>
                <input value={s.description || ''} placeholder={t('settings.ssh.descriptionHint')} onChange={(e) => update(i, { description: e.target.value })} className={inputCls} />
              </label>
            </div>

            {/* Optional private-key auth */}
            <details className="group">
              <summary className="text-[0.75rem] text-[var(--text-secondary)] cursor-pointer select-none list-none flex items-center gap-1 hover:text-[var(--text-primary)]">
                <span className="transition-transform group-open:rotate-90">▸</span>
                {t('settings.ssh.keyAuth')}
              </summary>
              <div className="flex flex-col gap-2.5 pt-2.5">
                <label className="flex flex-col gap-1">
                  <span className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('settings.ssh.privateKey')}</span>
                  <textarea
                    value={s.private_key || ''}
                    placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----'}
                    onChange={(e) => update(i, { private_key: e.target.value })}
                    rows={3}
                    className={inputCls + ' font-mono text-[0.6875rem] resize-y'}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                {secretField(i, 'passphrase', t('settings.ssh.passphrase'), t('settings.ssh.passphraseHint'))}
                <label className="flex items-center gap-2 text-[0.75rem] text-[var(--text-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!s.strict_host_key}
                    onChange={(e) => update(i, { strict_host_key: e.target.checked })}
                  />
                  {t('settings.ssh.strictHostKey')}
                </label>
              </div>
            </details>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => runTest(i)}
                disabled={ts?.testing || !s.host}
                className="inline-flex items-center gap-1.5 py-1.5 px-3 rounded-[var(--border-radius)] bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] text-[0.75rem] font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {ts?.testing ? <Loader2 size={14} className="animate-spin" /> : null}
                {ts?.testing ? t('settings.ssh.testing') : t('settings.ssh.test')}
              </button>
              {ts?.result && (
                ts.result.success ? (
                  <span className="inline-flex items-center gap-1.5 text-[0.75rem] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 size={14} /> {t('settings.ssh.testOk')}
                    {typeof ts.result.latency_ms === 'number' && (
                      <span className="opacity-70 tabular-nums">{ts.result.latency_ms.toFixed(0)}ms</span>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-start gap-1.5 text-[0.75rem] text-red-600 dark:text-red-400 min-w-0">
                    <XCircle size={14} className="mt-0.5 shrink-0" />
                    <span className="break-words">{ts.result.error || t('settings.ssh.testFail')}</span>
                  </span>
                )
              )}
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={add}
        className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-[var(--border-radius)] border border-dashed border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] text-[0.8125rem] font-medium cursor-pointer"
      >
        <Plus size={15} /> {t('settings.ssh.addServer')}
      </button>
    </div>
  );
}
