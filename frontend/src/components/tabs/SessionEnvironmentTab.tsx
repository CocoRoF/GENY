'use client';

/**
 * SessionEnvironmentTab — per-session read-only view of the
 * EnvironmentManifest the session is bound to, rendered as the
 * 21-stage pipeline canvas (visually mirrors geny-executor-web's
 * pipeline page). Execution state is intentionally absent — this
 * tab answers "which environment is applied to this session?",
 * not "is it running right now?".
 *
 * Sessions that pre-date the environment migration have no env_id
 * and still run the legacy preset; they get a "bind an environment"
 * CTA instead of a faked pipeline.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Boxes,
  Link2Off,
  Maximize2,
  RefreshCw,
  Repeat2,
  Settings2,
  X,
} from 'lucide-react';

import { useAppStore } from '@/store/useAppStore';
import { IconButton } from '@/components/common/layout';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useI18n } from '@/lib/i18n';
import { environmentApi } from '@/lib/environmentApi';
import { agentApi } from '@/lib/api';
import type {
  EnvironmentDetail,
  StageManifestEntry,
} from '@/types/environment';
import PipelineCanvas from '@/components/session-env/PipelineCanvas';
import StageDetailPanel from '@/components/session-env/StageDetailPanel';
import Selector from '@/components/ui/Selector';
import { useSessionEnvTargetId } from '@/components/session-env/sessionEnvTarget';

export default function SessionEnvironmentTab() {
  const { sessions, setActiveTab } = useAppStore();
  const loadSessions = useAppStore((s) => s.loadSessions);
  const selectedSessionId = useSessionEnvTargetId();
  const environments = useEnvironmentStore((s) => s.environments);
  const loadEnvironments = useEnvironmentStore((s) => s.loadEnvironments);
  const requestOpenEnvDrawer = useEnvironmentStore(
    (s) => s.requestOpenEnvDrawer,
  );
  const { t } = useI18n();

  const session = useMemo(
    () => sessions.find((s) => s.session_id === selectedSessionId),
    [sessions, selectedSessionId],
  );
  const sessionEnvId = session?.env_id ?? null;

  useEffect(() => {
    if (sessionEnvId && environments.length === 0) {
      void loadEnvironments();
    }
  }, [sessionEnvId, environments.length, loadEnvironments]);

  const envSummary = sessionEnvId
    ? environments.find((e) => e.id === sessionEnvId) ?? null
    : null;
  const envMissing =
    !!sessionEnvId && environments.length > 0 && envSummary === null;

  // Local manifest fetch — kept out of useEnvironmentStore.selectedEnvironment
  // so we don't clobber state other views (Builder, Drawer) rely on.
  const [manifestEnv, setManifestEnv] = useState<EnvironmentDetail | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState('');

  const fetchManifest = useCallback(
    async (envId: string) => {
      setManifestLoading(true);
      setManifestError('');
      try {
        const env = await environmentApi.get(envId);
        setManifestEnv(env);
      } catch (e) {
        setManifestError(
          e instanceof Error
            ? e.message
            : t('sessionEnvironmentTab.loadFailed'),
        );
      } finally {
        setManifestLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!sessionEnvId) {
      setManifestEnv(null);
      setManifestError('');
      return;
    }
    if (manifestEnv?.id === sessionEnvId) return;
    void fetchManifest(sessionEnvId);
  }, [sessionEnvId, manifestEnv?.id, fetchManifest]);

  const stages = useMemo<StageManifestEntry[]>(() => {
    const list = manifestEnv?.manifest?.stages ?? [];
    return [...list].sort((a, b) => a.order - b.order);
  }, [manifestEnv]);

  const stageByOrder = useMemo(() => {
    const m = new Map<number, StageManifestEntry>();
    for (const s of stages) m.set(s.order, s);
    return m;
  }, [stages]);

  const activeCount = useMemo(
    () => stages.filter((s) => s.active).length,
    [stages],
  );

  // Selected stage (for detail panel)
  const [selectedOrder, setSelectedOrder] = useState<number | null>(null);
  useEffect(() => {
    // Clear selection whenever the session / env changes
    setSelectedOrder(null);
  }, [selectedSessionId, sessionEnvId]);

  // Code view

  // Canvas reset
  const resetViewRef = useRef<(() => void) | null>(null);
  const handleReset = () => {
    resetViewRef.current?.();
  };

  const openEnvInDrawer = () => {
    if (!sessionEnvId) return;
    requestOpenEnvDrawer(sessionEnvId);
    setActiveTab('environments');
  };

  const openEnvironmentsTab = () => {
    setActiveTab('environments');
  };

  // ── Change bound environment (rebind this session) ──────────────
  const [envPickerOpen, setEnvPickerOpen] = useState(false);
  const [changingEnv, setChangingEnv] = useState(false);

  const handleChangeEnv = useCallback(
    async (newEnvId: string) => {
      if (!selectedSessionId || !newEnvId || newEnvId === sessionEnvId) {
        setEnvPickerOpen(false);
        return;
      }
      setChangingEnv(true);
      try {
        const res = await agentApi.changeEnv(selectedSessionId, newEnvId);
        // Refresh sessions so session.env_id updates → manifest re-fetches.
        await loadSessions();
        setEnvPickerOpen(false);
        toast.success(
          res.live
            ? t('sessionEnvironmentTab.changeEnv.appliedLive')
            : t('sessionEnvironmentTab.changeEnv.appliedDormant'),
        );
      } catch (e) {
        toast.error(
          e instanceof Error
            ? e.message
            : t('sessionEnvironmentTab.changeEnv.failed'),
        );
      } finally {
        setChangingEnv(false);
      }
    },
    [selectedSessionId, sessionEnvId, loadSessions, t],
  );

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-[0.875rem]">
        {t('sessionEnvironmentTab.selectSession')}
      </div>
    );
  }

  const sessionDisplayName =
    session.session_name || session.session_id.slice(0, 8);
  const hasPipeline = !!sessionEnvId && !envMissing && stages.length > 0;

  return (
    <div className="pipeline-scope h-full flex flex-col overflow-hidden">
      {/* ── Slim toolbar — actions only. Identity (session · env) lives
            in the scope bar above; activeRatio is shown as a chip here. ── */}
      <div
        className="px-4 py-2.5 min-h-[49px] flex items-center justify-between shrink-0 gap-2 flex-wrap"
        style={{ borderBottom: '1px solid var(--pipe-border)' }}
      >
        <span
          className="text-[10px] font-medium pipe-mono"
          style={{ color: 'var(--pipe-text-muted)' }}
        >
          {hasPipeline
            ? t('sessionEnvironmentTab.pipeline.activeRatio', {
                active: String(activeCount),
                total: String(stages.length),
              })
            : ''}
        </span>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {/* Change env — rebind THIS session (VTuber or Sub-Agent, per the
              toggle in the root tab) to a different environment. Shown even
              when unbound so a legacy session can be bound. */}
          <button
            onClick={() => {
              if (environments.length === 0) void loadEnvironments();
              setEnvPickerOpen(true);
            }}
            className="flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer text-[10px] font-semibold transition-colors hover:brightness-125"
            style={{
              background: 'var(--pipe-bg-tertiary)',
              color: 'var(--pipe-text-secondary)',
              border: '1px solid var(--pipe-border)',
            }}
          >
            <Repeat2 size={11} />
            {t('sessionEnvironmentTab.changeEnv.button')}
          </button>
          {hasPipeline && (
            <button
              onClick={handleReset}
              title={t('sessionEnvironmentTab.pipeline.reset')}
              aria-label={t('sessionEnvironmentTab.pipeline.reset')}
              className="flex items-center justify-center w-7 h-7 rounded-md cursor-pointer transition-colors hover:brightness-125"
              style={{
                background: 'var(--pipe-bg-tertiary)',
                color: 'var(--pipe-text-muted)',
                border: '1px solid var(--pipe-border)',
              }}
            >
              <Maximize2 size={11} />
            </button>
          )}
          {sessionEnvId && !envMissing && (
            <>
              <button
                onClick={() => sessionEnvId && void fetchManifest(sessionEnvId)}
                disabled={manifestLoading}
                title={t('sessionEnvironmentTab.reload')}
                aria-label={t('sessionEnvironmentTab.reload')}
                className="flex items-center justify-center w-7 h-7 rounded-md cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: 'var(--pipe-bg-tertiary)',
                  color: 'var(--pipe-text-muted)',
                  border: '1px solid var(--pipe-border)',
                }}
              >
                <RefreshCw
                  size={11}
                  className={manifestLoading ? 'animate-spin' : ''}
                />
              </button>
              <button
                onClick={openEnvInDrawer}
                className="flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer text-[10px] font-semibold transition-colors hover:brightness-125"
                style={{
                  background: 'var(--pipe-accent)',
                  color: '#ffffff',
                  border: '1px solid var(--pipe-accent)',
                }}
              >
                <Settings2 size={11} />
                {t('sessionEnvironmentTab.openInEnvironments')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Body: graph (flex-1) | inline stage detail (right split) ── */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col relative">
          {!sessionEnvId ? (
            <UnboundState
              workflow={session.workflow_id || '—'}
              onGoToEnvironments={openEnvironmentsTab}
            />
          ) : envMissing ? (
            <EnvMissingState sessionEnvId={sessionEnvId} />
          ) : manifestLoading && !manifestEnv ? (
            <CenterMessage message={t('sessionEnvironmentTab.loading')} />
          ) : manifestError ? (
            <ErrorState
              message={manifestError}
              onRetry={() => sessionEnvId && void fetchManifest(sessionEnvId)}
            />
          ) : stages.length === 0 ? (
            <CenterMessage message={t('sessionEnvironmentTab.manifestEmpty')} />
          ) : (
            <PipelineCanvas
              stages={stages}
              selectedOrder={selectedOrder}
              onSelectStage={setSelectedOrder}
              onResetView={(fn) => {
                resetViewRef.current = fn;
              }}
            />
          )}
        </div>

        {/* Stage detail — in-flow split panel beside the graph (not a
            full-screen drawer). Clicking another node swaps its content. */}
        {selectedOrder !== null && hasPipeline && (
          <div
            className="w-[380px] max-w-[46%] shrink-0 overflow-y-auto"
            style={{
              borderLeft: '1px solid var(--pipe-border)',
              background: 'var(--pipe-bg-secondary)',
            }}
          >
            <StageDetailPanel
              inline
              order={selectedOrder}
              entry={stageByOrder.get(selectedOrder)}
              onClose={() => setSelectedOrder(null)}
            />
          </div>
        )}
      </div>

      {/* ── Change-env picker ────────────────────────────── */}
      {envPickerOpen && (
        <EnvChangeModal
          sessionName={sessionDisplayName}
          currentEnvId={sessionEnvId}
          environments={environments}
          busy={changingEnv}
          onConfirm={handleChangeEnv}
          onClose={() => !changingEnv && setEnvPickerOpen(false)}
        />
      )}
    </div>
  );
}

