/**
 * ClaudeCodeAuthModal — Phase G3.
 *
 * Click a Claude Code (CLI) card on Settings → LLM Backends and this
 * modal opens. It wraps the real ``claude auth login`` flow:
 *
 *   1. Auth-mode radio:
 *      A. Host mount (default) — show current ``claude auth status``
 *         output. If logged in via the host already, the modal is
 *         essentially read-only ("Max plan via gkfua00@gmail.com").
 *      B. In-modal login — POST start, then open the SSE stream and
 *         display every stdout/stderr line as it arrives. The user
 *         sees the device-code URL the CLI prints, clicks "Open URL"
 *         in a new tab, logs in, comes back — the modal auto-refreshes
 *         status when the subprocess exits 0.
 *      C. setup-token paste — accepts a long-lived subscription token
 *         and stores it in the Claude Code config (override slot).
 *      D. API key (Console) — Anthropic Console API key, same shape.
 *
 *   2. Test connection — runs a fast `claude --print --bare … ping`
 *      and surfaces the response or the stderr tail.
 *
 *   3. Sign out — `claude auth logout`.
 *
 * The live console pane (toggle) shows the trailing ~40 lines of the
 * latest auth subprocess.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, RefreshCw, Loader2, LogIn, LogOut, ExternalLink, CheckCircle2,
  AlertCircle, Terminal, Eye, EyeOff, Copy, Check,
} from 'lucide-react';

import {
  llmBackendsApi,
  type AuthJobEvent,
  type AuthLoginStartResponse,
  type ClaudeCodeAuthStatus,
  type ProviderHealth,
  type TestConnectionResponse,
} from '@/lib/api';
import { configApi } from '@/lib/api';


type AuthMode = 'host_mount' | 'in_modal_login' | 'setup_token' | 'api_key';


function StatusBadge({ status }: { status: ClaudeCodeAuthStatus | null }) {
  if (!status) {
    return <span className="text-[var(--text-tertiary)] text-[0.8125rem]">Loading…</span>;
  }
  if (!status.logged_in) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-rose-500/30 bg-rose-500/15 text-rose-300 text-[0.7rem]">
        <AlertCircle className="w-3 h-3" /> Not authenticated
      </span>
    );
  }
  const sub = (status.subscription_type || '').toLowerCase();
  const label = sub
    ? `${sub.charAt(0).toUpperCase() + sub.slice(1)} plan`
    : (status.auth_method === 'console' ? 'Console (API)' : 'Logged in');
  const tone = sub === 'max' || sub === 'pro'
    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : 'bg-sky-500/15 text-sky-300 border-sky-500/30';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[0.7rem] ${tone}`}>
      <CheckCircle2 className="w-3 h-3" /> {label}
    </span>
  );
}


function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/\S+/g) || [];
  return Array.from(new Set(matches));
}


export default function ClaudeCodeAuthModal({
  onClose,
  onChange,
}: {
  onClose: () => void;
  /** Called whenever the modal materially mutates state — host
   *  panel refreshes its card. */
  onChange?: () => void;
}) {
  const [authMode, setAuthMode] = useState<AuthMode>('host_mount');
  const [status, setStatus] = useState<ClaudeCodeAuthStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  // Login job state
  const [job, setJob] = useState<AuthLoginStartResponse | null>(null);
  const [events, setEvents] = useState<AuthJobEvent[]>([]);
  const [jobRunning, setJobRunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // Test connection
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // setup_token + api_key edit state
  const [tokenInput, setTokenInput] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');

  // Live console toggle
  const [showConsole, setShowConsole] = useState(false);

  // ── Status fetch ────────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const s = await llmBackendsApi.claudeCodeStatus();
      setStatus(s);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // ── Login flow ──────────────────────────────────────────────────

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  useEffect(() => () => closeStream(), [closeStream]);

  const startLogin = useCallback(async (useConsole: boolean) => {
    closeStream();
    setEvents([]);
    setJobRunning(true);
    try {
      const j = await llmBackendsApi.claudeCodeStartLogin({ useConsole });
      setJob(j);
      const es = new EventSource(llmBackendsApi.authJobEventsUrl(j.job_id), { withCredentials: true });
      esRef.current = es;
      es.onmessage = (ev) => {
        try {
          const parsed: AuthJobEvent = JSON.parse(ev.data);
          setEvents((prev) => [...prev.slice(-200), parsed]);
          if (parsed.channel === 'exit') {
            setJobRunning(false);
            closeStream();
            refreshStatus();
            onChange?.();
          }
        } catch {
          /* ignore malformed */
        }
      };
      es.onerror = () => {
        setJobRunning(false);
      };
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
      setJobRunning(false);
    }
  }, [closeStream, refreshStatus, onChange]);

  const cancelLogin = useCallback(async () => {
    if (!job) return;
    try {
      await llmBackendsApi.cancelAuthJob(job.job_id);
    } catch {
      /* swallow */
    }
    closeStream();
    setJobRunning(false);
    refreshStatus();
  }, [job, closeStream, refreshStatus]);

  const logout = useCallback(async () => {
    if (!confirm('Sign out of Claude Code on the server? Subsequent sessions will fail until you log in again.')) return;
    try {
      await llmBackendsApi.claudeCodeLogout();
      onChange?.();
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    }
    refreshStatus();
  }, [refreshStatus, onChange]);

  // ── Test connection ────────────────────────────────────────────

  const runTest = useCallback(async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const r = await llmBackendsApi.claudeCodeTest();
      setTestResult(r);
    } catch (e) {
      setTestResult({
        ok: false,
        duration_ms: 0,
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTestLoading(false);
    }
  }, []);

  // ── setup-token / api-key save ─────────────────────────────────

  const saveToken = useCallback(async () => {
    if (!tokenInput.trim()) return;
    try {
      // The Claude Code config carries an ``api_key`` override slot
      // which gets injected as ANTHROPIC_API_KEY to the child CLI.
      // We reuse it for both the "setup token" path and the API key
      // path — server-side they're indistinguishable, the difference
      // is which one the user chose semantically.
      await configApi.update('cli_backend_claude_code', { api_key: tokenInput, enabled: true });
      setTokenInput('');
      onChange?.();
      refreshStatus();
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    }
  }, [tokenInput, onChange, refreshStatus]);

  const saveApiKey = useCallback(async () => {
    if (!apiKeyInput.trim()) return;
    try {
      await configApi.update('cli_backend_claude_code', { api_key: apiKeyInput, enabled: true });
      setApiKeyInput('');
      onChange?.();
      refreshStatus();
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    }
  }, [apiKeyInput, onChange, refreshStatus]);

  // ── Derived state ──────────────────────────────────────────────

  const liveText = useMemo(() => events.map((e) => `[${e.channel}] ${e.text}`).join('\n'), [events]);
  const urls = useMemo(() => extractUrls(liveText), [liveText]);

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-full max-w-[720px] mx-4 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center py-4 px-6 border-b border-[var(--border-color)]">
          <h3 className="text-[1rem] font-semibold inline-flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[var(--text-secondary)]" />
            Claude Code (CLI) — Authentication
          </h3>
          <button
            type="button"
            className="w-8 h-8 rounded-[var(--border-radius)] hover:bg-[var(--bg-hover)] text-[var(--text-muted)]"
            onClick={onClose}
          >
            <X size={16} className="m-auto" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
          {/* Status panel */}
          <section className="rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <StatusBadge status={status} />
                {status?.email && (
                  <span className="text-[0.75rem] text-[var(--text-secondary)]">{status.email}</span>
                )}
                {status?.org_name && (
                  <span className="text-[0.7rem] text-[var(--text-tertiary)]">· {status.org_name}</span>
                )}
              </div>
              <button
                type="button"
                onClick={refreshStatus}
                disabled={statusLoading}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[var(--border-color)] text-[0.75rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                {statusLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Refresh
              </button>
            </div>
            {statusError && (
              <div className="mt-2 text-[0.75rem] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-2">
                {statusError}
              </div>
            )}
            {status && status.logged_in && status.auth_method && (
              <div className="mt-2 text-[0.7rem] text-[var(--text-tertiary)]">
                auth_method: {status.auth_method}
              </div>
            )}
          </section>

          {/* Auth mode radios */}
          <section>
            <h4 className="text-[0.875rem] font-semibold mb-2">Authentication mode</h4>
            <div className="flex flex-col gap-2">
              {([
                ['host_mount', 'Host mount (default)', 'Re-use ~/.claude on the host. Pro/Max subscription billing.'],
                ['in_modal_login', 'Sign in here', 'Run `claude auth login` in the backend container; pick up the device-code URL below.'],
                ['setup_token', 'Setup token (paste)', 'Long-lived subscription token from `claude setup-token`.'],
                ['api_key', 'API key (Console)', 'Anthropic Console API key — billed per token.'],
              ] as const).map(([id, label, blurb]) => (
                <label key={id} className="flex items-start gap-2 cursor-pointer p-2 rounded hover:bg-[var(--bg-hover)]">
                  <input
                    type="radio"
                    name="auth-mode"
                    value={id}
                    checked={authMode === id}
                    onChange={() => setAuthMode(id)}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-[0.875rem] font-medium">{label}</div>
                    <div className="text-[0.75rem] text-[var(--text-tertiary)]">{blurb}</div>
                  </div>
                </label>
              ))}
            </div>
          </section>

          {/* Mode-specific controls */}
          {authMode === 'host_mount' && (
            <section className="text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed">
              {status?.logged_in
                ? <>The backend container is reading the host's <code>~/.claude/.credentials.json</code> directly. Sessions billing against your <strong>{status.subscription_type || 'subscription'}</strong> plan. Nothing else to do here.</>
                : <>The host's <code>~/.claude</code> directory is mounted RW, but no credential was found. Run <code className="bg-[var(--bg-tertiary)] px-1 rounded">claude auth login</code> on the host machine — or use <em>"Sign in here"</em> above to do it inside the container.</>}
            </section>
          )}

          {authMode === 'in_modal_login' && (
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => startLogin(false)}
                  disabled={jobRunning}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] hover:bg-[var(--primary-color-hover)] disabled:opacity-50"
                >
                  {jobRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                  Start subscription login
                </button>
                <button
                  type="button"
                  onClick={() => startLogin(true)}
                  disabled={jobRunning}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                >
                  Console (API billing) instead
                </button>
                {jobRunning && (
                  <button
                    type="button"
                    onClick={cancelLogin}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-500/30 text-rose-300 text-[0.75rem] hover:bg-rose-500/10"
                  >
                    Cancel
                  </button>
                )}
              </div>

              {urls.length > 0 && (
                <div className="rounded border border-sky-500/30 bg-sky-500/10 p-3 flex flex-col gap-2">
                  <div className="text-[0.75rem] text-sky-300 uppercase tracking-wide">Open this URL in your browser:</div>
                  {urls.map((u) => (
                    <UrlPanel key={u} url={u} />
                  ))}
                </div>
              )}

              {job && (
                <div className="text-[0.7rem] text-[var(--text-tertiary)]">
                  job: {job.job_id} · started {new Date().toLocaleTimeString()}
                </div>
              )}
            </section>
          )}

          {authMode === 'setup_token' && (
            <section className="flex flex-col gap-2">
              <p className="text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed">
                Generate a long-lived token on a machine where you've signed in:
                <code className="block bg-[var(--bg-tertiary)] mt-1 p-2 rounded text-[0.75rem]">claude setup-token</code>
                Then paste the resulting token here. We store it in the Claude Code config's <code>api_key</code> override slot.
              </p>
              <div className="flex gap-2">
                <input
                  type={tokenVisible ? 'text' : 'password'}
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="sk-ant-…"
                  className="flex-1 px-3 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[0.8125rem]"
                />
                <button
                  type="button"
                  className="px-2 rounded border border-[var(--border-color)] hover:bg-[var(--bg-hover)]"
                  onClick={() => setTokenVisible((v) => !v)}
                >
                  {tokenVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  type="button"
                  onClick={saveToken}
                  disabled={!tokenInput.trim()}
                  className="px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </section>
          )}

          {authMode === 'api_key' && (
            <section className="flex flex-col gap-2">
              <p className="text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed">
                Anthropic Console API key. Per-token billing — no subscription quota involved.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="sk-ant-…"
                  className="flex-1 px-3 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[0.8125rem]"
                />
                <button
                  type="button"
                  onClick={saveApiKey}
                  disabled={!apiKeyInput.trim()}
                  className="px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </section>
          )}

          {/* Live console */}
          {(events.length > 0 || showConsole) && (
            <section>
              <button
                type="button"
                onClick={() => setShowConsole((v) => !v)}
                className="inline-flex items-center gap-1 text-[0.75rem] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] mb-1"
              >
                <Terminal className="w-3 h-3" />
                {showConsole ? 'Hide live console' : 'Show live console'}
              </button>
              {showConsole && (
                <pre className="rounded border border-[var(--border-color)] bg-black/40 text-[0.72rem] leading-relaxed p-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap text-[var(--text-secondary)]">
                  {liveText || '(no output yet)'}
                </pre>
              )}
            </section>
          )}

          {/* Test + Logout */}
          <section className="flex items-center gap-2 pt-2 border-t border-[var(--border-color)]">
            <button
              type="button"
              onClick={runTest}
              disabled={testLoading}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              {testLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              Test connection
            </button>
            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-rose-500/30 text-rose-300 text-[0.8125rem] hover:bg-rose-500/10"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
            {testResult && (
              <span className={`text-[0.75rem] ${testResult.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                {testResult.ok ? `✓ ${testResult.duration_ms}ms` : `✗ ${testResult.detail}`}
              </span>
            )}
          </section>

          {testResult && (testResult.raw_stderr_tail || testResult.raw_stdout_tail) && (
            <pre className="text-[0.7rem] text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] rounded p-2 whitespace-pre-wrap max-h-[120px] overflow-y-auto">
              {testResult.raw_stderr_tail || testResult.raw_stdout_tail}
            </pre>
          )}
        </div>

        <div className="flex justify-end px-6 py-3 border-t border-[var(--border-color)]">
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


function UrlPanel({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [url]);

  return (
    <div className="flex items-center gap-2">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-[0.8125rem] text-sky-300 hover:underline break-all flex-1"
      >
        {url}
        <ExternalLink className="w-3 h-3 shrink-0" />
      </a>
      <button
        type="button"
        onClick={copy}
        className="px-2 py-1 rounded border border-sky-500/30 text-[0.7rem] text-sky-300 hover:bg-sky-500/10 inline-flex items-center gap-1"
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
