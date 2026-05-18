/**
 * ClaudeCodeAuthModal — Phase G3 / Phase H polish.
 *
 * Click a Claude Code (CLI) card on Settings → LLM Backends and this
 * modal opens. It wraps the real ``claude auth login`` flow:
 *
 *   1. Auth-mode radio:
 *      A. Host mount (default) — show current ``claude auth status``
 *         output. If logged in via the host already, the modal is
 *         essentially read-only.
 *      B. In-modal login — POST start, then open the SSE stream and
 *         display every stdout/stderr line as it arrives.
 *      C. setup-token paste — accepts a long-lived subscription token
 *         and stores it in the Claude Code config (override slot).
 *      D. API key (Console) — Anthropic Console API key, same shape.
 *
 *   2. Test connection — runs a fast `claude --print --bare … ping`.
 *
 *   3. Sign out — `claude auth logout`.
 *
 * All static strings flow through ``useI18n``.
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
  type TestConnectionResponse,
} from '@/lib/api';
import { configApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';


type AuthMode = 'host_mount' | 'in_modal_login' | 'setup_token' | 'api_key';

const AUTH_MODE_STORAGE_KEY = 'geny.claudeCodeAuthMode';
const VALID_AUTH_MODES: ReadonlyArray<AuthMode> = [
  'host_mount', 'in_modal_login', 'setup_token', 'api_key',
];


function readPersistedAuthMode(): AuthMode {
  if (typeof window === 'undefined') return 'host_mount';
  try {
    const raw = window.localStorage.getItem(AUTH_MODE_STORAGE_KEY);
    if (raw && (VALID_AUTH_MODES as readonly string[]).includes(raw)) {
      return raw as AuthMode;
    }
  } catch {
    /* private mode / quota — fall through */
  }
  return 'host_mount';
}


function persistAuthMode(mode: AuthMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUTH_MODE_STORAGE_KEY, mode);
  } catch {
    /* private mode / quota — best-effort */
  }
}