/* ═══ Change-env picker modal ═══ */

function EnvChangeModal({
  sessionName,
  currentEnvId,
  environments,
  busy,
  onConfirm,
  onClose,
}: {
  sessionName: string;
  currentEnvId: string | null;
  environments: { id: string; name: string }[];
  busy: boolean;
  onConfirm: (envId: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string>(currentEnvId ?? '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[460px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2">
            <Repeat2 size={15} className="text-[var(--primary-color)]" />
            <span className="text-[0.875rem] font-semibold text-[var(--text-primary)]">
              {t('sessionEnvironmentTab.changeEnv.title')}
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40"
            aria-label="close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-3">
          <p className="text-[0.75rem] text-[var(--text-secondary)]">
            {t('sessionEnvironmentTab.changeEnv.body', { session: sessionName })}
          </p>
          <Selector
            variant="field"
            ariaLabel={t('sessionEnvironmentTab.changeEnv.title')}
            value={picked}
            onChange={setPicked}
            disabled={busy}
            placeholder={t('sessionEnvironmentTab.changeEnv.placeholder')}
            items={[
              { id: '', label: t('sessionEnvironmentTab.changeEnv.placeholder') },
              ...environments.map((env) => ({
                id: env.id,
                label: `${env.name}${env.id === currentEnvId ? t('sessionEnvironmentTab.current') : ''}`,
              })),
            ]}
          />
          <p className="text-[0.6875rem] text-[var(--text-muted)] leading-relaxed">
            {t('sessionEnvironmentTab.changeEnv.note')}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border-color)]">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-[0.75rem] text-[var(--text-secondary)] border border-[var(--border-color)] hover:bg-[var(--bg-secondary)] disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => onConfirm(picked)}
            disabled={busy || !picked || picked === currentEnvId}
            className="px-3 py-1.5 rounded-md text-[0.75rem] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'var(--primary-color)' }}
          >
            {busy
              ? t('sessionEnvironmentTab.changeEnv.applying')
              : t('sessionEnvironmentTab.changeEnv.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══ Empty / error states ═══ */

function UnboundState({
  workflow,
  onGoToEnvironments,
}: {
  workflow: string;
  onGoToEnvironments: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <Link2Off
        size={28}
        style={{ color: 'var(--pipe-text-muted)', opacity: 0.6 }}
      />
      <p
        className="text-[0.875rem] max-w-[420px]"
        style={{ color: 'var(--pipe-text-secondary)' }}
      >
        {t('sessionEnvironmentTab.unboundHeadline')}
      </p>
      <p
        className="text-[0.75rem] max-w-[480px]"
        style={{ color: 'var(--pipe-text-muted)' }}
      >
        {t('sessionEnvironmentTab.unboundBody', { workflow })}
      </p>
      <button
        onClick={onGoToEnvironments}
        className="mt-1 flex items-center gap-1.5 py-1.5 px-3 rounded-md text-[0.75rem] font-semibold cursor-pointer transition-colors hover:brightness-125"
        style={{
          background: 'var(--pipe-accent)',
          color: '#ffffff',
          border: '1px solid var(--pipe-accent)',
        }}
      >
        <Boxes size={12} />
        {t('sessionEnvironmentTab.goToEnvironments')}
      </button>
    </div>
  );
}

function EnvMissingState({ sessionEnvId }: { sessionEnvId: string }) {
  const { t } = useI18n();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
      <AlertTriangle size={28} style={{ color: 'var(--pipe-red)', opacity: 0.8 }} />
      <p
        className="text-[0.875rem] max-w-[480px]"
        style={{ color: 'var(--pipe-text-secondary)' }}
      >
        {t('sessionEnvironmentTab.envMissingHeadline')}
      </p>
      <p
        className="pipe-mono text-[0.6875rem]"
        style={{ color: 'var(--pipe-text-muted)' }}
      >
        {sessionEnvId}
      </p>
      <p
        className="text-[0.75rem] max-w-[480px]"
        style={{ color: 'var(--pipe-text-muted)' }}
      >
        {t('sessionEnvironmentTab.envMissingBody')}
      </p>
    </div>
  );
}

function CenterMessage({ message }: { message: string }) {
  return (
    <div
      className="flex-1 flex items-center justify-center text-[0.875rem]"
      style={{ color: 'var(--pipe-text-muted)' }}
    >
      {message}
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
      <AlertTriangle size={24} style={{ color: 'var(--pipe-red)', opacity: 0.8 }} />
      <p
        className="text-[0.8125rem]"
        style={{ color: 'var(--pipe-red)' }}
      >
        {message}
      </p>
      <IconButton icon={RefreshCw} title={t('common.refresh')} onClick={onRetry} className="mt-1" />
    </div>
  );
}
