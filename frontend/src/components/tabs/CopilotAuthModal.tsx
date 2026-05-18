/**
 * CopilotAuthModal — Phase G4. Mirrors ClaudeCodeAuthModal's shape but
 * for ``gh copilot``: two requirements (gh logged in + gh-copilot
 * extension installed). Streams the device-code URL from `gh auth login`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, RefreshCw, Loader2, LogIn, LogOut, ExternalLink, CheckCircle2,
  AlertCircle, Terminal, Copy, Check,
} from 'lucide-react';

import {
  llmBackendsApi,
  type AuthJobEvent,
  type AuthLoginStartResponse,
  type CopilotAuthStatus,
  type TestConnectionResponse,
} from '@/lib/api';


function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/\S+/g) || [];
  return Array.from(new Set(matches));
}


function extractDeviceCodes(text: string): string[] {
  // gh auth login prints lines like "First copy your one-time code: ABCD-EFGH"
  const matches = text.match(/(?:code:?\s*)([A-Z0-9]{4}-[A-Z0-9]{4})/g) || [];
  return Array.from(new Set(matches.map((m) => m.replace(/^.*?([A-Z0-9]{4}-[A-Z0-9]{4})$/, '$1'))));
}


export default function CopilotAuthModal({
  onClose,
  onChange,
}: {
  onClose: () => void;
  onChange?: () => void;
}) {
  const [status, setStatus] = useState<CopilotAuthStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [job, setJob] = useState<AuthLoginStartResponse | null>(null);
  const [events, setEvents] = useState<AuthJobEvent[]>([]);
  const [jobRunning, setJobRunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  // ── status ────────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const s = await llmBackendsApi.copilotStatus();
      setStatus(s);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // ── login flow ────────────────────────────────────────────

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  useEffect(() => () => closeStream(), [closeStream]);

  const startLogin = useCallback(async () => {
    closeStream();
    setEvents([]);
    setJobRunning(true);
    try {
      const j = await llmBackendsApi.copilotStartLogin();
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

  const logout = useCallback(async () => {
    if (!confirm('Sign out of gh on the server? You\'ll have to log in again to use Copilot CLI.')) return;
    try { await llmBackendsApi.copilotLogout(); onChange?.(); }
    catch (e) { setStatusError(e instanceof Error ? e.message : String(e)); }
    refreshStatus();
  }, [refreshStatus, onChange]);

  const runTest = useCallback(async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      setTestResult(await llmBackendsApi.copilotTest());
    } catch (e) {
      setTestResult({ ok: false, duration_ms: 0, detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setTestLoading(false);
    }
  }, []);

  // ── derived ───────────────────────────────────────────────

  const liveText = useMemo(() => events.map((e) => `[${e.channel}] ${e.text}`).join('\n'), [events]);
  const urls = useMemo(() => extractUrls(liveText), [liveText]);
  const codes = useMemo(() => extractDeviceCodes(liveText), [liveText]);

  const loginOk = status?.logged_in === true;
  const extensionOk = status?.extension_installed === true;
  const ready = loginOk && extensionOk;

  // ── render ────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-full max-w-[720px] mx-4 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center py-4 px-6 border-b border-[var(--border-color)]">
          <h3 className="text-[1rem] font-semibold inline-flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[var(--text-secondary)]" />
            GitHub Copilot (CLI) — Authentication
          </h3>
          <button type="button" className="w-8 h-8 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)]" onClick={onClose}>
            <X size={16} className="m-auto" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
          {/* Status panel */}
          <section className="rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-tertiary)] p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                {ready ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 text-emerald-300 text-[0.7rem]">
                    <CheckCircle2 className="w-3 h-3" /> Ready
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/15 text-amber-300 text-[0.7rem]">
                    <AlertCircle className="w-3 h-3" /> Setup needed
                  </span>
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
            <ul className="text-[0.8125rem] flex flex-col gap-1">
              <li className="flex items-center gap-2">
                <span className={loginOk ? 'text-emerald-300' : 'text-amber-300'}>
                  {loginOk ? '✓' : '○'}
                </span>
                <span>
                  <code>gh auth status</code>: {loginOk ? 'logged in' : 'not logged in'}
                </span>
              </li>
              <li className="flex items-center gap-2">
                <span className={extensionOk ? 'text-emerald-300' : 'text-amber-300'}>
                  {extensionOk ? '✓' : '○'}
                </span>
                <span>
                  <code>gh-copilot</code> extension: {extensionOk ? 'installed' : 'missing'}
                </span>
              </li>
            </ul>
            {statusError && (
              <div className="mt-2 text-[0.75rem] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-2">
                {statusError}
              </div>
            )}
            {status?.auth_status_text && (
              <pre className="mt-2 text-[0.7rem] text-[var(--text-tertiary)] bg-[var(--bg-secondary)] rounded p-2 whitespace-pre-wrap max-h-[120px] overflow-y-auto">
                {status.auth_status_text}
              </pre>
            )}
          </section>

          {/* Sign in section */}
          <section className="flex flex-col gap-3">
            <h4 className="text-[0.875rem] font-semibold">Sign in</h4>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={startLogin}
                disabled={jobRunning}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-[var(--primary-color)] text-white text-[0.8125rem] hover:bg-[var(--primary-color-hover)] disabled:opacity-50"
              >
                {jobRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                Start gh auth login (web)
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

            {codes.length > 0 && (
              <div className="rounded border border-sky-500/30 bg-sky-500/10 p-3 flex flex-col gap-2">
                <div className="text-[0.75rem] text-sky-300 uppercase tracking-wide">One-time code:</div>
                {codes.map((c) => (
                  <CodePanel key={c} code={c} />
                ))}
              </div>
            )}
            {urls.length > 0 && (
              <div className="rounded border border-sky-500/30 bg-sky-500/10 p-3 flex flex-col gap-2">
                <div className="text-[0.75rem] text-sky-300 uppercase tracking-wide">Open this URL in your browser:</div>
                {urls.map((u) => (
                  <UrlPanel key={u} url={u} />
                ))}
              </div>
            )}
          </section>

          {/* Extension install hint */}
          {loginOk && !extensionOk && (
            <section className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-[0.8125rem] text-amber-200">
              You're logged into GitHub but the Copilot CLI extension isn't installed.
              SSH into the host and run:
              <pre className="mt-1 bg-black/30 rounded p-2 text-[0.7rem]">gh extension install github/gh-copilot</pre>
              Then hit <strong>Refresh</strong> above.
            </section>
          )}

          {/* Live console (always show when running or after a job has events) */}
          {events.length > 0 && (
            <section>
              <pre className="rounded border border-[var(--border-color)] bg-black/40 text-[0.72rem] leading-relaxed p-3 max-h-[200px] overflow-y-auto whitespace-pre-wrap text-[var(--text-secondary)]">
                {liveText}
              </pre>
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
              disabled={!loginOk}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-rose-500/30 text-rose-300 text-[0.8125rem] hover:bg-rose-500/10 disabled:opacity-30"
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
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  }, [url]);
  return (
    <div className="flex items-center gap-2">
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[0.8125rem] text-sky-300 hover:underline break-all flex-1">
        {url} <ExternalLink className="w-3 h-3 shrink-0" />
      </a>
      <button type="button" onClick={copy} className="px-2 py-1 rounded border border-sky-500/30 text-[0.7rem] text-sky-300 hover:bg-sky-500/10 inline-flex items-center gap-1">
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}


function CodePanel({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ }
  }, [code]);
  return (
    <div className="flex items-center gap-2">
      <code className="text-[1rem] font-mono tracking-widest text-sky-200 bg-black/30 px-2 py-1 rounded flex-1">{code}</code>
      <button type="button" onClick={copy} className="px-2 py-1 rounded border border-sky-500/30 text-[0.7rem] text-sky-300 hover:bg-sky-500/10 inline-flex items-center gap-1">
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