function StatusBadge({
  status,
  t,
}: {
  status: ClaudeCodeAuthStatus | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  if (!status) {
    return (
      <span className="text-[var(--text-tertiary)] text-[0.8125rem]">
        {t('settings.llmBackends.common.loading')}
      </span>
    );
  }
  if (!status.logged_in) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-rose-500/30 bg-rose-500/15 text-rose-300 text-[0.7rem]">
        <AlertCircle className="w-3 h-3" /> {t('settings.llmBackends.common.notAuthenticated')}
      </span>
    );
  }
  const sub = (status.subscription_type || '').toLowerCase();
  const label = sub
    ? t('settings.llmBackends.claudeCodeModal.plan', { name: sub.charAt(0).toUpperCase() + sub.slice(1) })
    : (status.auth_method === 'console'
        ? t('settings.llmBackends.claudeCodeModal.consoleAuth')
        : t('settings.llmBackends.claudeCodeModal.loggedIn'));
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
  onChange?: () => void;
}) {
  const { t } = useI18n();
  // Seed from localStorage at state-creation time so the modal opens
  // directly on the user's last-picked tab — no first-render flash to
  // host_mount before a useEffect catches up.
  const [authMode, setAuthMode] = useState<AuthMode>(() => readPersistedAuthMode());
  const [status, setStatus] = useState<ClaudeCodeAuthStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [job, setJob] = useState<AuthLoginStartResponse | null>(null);
  const [events, setEvents] = useState<AuthJobEvent[]>([]);
  const [jobRunning, setJobRunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const [tokenInput, setTokenInput] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');

  const [showConsole, setShowConsole] = useState(false);

  // OAuth code paste-back state
  const [authCodeInput, setAuthCodeInput] = useState('');
  const [authCodeSubmitting, setAuthCodeSubmitting] = useState(false);
  const [authCodeStatus, setAuthCodeStatus] = useState<
    { kind: 'ok' | 'err'; text: string } | null
  >(null);

  // ── Status ──────────────────────────────────────────────────────

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

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

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
          /* ignore */
        }
      };
      es.onerror = () => setJobRunning(false);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
      setJobRunning(false);
    }
  }, [closeStream, refreshStatus, onChange]);

  const cancelLogin = useCallback(async () => {
    if (!job) return;
    try { await llmBackendsApi.cancelAuthJob(job.job_id); } catch { /* swallow */ }
    closeStream();
    setJobRunning(false);
    refreshStatus();
  }, [job, closeStream, refreshStatus]);

  const submitAuthCode = useCallback(async () => {
    if (!job || !authCodeInput.trim()) return;
    setAuthCodeSubmitting(true);
    setAuthCodeStatus(null);
    try {
      await llmBackendsApi.submitAuthJobInput(job.job_id, authCodeInput.trim());
      setAuthCodeStatus({
        kind: 'ok',
        text: t('settings.llmBackends.claudeCodeModal.authCodeSubmitted'),
      });
      setAuthCodeInput('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAuthCodeStatus({
        kind: 'err',
        text: t('settings.llmBackends.claudeCodeModal.authCodeError', { error: msg }),
      });
    } finally {
      setAuthCodeSubmitting(false);
    }
  }, [job, authCodeInput, t]);

  // Reset code-input state whenever a new job starts.
  useEffect(() => {
    setAuthCodeInput('');
    setAuthCodeStatus(null);
  }, [job?.job_id]);

  // Persist the user's last-picked auth mode so the modal opens on
  // the same tab next time.
  useEffect(() => {
    persistAuthMode(authMode);
  }, [authMode]);

  const logout = useCallback(async () => {
    if (!confirm(t('settings.llmBackends.claudeCodeModal.signOutConfirm'))) return;
    try {
      await llmBackendsApi.claudeCodeLogout();
      onChange?.();
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    }
    refreshStatus();
  }, [refreshStatus, onChange, t]);

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

  // ── Token / API key save ───────────────────────────────────────

  const saveToken = useCallback(async () => {
    if (!tokenInput.trim()) return;
    try {
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

  // ── Derived ────────────────────────────────────────────────────

  const liveText = useMemo(() => events.map((e) => `[${e.channel}] ${e.text}`).join('\n'), [events]);
  const urls = useMemo(() => extractUrls(liveText), [liveText]);

  const modeBlurbs: ReadonlyArray<readonly [AuthMode, string, string]> = useMemo(() => ([
    ['host_mount',
      t('settings.llmBackends.claudeCodeModal.modes.hostMountLabel'),
      t('settings.llmBackends.claudeCodeModal.modes.hostMountBlurb')] as const,
    ['in_modal_login',
      t('settings.llmBackends.claudeCodeModal.modes.inModalLoginLabel'),
      t('settings.llmBackends.claudeCodeModal.modes.inModalLoginBlurb')] as const,
    ['setup_token',
      t('settings.llmBackends.claudeCodeModal.modes.setupTokenLabel'),
      t('settings.llmBackends.claudeCodeModal.modes.setupTokenBlurb')] as const,
    ['api_key',
      t('settings.llmBackends.claudeCodeModal.modes.apiKeyLabel'),
      t('settings.llmBackends.claudeCodeModal.modes.apiKeyBlurb')] as const,
  ]), [t]);

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
            {t('settings.llmBackends.claudeCodeModal.title')}
          </h3>
          <button
            type="button"
            className="w-8 h-8 rounded-[var(--border-radius)] hover:bg-[var(--bg-hover)] text-[var(--text-muted)]"
            onClick={onClose}
            aria-label={t('settings.llmBackends.common.close')}
          >
            <X size={16} className="m-auto" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
          {/* Status panel */}
          <section className="rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <StatusBadge status={status} t={t} />
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
                {t('settings.llmBackends.common.refresh')}
              </button>
            </div>
            {statusError && (
              <div className="mt-2 text-[0.75rem] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-2">
                {statusError}
              </div>
            )}
            {status && status.logged_in && status.auth_method && (
              <div className="mt-2 text-[0.7rem] text-[var(--text-tertiary)]">
                {t('settings.llmBackends.claudeCodeModal.authMethodLabel')}: {status.auth_method}
              </div>
            )}
          </section>

          {/* Auth mode radios */}
          <section>
            <h4 className="text-[0.875rem] font-semibold mb-2">
              {t('settings.llmBackends.claudeCodeModal.sectionAuthMode')}
            </h4>
            <div className="flex flex-col gap-2">
              {modeBlurbs.map(([id, label, blurb]) => (
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
                ? (
                  <>
                    {t('settings.llmBackends.claudeCodeModal.hostMount.loggedInPrefix')}
                    <code>~/.claude/.credentials.json</code>
                    {t('settings.llmBackends.claudeCodeModal.hostMount.loggedInMid')}
                    <strong>{status.subscription_type || t('settings.llmBackends.claudeCodeModal.hostMount.subscription')}</strong>
                    {t('settings.llmBackends.claudeCodeModal.hostMount.loggedInSuffix')}
                  </>
                )
                : (
                  <>
                    {t('settings.llmBackends.claudeCodeModal.hostMount.notLoggedInPrefix')}
                    <code>~/.claude</code>
                    {t('settings.llmBackends.claudeCodeModal.hostMount.notLoggedInMid')}
                    <code className="bg-[var(--bg-tertiary)] px-1 rounded">claude auth login</code>
                    {t('settings.llmBackends.claudeCodeModal.hostMount.notLoggedInSuffix')}
                    <em>"{t('settings.llmBackends.claudeCodeModal.hostMount.signInHere')}"</em>
                    {t('settings.llmBackends.claudeCodeModal.hostMount.notLoggedInTrail')}
                  </>
                )}
            </section>
          )}

          {authMode === 'in_modal_login' && (
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => startLogin(false)}
                  disabled={jobRunning}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] hover:bg-[var(--primary-hover)] transition-colors disabled:opacity-50"
                >
                  {jobRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                  {t('settings.llmBackends.claudeCodeModal.startLogin')}
                </button>
                <button
                  type="button"
                  onClick={() => startLogin(true)}
                  disabled={jobRunning}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
                >
                  {t('settings.llmBackends.claudeCodeModal.startConsoleLogin')}
                </button>
                {jobRunning && (
                  <button
                    type="button"
                    onClick={cancelLogin}
                    className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-500/30 text-rose-300 text-[0.75rem] hover:bg-rose-500/10"
                  >
                    {t('settings.llmBackends.common.cancel')}
                  </button>
                )}
              </div>

              {urls.length > 0 && (
                <div className="rounded border border-sky-500/30 bg-sky-500/10 p-3 flex flex-col gap-2">
                  <div className="text-[0.75rem] text-sky-300 uppercase tracking-wide">
                    {t('settings.llmBackends.common.openUrl')}
                  </div>
                  {urls.map((u) => (
                    <UrlPanel key={u} url={u} t={t} />
                  ))}
                </div>
              )}

              {/* Auth-code paste-back. The Claude CLI prompts for the
                  code on stdin after the user approves the OAuth flow
                  in their browser. We surface this only after a URL
                  has been printed by the job. */}
              {job && jobRunning && urls.length > 0 && (
                <div className="rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-3 flex flex-col gap-2">
                  <label className="text-[0.8125rem] font-medium">
                    {t('settings.llmBackends.claudeCodeModal.authCodeLabel')}
                  </label>
                  <p className="text-[0.7rem] text-[var(--text-tertiary)] leading-relaxed">
                    {t('settings.llmBackends.claudeCodeModal.authCodeHint')}
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={authCodeInput}
                      onChange={(e) => setAuthCodeInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && authCodeInput.trim() && !authCodeSubmitting) {
                          e.preventDefault();
                          submitAuthCode();
                        }
                      }}
                      placeholder={t('settings.llmBackends.claudeCodeModal.authCodePlaceholder')}
                      autoFocus
                      className="flex-1 px-3 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[0.8125rem] font-mono"
                    />
                    <button
                      type="button"
                      onClick={submitAuthCode}
                      disabled={!authCodeInput.trim() || authCodeSubmitting}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] hover:bg-[var(--primary-hover)] transition-colors disabled:opacity-50"
                    >
                      {authCodeSubmitting
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : t('settings.llmBackends.claudeCodeModal.submitAuthCode')}
                    </button>
                  </div>
                  {authCodeStatus && (
                    <div
                      className={`text-[0.75rem] rounded p-2 border ${
                        authCodeStatus.kind === 'ok'
                          ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                          : 'text-rose-300 bg-rose-500/10 border-rose-500/30'
                      }`}
                    >
                      {authCodeStatus.text}
                    </div>
                  )}
                </div>
              )}

              {job && (
                <div className="text-[0.7rem] text-[var(--text-tertiary)]">
                  {t('settings.llmBackends.claudeCodeModal.jobStarted', {
                    id: job.job_id,
                    time: new Date().toLocaleTimeString(),
                  })}
                </div>
              )}
            </section>
          )}

          {authMode === 'setup_token' && (
            <section className="flex flex-col gap-2">
              <p className="text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed">
                {t('settings.llmBackends.claudeCodeModal.setupTokenIntro')}
                <code className="block bg-[var(--bg-tertiary)] mt-1 p-2 rounded text-[0.75rem]">claude setup-token</code>
                {t('settings.llmBackends.claudeCodeModal.setupTokenStore')}
                <code>api_key</code>
                {t('settings.llmBackends.claudeCodeModal.setupTokenStoreSuffix')}
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
                  aria-label={tokenVisible ? t('settings.hide') : t('settings.show')}
                >
                  {tokenVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  type="button"
                  onClick={saveToken}
                  disabled={!tokenInput.trim()}
                  className="px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] disabled:opacity-50"
                >
                  {t('settings.llmBackends.common.save')}
                </button>
              </div>
            </section>
          )}

          {authMode === 'api_key' && (
            <section className="flex flex-col gap-2">
              <p className="text-[0.8125rem] text-[var(--text-secondary)] leading-relaxed">
                {t('settings.llmBackends.claudeCodeModal.apiKeyIntro')}
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
                  {t('settings.llmBackends.common.save')}
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
                {showConsole
                  ? t('settings.llmBackends.claudeCodeModal.hideLiveConsole')
                  : t('settings.llmBackends.claudeCodeModal.showLiveConsole')}
              </button>
              {showConsole && (
                <pre className="rounded border border-[var(--border-color)] bg-black/40 text-[0.72rem] leading-relaxed p-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap text-[var(--text-secondary)]">
                  {liveText || t('settings.llmBackends.claudeCodeModal.noOutput')}
                </pre>
              )}
            </section>
          )}

          {/* Test + Logout */}
          <section className="flex items-center gap-2 pt-2 border-t border-[var(--border-color)] flex-wrap">
            <button
              type="button"
              onClick={runTest}
              disabled={testLoading}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              {testLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {t('settings.llmBackends.common.testConnection')}
            </button>
            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-rose-500/30 text-rose-300 text-[0.8125rem] hover:bg-rose-500/10"
            >
              <LogOut className="w-3.5 h-3.5" />
              {t('settings.llmBackends.common.signOut')}
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
            {t('settings.llmBackends.common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}


function UrlPanel({
  url,
  t,
}: {
  url: string;
  t: (key: string) => string;
}) {
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
        {copied ? t('settings.llmBackends.common.copied') : t('settings.llmBackends.common.copy')}
      </button>
    </div>
  );
}
