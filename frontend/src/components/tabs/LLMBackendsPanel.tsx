/**
 * LLM Backends panel — Phase F2.
 *
 * Surfaces a per-provider health card under Settings so users can:
 *   1. See at a glance which of the 6 providers are usable right now.
 *   2. For API providers: confirm an API key is configured (Anthropic
 *      / OpenAI / Google paste the key into the API config section
 *      one panel up; the badge here reflects that).
 *   3. For Claude Code: choose between two auth modes.
 *        - "API Key"        →  paste ANTHROPIC_API_KEY (same as Anthropic)
 *        - "Subscription"   →  user runs `claude auth login` in a
 *                              terminal; this panel exposes a
 *                              "Re-check" button that calls the
 *                              recheck endpoint after they're done.
 *   4. For Copilot CLI: same shape — install `gh`, run `gh auth
 *      login`, install the copilot extension, then re-check.
 *
 * Once a backend turns green here, creating an Environment that uses
 * that provider (Stage 6 ``config['provider']``) starts routing
 * actual VTuber / Worker sessions through that backend.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2, RefreshCw, Terminal, Key, ExternalLink, Settings as SettingsIcon } from 'lucide-react';

import { llmBackendsApi, type ProviderHealth } from '@/lib/api';
import ClaudeCodeAuthModal from './ClaudeCodeAuthModal';
import CopilotAuthModal from './CopilotAuthModal';


function Badge({
  tone,
  children,
}: {
  tone: 'good' | 'warn' | 'bad' | 'info';
  children: React.ReactNode;
}) {
  const toneClass =
    tone === 'good'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
      : tone === 'warn'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : tone === 'bad'
      ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
      : 'bg-sky-500/15 text-sky-300 border-sky-500/30';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[0.7rem] ${toneClass}`}>
      {children}
    </span>
  );
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
  /** Click → open the per-provider settings modal. */
  onOpenSettings: (providerId: string) => void;
}) {
  const isCli = provider.kind === 'cli';
  const recheckTarget =
    provider.provider === 'claude_code_cli'
      ? 'claude_code_cli'
      : provider.provider === 'copilot_cli'
      ? 'copilot_cli'
      : null;
  const recheckActive = recheckLoading === recheckTarget;

  let badge: React.ReactNode;
  if (provider.available && provider.auth_ok) {
    badge = (
      <Badge tone="good">
        <CheckCircle2 className="w-3 h-3" />
        Ready
      </Badge>
    );
  } else if (provider.auth_ok === false) {
    badge = (
      <Badge tone="warn">
        <AlertCircle className="w-3 h-3" />
        Login required
      </Badge>
    );
  } else if (!provider.available) {
    badge = (
      <Badge tone="bad">
        <AlertCircle className="w-3 h-3" />
        Not configured
      </Badge>
    );
  } else {
    badge = <Badge tone="info">Idle</Badge>;
  }

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
      className="rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 flex flex-col gap-3 text-left cursor-pointer hover:bg-[var(--bg-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-color)]"
      aria-label={`Open settings for ${provider.label}`}
    >
      <div className="flex items-center justify-between gap-2 w-full">
        <div className="flex items-center gap-2">
          {isCli ? <Terminal className="w-4 h-4 text-[var(--text-secondary)]" /> : <Key className="w-4 h-4 text-[var(--text-secondary)]" />}
          <span className="font-medium">{provider.label}</span>
          <span className="text-[0.7rem] text-[var(--text-tertiary)]">{provider.provider}</span>
        </div>
        <div className="flex items-center gap-2">
          {badge}
          <SettingsIcon className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
        </div>
      </div>

      <div className="text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed">
        {provider.detail || '—'}
      </div>

      {provider.auth_method && (
        <div className="flex items-center gap-2 text-[0.7rem] text-[var(--text-tertiary)]">
          <span>auth:</span>
          <Badge tone="info">{provider.auth_method}</Badge>
          {provider.binary_version && <span>· {provider.binary_version}</span>}
        </div>
      )}

      {provider.install_help && (
        <div className="text-[0.75rem] text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] rounded p-2 leading-relaxed">
          {provider.install_help}
        </div>
      )}

      {recheckTarget && (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--border-color)] text-[0.75rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            onClick={(e) => { e.stopPropagation(); onRecheck(recheckTarget); }}
            disabled={recheckActive}
            aria-label={`Re-check ${provider.label}`}
          >
            {recheckActive ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Re-check
          </button>
          {provider.provider === 'claude_code_cli' && (
            <a
              href="https://docs.anthropic.com/claude/code"
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-[0.75rem] text-sky-400 hover:underline"
            >
              Docs <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}


export default function LLMBackendsPanel() {
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

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  const handleRecheck = useCallback(
    async (provider: string) => {
      setRecheckLoading(provider);
      try {
        const res =
          provider === 'claude_code_cli'
            ? await llmBackendsApi.recheckClaudeCode()
            : await llmBackendsApi.recheckCopilot();
        setProviders((prev) =>
          prev.map((p) => (p.provider === res.provider ? res : p)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRecheckLoading(null);
      }
    },
    [],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[1rem] font-semibold">LLM Backends</h3>
          <p className="text-[0.8125rem] text-[var(--text-secondary)] mt-1">
            Six providers map to the executor's ClientRegistry. API providers use the keys configured under
            "Claude API". CLI providers (Claude Code, Copilot) wrap a local binary — install + log in once,
            then this panel turns green and any Environment whose Stage 6 picks that provider will route
            actual VTuber / Worker sessions through it.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          onClick={fetchHealth}
          disabled={loading}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh all
        </button>
      </div>

      {error && (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 text-rose-300 text-[0.8125rem] p-3">
          {error}
        </div>
      )}

      {providers.length === 0 && loading && (
        <div className="text-[var(--text-tertiary)] text-[0.8125rem]">Loading backend status…</div>
      )}

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

      {openProvider === 'claude_code_cli' && (
        <ClaudeCodeAuthModal
          onClose={() => setOpenProvider(null)}
          onChange={() => fetchHealth()}
        />
      )}

      {openProvider === 'copilot_cli' && (
        <CopilotAuthModal
          onClose={() => setOpenProvider(null)}
          onChange={() => fetchHealth()}
        />
      )}

      {openProvider && openProvider !== 'claude_code_cli' && openProvider !== 'copilot_cli' && (
        <PlaceholderProviderModal
          providerId={openProvider}
          providerLabel={providers.find((p) => p.provider === openProvider)?.label || openProvider}
          onClose={() => setOpenProvider(null)}
        />
      )}
    </div>
  );
}


/** Stub modal for backends whose dedicated modal lands in a follow-up
 *  PR (G4 = Copilot, G5 = the four API backends). Until those ship,
 *  clicking those cards still feels responsive: the modal explains
 *  where to configure the backend today and links there. */
function PlaceholderProviderModal({
  providerId,
  providerLabel,
  onClose,
}: {
  providerId: string;
  providerLabel: string;
  onClose: () => void;
}) {
  const hint =
    providerId === 'anthropic' || providerId === 'openai' || providerId === 'google'
      ? `${providerLabel} API key paste + Test modal lands in Phase G5. Configure today under Settings → Claude API.`
      : providerId === 'vllm'
      ? "Set base_url under Settings → Claude API. vLLM doesn't need an API key."
      : 'No dedicated modal yet.';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-full max-w-[480px] mx-4 p-5 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[1rem] font-semibold">{providerLabel}</h3>
        <p className="text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed">{hint}</p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
