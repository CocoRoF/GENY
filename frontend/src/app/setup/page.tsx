'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/useAuthStore';
import { useI18n } from '@/lib/i18n';
import { ShieldCheck, Server, KeyRound, Loader2, CheckCircle2, ArrowRight } from 'lucide-react';
import { configApi, llmBackendsApi } from '@/lib/api';
import { environmentApi } from '@/lib/environmentApi';

type CloudProvider = 'anthropic' | 'openai' | 'google';

const CLOUD_FIELD: Record<CloudProvider, string> = {
  anthropic: 'anthropic_api_key',
  openai: 'openai_api_key',
  google: 'google_api_key',
};

export default function SetupPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { hasUsers, setup, checkAuth, initialized } = useAuthStore();

  // step 1 — admin account
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  // Set the instant we begin creating the admin, BEFORE setup() flips
  // hasUsers=true in the store — otherwise the "already set up → bounce home"
  // effect could fire (step still 1) and skip the LLM step.
  const advancing = useRef(false);

  // step 2 — LLM onboarding
  const [step, setStep] = useState<1 | 2>(1);
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434/v1');
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>('anthropic');
  const [cloudKey, setCloudKey] = useState('');
  const [busy, setBusy] = useState<'' | 'ollama' | 'cloud' | 'skip'>('');
  const [llmError, setLlmError] = useState('');
  const [llmInfo, setLlmInfo] = useState('');

  useEffect(() => { checkAuth(); }, [checkAuth]);
  useEffect(() => {
    // Only bounce away on first paint; once we advance to step 2 the user IS
    // authenticated (hasUsers flips true) and we want to keep showing the wizard.
    if (initialized && hasUsers && step === 1 && !advancing.current) router.replace('/');
  }, [initialized, hasUsers, router, step]);
  useEffect(() => { usernameRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!username.trim()) { setError(t('auth.usernameRequired')); return; }
    if (password.length < 4) { setError(t('auth.passwordTooShort')); return; }
    if (password !== confirmPassword) { setError(t('auth.passwordMismatch')); return; }

    advancing.current = true; // guard the redirect effect before hasUsers flips
    setLoading(true);
    try {
      await setup(username.trim(), password, displayName.trim() || undefined);
      setStep(2); // authenticated now → LLM onboarding
    } catch (e: unknown) {
      advancing.current = false;
      setError(e instanceof Error ? e.message : t('auth.setupFailed'));
    } finally {
      setLoading(false);
    }
  };

  const finish = () => router.replace('/');

  // Adopt the just-configured backend into the template seed envs (no restart).
  const reseedAndFinish = async () => {
    try { await environmentApi.reseedTemplates(); } catch { /* non-fatal */ }
    finish();
  };

  const connectOllama = async () => {
    setBusy('ollama'); setLlmError(''); setLlmInfo('');
    try {
      const res = await llmBackendsApi.localModels('ollama', ollamaUrl.trim() || undefined);
      if (!res.reachable) {
        setLlmError(t('auth.llmStep.ollamaUnreachable'));
        return;
      }
      await configApi.update('llm_credentials', { ollama_base_url: res.base_url });
      setLlmInfo(t('auth.llmStep.ollamaConnected', { count: res.models.length }));
      await reseedAndFinish();
    } catch (e) {
      setLlmError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const saveCloud = async () => {
    if (!cloudKey.trim()) { setLlmError(t('auth.llmStep.keyRequired')); return; }
    setBusy('cloud'); setLlmError(''); setLlmInfo('');
    try {
      await configApi.update('llm_credentials', { [CLOUD_FIELD[cloudProvider]]: cloudKey.trim() });
      await reseedAndFinish();
    } catch (e) {
      setLlmError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const skip = async () => {
    setBusy('skip');
    await reseedAndFinish();
  };

  if (!initialized) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
        <div className="text-[var(--text-muted)] text-sm">{t('common.loading')}</div>
      </div>
    );
  }
  if (hasUsers && step === 1) return null;

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)] py-8">
      <div className="w-full max-w-[480px] mx-4">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--primary-color)] mb-4">
            <ShieldCheck size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
            {step === 1 ? t('auth.setupTitle') : t('auth.llmStep.title')}
          </h1>
          <p className="text-[0.875rem] text-[var(--text-secondary)]">
            {step === 1 ? t('auth.setupDescription') : t('auth.llmStep.description')}
          </p>
          {/* step dots */}
          <div className="flex items-center justify-center gap-1.5 mt-3">
            <span className={`h-1.5 rounded-full transition-all ${step === 1 ? 'w-6 bg-[var(--primary-color)]' : 'w-1.5 bg-[var(--border-color)]'}`} />
            <span className={`h-1.5 rounded-full transition-all ${step === 2 ? 'w-6 bg-[var(--primary-color)]' : 'w-1.5 bg-[var(--border-color)]'}`} />
          </div>
        </div>

        {/* ── Step 1: admin account ── */}
        {step === 1 && (
          <form
            onSubmit={handleSubmit}
            className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 flex flex-col gap-4 shadow-[var(--shadow-lg)]"
          >
            {error && (
              <div className="px-3 py-2 rounded-md bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-[0.8125rem] text-[var(--danger-color)]">
                {error}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('auth.username')}</label>
              <input ref={usernameRef} type="text" value={username} onChange={e => setUsername(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] text-[0.875rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)] transition-colors"
                placeholder={t('auth.usernamePlaceholder')} autoComplete="username" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('auth.displayName')}</label>
              <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] text-[0.875rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)] transition-colors"
                placeholder={t('auth.displayNamePlaceholder')} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('auth.password')}</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] text-[0.875rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)] transition-colors"
                placeholder={t('auth.passwordPlaceholder')} autoComplete="new-password" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">{t('auth.confirmPassword')}</label>
              <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] text-[0.875rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)] transition-colors"
                placeholder={t('auth.confirmPasswordPlaceholder')} autoComplete="new-password" />
            </div>
            <button type="submit" disabled={loading}
              className="w-full mt-2 px-4 py-2.5 text-[0.875rem] font-semibold rounded-md bg-[var(--primary-color)] border-none text-white hover:opacity-90 cursor-pointer transition-opacity disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2">
              {loading ? t('auth.creatingAccount') : <>{t('auth.createAccount')} <ArrowRight size={16} /></>}
            </button>
          </form>
        )}

        {/* ── Step 2: LLM onboarding ── */}
        {step === 2 && (
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 flex flex-col gap-5 shadow-[var(--shadow-lg)]">
            {llmError && (
              <div className="px-3 py-2 rounded-md bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-[0.8125rem] text-[var(--danger-color)]">
                {llmError}
              </div>
            )}
            {llmInfo && (
              <div className="px-3 py-2 rounded-md bg-[rgba(16,185,129,0.1)] border border-[rgba(16,185,129,0.3)] text-[0.8125rem] text-emerald-300 inline-flex items-center gap-1.5">
                <CheckCircle2 size={14} /> {llmInfo}
              </div>
            )}

            {/* Local / Ollama — recommended, keyless */}
            <div className="flex flex-col gap-2 p-3.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)]">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-[var(--primary-color)]" />
                <span className="text-[0.875rem] font-semibold text-[var(--text-primary)]">{t('auth.llmStep.ollamaTitle')}</span>
                <span className="text-[0.65rem] px-1.5 py-0.5 rounded-full bg-[var(--primary-color)]/15 text-[var(--primary-color)]">{t('auth.llmStep.recommended')}</span>
              </div>
              <p className="text-[0.75rem] text-[var(--text-tertiary)] leading-relaxed">{t('auth.llmStep.ollamaHelp')}</p>
              <div className="flex gap-2">
                <input type="text" value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] text-[0.8125rem] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)]"
                  placeholder="http://localhost:11434/v1" />
                <button type="button" onClick={connectOllama} disabled={busy !== ''}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium hover:opacity-90 disabled:opacity-50 shrink-0">
                  {busy === 'ollama' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {t('auth.llmStep.connect')}
                </button>
              </div>
            </div>

            {/* Cloud key */}
            <div className="flex flex-col gap-2 p-3.5 rounded-md border border-[var(--border-color)]">
              <div className="flex items-center gap-2">
                <KeyRound size={16} className="text-[var(--text-secondary)]" />
                <span className="text-[0.875rem] font-semibold text-[var(--text-primary)]">{t('auth.llmStep.cloudTitle')}</span>
              </div>
              <div className="flex gap-2">
                <select value={cloudProvider} onChange={e => setCloudProvider(e.target.value as CloudProvider)}
                  className="px-2 py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] text-[0.8125rem] text-[var(--text-primary)] outline-none">
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="google">Google</option>
                </select>
                <input type="password" value={cloudKey} onChange={e => setCloudKey(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] text-[0.8125rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)]"
                  placeholder={t('auth.llmStep.keyPlaceholder')} autoComplete="off" />
                <button type="button" onClick={saveCloud} disabled={busy !== ''}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-[var(--border-color)] text-[0.8125rem] hover:bg-[var(--bg-hover)] disabled:opacity-50 shrink-0">
                  {busy === 'cloud' ? <Loader2 size={14} className="animate-spin" /> : null}
                  {t('auth.llmStep.save')}
                </button>
              </div>
            </div>

            {/* Skip */}
            <button type="button" onClick={skip} disabled={busy !== ''}
              className="text-center text-[0.8125rem] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors disabled:opacity-50">
              {busy === 'skip' ? t('common.loading') : t('auth.llmStep.skip')}
            </button>
          </div>
        )}

        <p className="text-center text-[0.75rem] text-[var(--text-muted)] mt-4">
          {step === 1 ? t('auth.setupNote') : t('auth.llmStep.note')}
        </p>
      </div>
    </div>
  );
}
