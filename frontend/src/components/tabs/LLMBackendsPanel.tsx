/**
 * LLM Backends panel — Phase H polish.
 *
 * Single edit surface for the 6 executor providers. Cards are clickable
 * tiles with a status badge + auth-method chip + dynamic detail line.
 * All static strings flow through ``useI18n``; the dynamic detail / install
 * help strings come from the backend as ``detail_code`` + ``detail_params``
 * which we render through the same i18n bundle (English ``detail`` string
 * is a fallback for codes the frontend doesn't yet recognise).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2, AlertCircle, Loader2, RefreshCw, Terminal, Key,
  ExternalLink, Settings as SettingsIcon, ArrowUpCircle, RotateCcw,
} from 'lucide-react';

import { llmBackendsApi, type ProviderHealth, type ClaudeCodeVersionStatus } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import ClaudeCodeAuthModal from './ClaudeCodeAuthModal';
import ApiBackendModal from './ApiBackendModal';
import LocalBackendModal, { type LocalProviderId } from './LocalBackendModal';
import { PROVIDERS } from '@/lib/modelCatalog';

const API_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'vllm']);
const LOCAL_PROVIDERS = new Set<string>(['ollama', 'lmstudio', 'custom']);


type BadgeTone = 'good' | 'warn' | 'bad' | 'info';


function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  const cls =
    tone === 'good' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : tone === 'warn' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
    : tone === 'bad' ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
    : 'bg-sky-500/15 text-sky-300 border-sky-500/30';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[0.7rem] font-medium ${cls}`}>
      {children}
    </span>
  );
}


function renderDetail(
  provider: ProviderHealth,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (provider.detail_code) {
    const key = `settings.llmBackends.detail.${provider.detail_code}`;
    const rendered = t(key, provider.detail_params ?? {});
    // ``t`` returns the key itself when missing — fall back to server English.
    if (rendered !== key) return rendered;
  }
  return provider.detail || '—';
}


function renderInstallHelp(
  provider: ProviderHealth,
  t: (key: string) => string,
): string | null {
  if (provider.install_help_code) {
    const key = `settings.llmBackends.installHelp.${provider.install_help_code}`;
    const rendered = t(key);
    if (rendered !== key) return rendered;
  }
  return provider.install_help || null;
}


function ProviderCard({
  provider,
  onRecheck,
  recheckLoading,
  onOpenSettings,
}: {
  provider: ProviderHealth;
  onRecheck: (id: string) => Promise<void>;
  recheckLoading: string | null;
  onOpenSettings: (providerId: string) => void;
}) {
  const { t } = useI18n();
  const isCli = provider.kind === 'cli';
  const recheckTarget =
    provider.provider === 'claude_code_cli' ? 'claude_code_cli'
    : null;
  const recheckActive = recheckLoading === recheckTarget;

  let badge: React.ReactNode;
  let leftBorder: string;
  if (provider.available && provider.auth_ok) {
    badge = (
      <Badge tone="good">
        <CheckCircle2 className="w-3 h-3" />
        {t('settings.llmBackends.badge.ready')}
      </Badge>
    );
    leftBorder = 'var(--success-color)';
  } else if (provider.auth_ok === false) {
    badge = (
      <Badge tone="warn">
        <AlertCircle className="w-3 h-3" />
        {t('settings.llmBackends.badge.loginRequired')}
      </Badge>
    );
    leftBorder = 'var(--warning-color)';
  } else if (!provider.available) {
    badge = (
      <Badge tone="bad">
        <AlertCircle className="w-3 h-3" />
        {t('settings.llmBackends.badge.notConfigured')}
      </Badge>
    );
    leftBorder = 'var(--text-muted)';
  } else {
    badge = <Badge tone="info">{t('settings.llmBackends.badge.idle')}</Badge>;
    leftBorder = 'var(--text-muted)';
  }

  const detail = renderDetail(provider, t);
  const installHelp = renderInstallHelp(provider, (k) => t(k));
  const authMethodKey = provider.auth_method
    ? `settings.llmBackends.authMethod.${provider.auth_method}`
    : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenSettings(provider.provider)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenSettings(provider.provider);
        }
      }}
      className="rounded-[var(--border-radius-lg)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 flex flex-col gap-3 text-left cursor-pointer transition-all hover:bg-[var(--bg-hover)] hover:border-[var(--primary-color)]/40 focus:outline-none focus:ring-2 focus:ring-[var(--primary-color)]/40"
      style={{ borderLeft: `3px solid ${leftBorder}` }}
      aria-label={t('settings.llmBackends.cardAriaLabel', { label: provider.label })}
    >
      {/* Title row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isCli
            ? <Terminal className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
            : <Key className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />}
          <span className="font-semibold text-[0.9375rem] truncate">{provider.label}</span>
          <span className="text-[0.7rem] text-[var(--text-tertiary)] font-mono">{provider.provider}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {badge}
          <SettingsIcon className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
        </div>
      </div>

      {/* Detail line */}
      <div className="text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed break-all">
        {detail}
      </div>

      {/* Auth-method chip + binary version */}
      {(authMethodKey || provider.binary_version) && (
        <div className="flex items-center gap-2 text-[0.7rem] text-[var(--text-tertiary)]">
          {authMethodKey && (
            <>
              <span>{t('settings.llmBackends.auth')}:</span>
              <Badge tone="info">{t(authMethodKey)}</Badge>
            </>
          )}
          {provider.binary_version && (
            <span className="font-mono">· {provider.binary_version}</span>
          )}
        </div>
      )}

      {/* Install help (only when present) */}
      {installHelp && (
        <div className="text-[0.75rem] text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] rounded p-2 leading-relaxed">
          {installHelp}
        </div>
      )}

      {/* CLI re-check + docs link */}
      {recheckTarget && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--border-color)] text-[0.75rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            onClick={(e) => { e.stopPropagation(); onRecheck(recheckTarget); }}
            disabled={recheckActive}
            aria-label={t('settings.llmBackends.reCheck')}
          >
            {recheckActive
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <RefreshCw className="w-3 h-3" />}
            {t('settings.llmBackends.reCheck')}
          </button>
          {provider.provider === 'claude_code_cli' && (
            <a
              href="https://docs.anthropic.com/claude/code"
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[0.75rem] text-sky-400 hover:underline"
            >
              {t('settings.llmBackends.docs')} <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}


export default function LLMBackendsPanel() {
  return <LLMBackendsPanelInner />;
}

// ── Claude Code CLI version manager (keep-latest + rollback) ─────────
function ClaudeCodeVersionCard() {
  const [st, setSt] = useState<ClaudeCodeVersionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'' | 'update' | 'rollback'>('');
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setSt(await llmBackendsApi.claudeCodeVersion());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const doUpdate = async () => {
    setBusy('update'); setErr(null);
    try { setSt(await llmBackendsApi.claudeCodeUpdate('latest')); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };
  const doRollback = async () => {
    setBusy('rollback'); setErr(null);
    try { setSt(await llmBackendsApi.claudeCodeRollback()); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const upToDate = st && st.current && st.latest && st.current === st.latest;

  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3.5 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Terminal className="w-4 h-4 text-[var(--text-secondary)] shrink-0" />
          <span className="text-[0.875rem] font-semibold">Claude Code CLI 버전</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {st && (
            <Badge tone={upToDate ? 'good' : st.update_available ? 'warn' : 'info'}>
              {loading ? '…' : st.current ? `v${st.current}` : '미설치'}
            </Badge>
          )}
          <button
            type="button"
            className="inline-flex items-center justify-center w-7 h-7 rounded border border-[var(--border-color)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            onClick={refresh}
            disabled={loading || !!busy}
            title="새로고침"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div className="text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed">
        {st?.current
          ? upToDate
            ? '최신 버전을 사용 중입니다.'
            : st.latest
              ? <>최신 버전 <span className="font-medium text-[var(--text-primary)]">v{st.latest}</span> 사용 가능합니다.</>
              : '최신 버전 정보를 확인할 수 없습니다.'
          : 'Claude Code CLI가 설치되어 있지 않습니다.'}
        {st?.pinned && (
          <span className="text-[var(--text-tertiary)]"> · 고정: {st.pinned === 'latest' ? '최신' : `v${st.pinned}`}</span>
        )}
      </div>

      {err && (
        <div className="text-[0.75rem] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-2 break-all">
          {err}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          onClick={doUpdate}
          disabled={!!busy || loading || !!upToDate}
        >
          {busy === 'update' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}
          최신으로 업데이트
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          onClick={doRollback}
          disabled={!!busy || loading || !st?.can_rollback}
          title={st?.previous ? `v${st.previous} 으로 롤백` : '롤백할 이전 버전이 없습니다'}
        >
          {busy === 'rollback' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
          롤백{st?.previous ? ` (v${st.previous})` : ''}
        </button>
      </div>
    </div>
  );
}

function LLMBackendsPanelInner() {
  const { t } = useI18n();
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [loading, setLoading] = useState(false);
  const [recheckLoading, setRecheckLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openProvider, setOpenProvider] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await llmBackendsApi.health();
      setProviders(res.providers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchHealth(); }, [fetchHealth]);

  const handleRecheck = useCallback(
    async (provider: string) => {
      // Only ``claude_code_cli`` has a per-provider recheck endpoint
      // today; API providers re-fetch the full health card instead.
      if (provider !== 'claude_code_cli') {
        await fetchHealth();
        return;
      }
      setRecheckLoading(provider);
      try {
        const res = await llmBackendsApi.recheckClaudeCode();
        setProviders((prev) =>
          prev.map((p) => (p.provider === res.provider ? res : p)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRecheckLoading(null);
      }
    },
    [fetchHealth],
  );

  const providerLabelById = useMemo(() => {
    const m: Record<string, string> = {};
    providers.forEach((p) => { m[p.provider] = p.label; });
    return m;
  }, [providers]);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-[1.0625rem] font-semibold">{t('settings.llmBackends.title')}</h3>
          <p className="text-[0.8125rem] text-[var(--text-secondary)] mt-1 leading-relaxed">
            {t('settings.llmBackends.description', {
              count: providers.length || PROVIDERS.length,
            })}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50 shrink-0"
          onClick={fetchHealth}
          disabled={loading}
        >
          {loading
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <RefreshCw className="w-3.5 h-3.5" />}
          {t('settings.llmBackends.refreshAll')}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 text-rose-300 text-[0.8125rem] p-3">
          {error}
        </div>
      )}

      {/* Loading */}
      {providers.length === 0 && loading && (
        <div className="text-[var(--text-tertiary)] text-[0.8125rem]">
          {t('settings.llmBackends.loading')}
        </div>
      )}

      {/* Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {providers.map((p) => (
          <ProviderCard
            key={p.provider}
            provider={p}
            onRecheck={handleRecheck}
            recheckLoading={recheckLoading}
            onOpenSettings={(id) => setOpenProvider(id)}
          />
        ))}
      </div>

      {/* Claude Code CLI version management */}
      <ClaudeCodeVersionCard />

      {/* Modals */}
      {openProvider === 'claude_code_cli' && (
        <ClaudeCodeAuthModal
          onClose={() => setOpenProvider(null)}
          onChange={() => fetchHealth()}
        />
      )}

      {openProvider && API_PROVIDERS.has(openProvider) && (
        <ApiBackendModal
          providerId={openProvider as 'anthropic' | 'openai' | 'google' | 'vllm'}
          providerLabel={providerLabelById[openProvider] || openProvider}
          onClose={() => setOpenProvider(null)}
          onChange={() => fetchHealth()}
        />
      )}

      {openProvider && LOCAL_PROVIDERS.has(openProvider) && (
        <LocalBackendModal
          providerId={openProvider as LocalProviderId}
          providerLabel={providerLabelById[openProvider] || openProvider}
          onClose={() => setOpenProvider(null)}
          onChange={() => fetchHealth()}
        />
      )}
    </div>
  );
}
