'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { agentApi, ttsApi, type VoiceProfile } from '@/lib/api';
// workflowApi removed — pipeline presets replace workflow selection
import { toolPresetApi } from '@/lib/toolApi';
import { triggerPresetApi } from '@/lib/triggerPresetApi';
import type { TriggerPresetSummary } from '@/types/triggerPreset';
import NumberStepper from '@/components/ui/NumberStepper';
import InfoTooltip from '@/components/ui/InfoTooltip';
import Selector, { type SelectorItem } from '@/components/ui/Selector';
import { X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useVTuberStore } from '@/store/useVTuberStore';
import type { CreateAgentRequest, SessionInfo, ToolPresetDefinition } from '@/types';
// WorkflowDefinition type removed — using preset strings instead

interface Props { onClose: () => void; }

// Seeded env IDs from backend/service/environment/templates.py. When
// role=vtuber, the VTuber session defaults to VTUBER_ENV and its
// Sub-Worker defaults to WORKER_ENV — mirrors resolve_env_id on
// the backend.
const DEFAULT_VTUBER_ENV_ID = 'template-vtuber-env';
const DEFAULT_WORKER_ENV_ID = 'template-worker-env';

// Session-level model selectors removed in the env-driven cleanup
// (PR for "VTuber sub-worker env regression + model UI clutter"):
// the env manifest's Stage 6 (model_override or pipeline.model) is
// the single source of truth for the LLM model. Picking a model in
// this modal only tagged the session record for display; it never
// influenced the actual LLM call. To change the model, edit the env.


export default function CreateSessionModal({ onClose }: Props) {
  const { createSession, prompts, loadPrompts, loadPromptContent } = useAppStore();
  const { t } = useI18n();

  const [formState, setFormState] = useState<CreateAgentRequest>({
    session_name: '',
    role: 'developer',
    model: '',
    // max_turns removed (2026-04-26): advisory-only field with no
    // executor enforcement; left out of the form to avoid misleading
    // operators. Backend still accepts it on the request schema for
    // restored sessions.
    timeout: 21600,
    max_iterations: 50,
    system_prompt: '',
  });
  const [selectedPrompt, setSelectedPrompt] = useState('geny-default');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [toolPresets, setToolPresets] = useState<ToolPresetDefinition[]>([]);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [selectedEnvId, setSelectedEnvId] = useState('');
  const [memoryProvider, setMemoryProvider] = useState<'' | 'disabled' | 'ephemeral' | 'file' | 'sql'>('');
  const [memoryRoot, setMemoryRoot] = useState('');
  const [memoryDsn, setMemoryDsn] = useState('');
  const [memoryDialect, setMemoryDialect] = useState<'' | 'sqlite' | 'postgres'>('');
  const [memoryScope, setMemoryScope] = useState('');
  const [memoryTimezone, setMemoryTimezone] = useState('');
  // Q.1 (cycle 20260426_3) — per-session memory tuning override.
  const [memoryTuningOpen, setMemoryTuningOpen] = useState(false);
  const [memoryTuningMaxInjectChars, setMemoryTuningMaxInjectChars] = useState('');
  const [memoryTuningRecentTurns, setMemoryTuningRecentTurns] = useState('');
  const [memoryTuningEnableVector, setMemoryTuningEnableVector] = useState<'' | 'true' | 'false'>('');
  const [memoryTuningEnableReflection, setMemoryTuningEnableReflection] = useState<'' | 'true' | 'false'>('');
  const [showMemoryAdvanced, setShowMemoryAdvanced] = useState(false);
  const {
    environments,
    isLoading: environmentsLoading,
    loadEnvironments,
  } = useEnvironmentStore();
  const [selectedAvatar, setSelectedAvatar] = useState('');
  const [selectedTtsProfile, setSelectedTtsProfile] = useState('');
  const [triggerPresets, setTriggerPresets] = useState<TriggerPresetSummary[]>([]);
  const [selectedTriggerPresetId, setSelectedTriggerPresetId] = useState('');
  const [ttsProfiles, setTtsProfiles] = useState<VoiceProfile[]>([]);
  const [ttsProfilesLoaded, setTtsProfilesLoaded] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const { models: avatarModels, modelsLoaded: avatarsLoaded, fetchModels: fetchAvatarModels, assignModel: assignAvatar } = useVTuberStore();

  useEffect(() => { loadPrompts(); }, [loadPrompts]);

  // Load avatar models + TTS profiles when VTuber role is selected
  useEffect(() => {
    if (formState.role === 'vtuber' && !avatarsLoaded) {
      fetchAvatarModels();
    }
    if (formState.role === 'vtuber' && !ttsProfilesLoaded) {
      Promise.all([
        ttsApi.engines().catch((): { engines: string[]; default: string } => ({ engines: [], default: '' })),
        ttsApi.listProfiles().catch((): { profiles: VoiceProfile[] } => ({ profiles: [] })),
      ]).then(([enginesRes, profilesRes]) => {
        const hasTtsEngine = (enginesRes.engines?.length ?? 0) > 0;
        setTtsEnabled(hasTtsEngine);
        setTtsProfiles(profilesRes.profiles || []);
        setTtsProfilesLoaded(true);
      });
    }
  }, [formState.role, avatarsLoaded, fetchAvatarModels, ttsProfilesLoaded]);

  // Load default prompt template content on mount
  useEffect(() => {
    if (selectedPrompt && !formState.system_prompt) {
      loadPromptContent(selectedPrompt).then(content => {
        if (content) setFormState(f => ({ ...f, system_prompt: content }));
      });
    }
  }, [selectedPrompt, loadPromptContent]);

  // Load available workflows
  useEffect(() => {
    // Workflow list removed — presets are determined by role
    toolPresetApi.list().catch(() => ({ presets: [] })).then((presetRes) => {
      setToolPresets(presetRes.presets || []);
    });
  }, []);

  // Load environments for the Phase 6e env_id selector
  useEffect(() => {
    loadEnvironments();
  }, [loadEnvironments]);

  // Load trigger presets — only meaningful for VTuber role but cheap
  // enough to fetch eagerly so the dropdown is populated when the
  // operator switches role.
  useEffect(() => {
    triggerPresetApi
      .list()
      .then((res) => setTriggerPresets(res.presets))
      .catch(() => {
        // Non-fatal — the picker just stays empty.
      });
  }, []);

  const handlePromptChange = async (name: string) => {
    setSelectedPrompt(name);
    if (name) {
      const content = await loadPromptContent(name);
      if (content) setFormState(f => ({ ...f, system_prompt: content }));
    } else {
      // "None" selected — clear template content
      setFormState(f => ({ ...f, system_prompt: '' }));
    }
  };

  const handleRoleChange = (role: string) => {
    setFormState(f => ({ ...f, role }));
    if (role === 'vtuber') {
      handlePromptChange('vtuber-default');
      if (!avatarsLoaded) fetchAvatarModels();
      // Auto-select the seeded VTuber env (the user can override). The
      // VTuber's owned sub-agent is declared by that env, not chosen here.
      setSelectedEnvId(DEFAULT_VTUBER_ENV_ID);
    } else {
      setSelectedAvatar('');
      setSelectedTtsProfile('');
      // If the main env was the VTuber seed (set by a prior vtuber
      // selection), clear it — a non-VTuber role shouldn't inherit
      // the VTuber pipeline.
      if (selectedEnvId === DEFAULT_VTUBER_ENV_ID) {
        setSelectedEnvId('');
      }
    }
  };

  // Filtered prompt lists
  const vtuberPrompts = prompts.filter(p => p.name.startsWith('vtuber-'));
  const generalPrompts = prompts.filter(
    p => !p.name.startsWith('vtuber-') && !p.name.startsWith('sub-worker-'),
  );

  const handleSubmit = async () => {
    setSubmitting(true);
    setError('');
    try {
      const payload: CreateAgentRequest = { ...formState };
      // Preset is determined by role on backend — send workflow_id for compat
      payload.workflow_id = formState.role === 'vtuber' ? 'template-vtuber' : 'template-optimized-autonomous';
      // Send tool preset if explicitly selected
      if (selectedPreset) {
        payload.tool_preset_id = selectedPreset;
      }
      // Phase 6e — attach EnvironmentManifest if selected. Backend
      // falls back to the role-based preset pipeline when env_id is
      // absent, so empty string = legacy path (unchanged behavior).
      if (selectedEnvId) {
        payload.env_id = selectedEnvId;
      }
      // Phase 7-3 — per-session MemoryProvider override. Only send
      // when the user picked a provider; leaving it blank = process
      // default (MEMORY_PROVIDER env).
      // Build memCfg if either provider override OR tuning override is set —
      // Q.1 (cycle 20260426_3) lets the operator tune memory per-session
      // even without overriding the provider.
      const tuning: Record<string, unknown> = {};
      const mic = memoryTuningMaxInjectChars.trim();
      if (mic) {
        const n = Number.parseInt(mic, 10);
        if (!Number.isNaN(n) && n >= 1) tuning.max_inject_chars = n;
      }
      const rt = memoryTuningRecentTurns.trim();
      if (rt) {
        const n = Number.parseInt(rt, 10);
        if (!Number.isNaN(n) && n >= 0) tuning.recent_turns = n;
      }
      if (memoryTuningEnableVector !== '') {
        tuning.enable_vector_search = memoryTuningEnableVector === 'true';
      }
      if (memoryTuningEnableReflection !== '') {
        tuning.enable_reflection = memoryTuningEnableReflection === 'true';
      }
      const hasTuning = Object.keys(tuning).length > 0;

      if (memoryProvider || hasTuning) {
        const memCfg: Record<string, unknown> = {};
        if (memoryProvider) {
          memCfg.provider = memoryProvider;
          if (memoryProvider === 'file') {
            if (memoryRoot.trim()) memCfg.root = memoryRoot.trim();
          }
          if (memoryProvider === 'sql') {
            if (memoryDsn.trim()) memCfg.dsn = memoryDsn.trim();
            if (memoryDialect) memCfg.dialect = memoryDialect;
          }
          if (memoryScope.trim()) memCfg.scope = memoryScope.trim();
          if (memoryTimezone.trim()) memCfg.timezone = memoryTimezone.trim();
        }
        if (hasTuning) memCfg.tuning = tuning;
        payload.memory_config = memCfg;
      }
      // (Sub-Worker env/prompt overrides removed 2026-06-18: the VTuber's
      // sub-agent is now an environment capability — the env declares
      // host_selections.extras.owned_subagent. Nothing per-session here.)
      // Trigger preset attach — VTuber-only. Empty selection keeps the
      // bundled defaults (current hardcoded ladder).
      if (formState.role === 'vtuber' && selectedTriggerPresetId) {
        payload.trigger_preset_id = selectedTriggerPresetId;
      }
      const session = await createSession(payload);
      // Auto-assign avatar if selected for VTuber sessions
      if (selectedAvatar && session?.session_id && formState.role === 'vtuber') {
        try {
          await assignAvatar(session.session_id, selectedAvatar);
        } catch {
          // Non-blocking: session created successfully, avatar assignment can be done later
          console.warn('Avatar assignment failed, can be assigned manually later');
        }
      }
      // Auto-assign TTS voice profile if selected for VTuber sessions
      if (selectedTtsProfile && session?.session_id && formState.role === 'vtuber') {
        try {
          await ttsApi.assignSessionProfile(session.session_id, selectedTtsProfile);
        } catch {
          console.warn('TTS profile assignment failed, can be assigned manually later');
        }
      }
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('createSession.failedToCreate'));
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-full max-w-[480px] mx-4 max-h-[85vh] flex flex-col shadow-[var(--shadow-lg)]" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex justify-between items-center py-3 md:py-4 px-4 md:px-6 border-b border-[var(--border-color)]">
          <h3 className="text-[1rem] font-semibold text-[var(--text-primary)]">{t('createSession.title')}</h3>
          <button className="flex items-center justify-center w-8 h-8 rounded-[var(--border-radius)] bg-transparent border-none text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 md:py-5 flex flex-col gap-4">
          {error && <div className="text-[0.8125rem] text-[var(--danger-color)] bg-[rgba(239,68,68,0.1)] p-2.5 rounded-[6px] mb-2">{error}</div>}

          {/* Session Name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)]">{t('createSession.sessionName')}</label>
            <input
              className="w-full py-2.5 px-3 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-[var(--border-radius)] text-[0.875rem] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] transition-[border-color] focus:outline-none focus:border-[var(--primary-color)] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.15)]"
              placeholder={t('createSession.sessionNamePlaceholder')}
              value={formState.session_name || ''} onChange={e => setFormState(f => ({ ...f, session_name: e.target.value }))} />
          </div>

          {/* Role — model is driven by the Environment manifest's
              Stage 6 (model_override or pipeline.model), NOT a session-
              level selector. Picking the model here was always
              misleading: it only tagged the session record for display
              while the actual LLM call routed through the env's
              manifest. Removed in PR for env-driven single-source-of-
              truth. To change the model, edit the env. */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)]">{t('createSession.role')}</label>
            <Selector
              variant="field"
              ariaLabel={t('createSession.role')}
              value={formState.role ?? 'developer'}
              onChange={handleRoleChange}
              items={[
                { id: 'developer', label: t('createSession.roleDeveloper') },
                { id: 'worker', label: t('createSession.roleWorker') },
                { id: 'researcher', label: t('createSession.roleResearcher') },
                { id: 'planner', label: t('createSession.rolePlanner') },
                { id: 'vtuber', label: t('createSession.roleVTuber') },
              ] as SelectorItem[]}
            />
          </div>

          {/* Avatar (VTuber only) */}
          {formState.role === 'vtuber' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">{t('createSession.avatar')} <InfoTooltip text={t('createSession.avatarHelp')} /></label>
              <Selector
                variant="field"
                ariaLabel={t('createSession.avatar')}
                value={selectedAvatar}
                onChange={setSelectedAvatar}
                items={[
                  { id: '', label: avatarsLoaded ? t('createSession.avatarNone') : t('createSession.avatarLoading') },
                  ...avatarModels.map(m => ({ id: m.name, label: m.display_name || m.name })),
                ]}
              />
            </div>
          )}

          {/* TTS Voice Profile (VTuber only) */}
          {formState.role === 'vtuber' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">{t('createSession.ttsProfile')} <InfoTooltip text={t('createSession.ttsProfileHelp')} /></label>
              {ttsProfilesLoaded && !ttsEnabled ? (
                <div className="w-full py-2.5 px-3 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-[var(--border-radius)] text-[0.8125rem] text-[var(--text-muted)] opacity-60">
                  {t('createSession.ttsDisabled')}
                </div>
              ) : (
                <Selector
                  variant="field"
                  ariaLabel={t('createSession.ttsProfile')}
                  value={selectedTtsProfile}
                  onChange={setSelectedTtsProfile}
                  items={[
                    { id: '', label: ttsProfilesLoaded ? t('createSession.ttsProfileNone') : t('createSession.ttsProfileLoading') },
                    ...ttsProfiles.map(p => ({ id: p.name, label: p.display_name || p.name })),
                  ]}
                />
              )}
            </div>
          )}

          {/* Trigger Preset (VTuber only) — bound at session creation,
              swappable later via PUT /api/agents/{id}/trigger-preset.
              When unset the runtime falls back to the bundled default
              ladder, which is the historical hardcoded behaviour. */}
          {formState.role === 'vtuber' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">
                트리거 프리셋
                <InfoTooltip text="VTuber 자가 발화의 페이즈/카테고리/프롬프트를 정의한 프리셋. 미선택 시 기본 동작으로 작동하며, '트리거 관리' 탭에서 새로 만들 수 있어요." />
              </label>
              <Selector
                variant="field"
                ariaLabel="트리거 프리셋"
                value={selectedTriggerPresetId}
                onChange={setSelectedTriggerPresetId}
                items={[
                  { id: '', label: '기본 트리거 (내장)' },
                  ...triggerPresets.map(p => ({
                    id: p.id,
                    label: `${p.enabled ? '⚡' : '⏸'} ${p.name}`,
                    group: '내 프리셋',
                  })),
                ]}
              />
              {selectedTriggerPresetId ? (
                <small className="text-[0.75rem] text-[var(--text-muted)] mt-0.5">
                  {triggerPresets.find(p => p.id === selectedTriggerPresetId)?.description || ''}
                </small>
              ) : (
                <small className="text-[0.75rem] text-[var(--text-muted)] mt-0.5">
                  미선택 시 내장된 기본 페이즈/확률/프롬프트를 사용합니다.
                </small>
              )}
            </div>
          )}

          {/* Prompt Template — hidden for VTuber (moved into VTuber sections) */}
          {formState.role !== 'vtuber' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">{t('createSession.promptTemplate')} <InfoTooltip text={t('createSession.promptTemplateHelp')} /></label>
              <Selector
                variant="field"
                ariaLabel={t('createSession.promptTemplate')}
                value={selectedPrompt}
                onChange={handlePromptChange}
                items={[
                  { id: '', label: t('createSession.templateNone') },
                  ...generalPrompts.map(p => ({ id: p.name, label: p.name })),
                ]}
              />
            </div>
          )}

          {/* Timeout + Max Iterations
              ``max_turns`` removed (2026-04-26): with env-driven pipelines
              "turn" reduces to "one chat message" governed by the chat
              layer, not the executor pipeline. The field was advisory-
              only (display + log) and gave operators a misleading
              control. The per-invoke iteration cap lives on
              ``max_iterations`` (B.1, cycle 20260426_1). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">{t('createSession.timeout')} <InfoTooltip text={t('createSession.timeoutHelp')} /></label>
              <NumberStepper value={formState.timeout ?? 21600} onChange={v => setFormState(f => ({ ...f, timeout: v }))} min={10} max={86400} step={60} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">{t('createSession.maxIterations')} <InfoTooltip text={t('createSession.maxIterationsHelp')} /></label>
              <NumberStepper value={formState.max_iterations ?? 30} onChange={v => setFormState(f => ({ ...f, max_iterations: v }))} min={1} max={500} step={5} />
            </div>
          </div>

          {/* Tool Preset */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">
              {t('createSession.toolPreset')} <InfoTooltip text={t('createSession.toolPresetHelp')} />
            </label>
            <Selector
              variant="field"
              ariaLabel={t('createSession.toolPreset')}
              value={selectedPreset}
              onChange={setSelectedPreset}
              items={[
                { id: '', label: 'Default (based on role)' },
                ...toolPresets.filter(p => p.is_template).map(p => ({
                  id: p.id,
                  label: `${p.icon || '🔧'} ${p.name}`,
                  group: 'Templates',
                })),
                ...toolPresets.filter(p => !p.is_template).map(p => ({
                  id: p.id,
                  label: `${p.icon || '🔧'} ${p.name}`,
                  group: 'Custom',
                })),
              ]}
            />
            <small className="text-[0.75rem] text-[var(--text-muted)] mt-0.5">
              {(() => {
                if (!selectedPreset) return 'Automatically selects the best preset for the chosen role.';
                const p = toolPresets.find(tp => tp.id === selectedPreset);
                return p?.description || '';
              })()}
            </small>
          </div>

          {/* Environment (v2 EnvironmentManifest) — optional. When set,
              backend swaps the legacy preset pipeline for the manifest's
              Pipeline + tools snapshot. */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">
              {t('createSession.environment')}
              <InfoTooltip text={t('createSession.environmentHelp')} />
            </label>
            <Selector
              variant="field"
              ariaLabel={t('createSession.environment')}
              value={selectedEnvId}
              onChange={setSelectedEnvId}
              items={[
                {
                  id: '',
                  label:
                    environmentsLoading && environments.length === 0
                      ? t('createSession.environmentLoading')
                      : t('createSession.environmentNone'),
                },
                ...environments.map(env => ({ id: env.id, label: env.name })),
              ]}
            />
            <small className="text-[0.75rem] text-[var(--text-muted)] mt-0.5">
              {(() => {
                if (!selectedEnvId) return t('createSession.environmentLegacy');
                const env = environments.find(e => e.id === selectedEnvId);
                return env?.description || t('createSession.environmentSelected');
              })()}
            </small>
          </div>

          {/* Memory provider override (advanced, collapsible) */}
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setShowMemoryAdvanced(v => !v)}
              className="flex items-center justify-between gap-2 py-1 text-left bg-transparent border-none text-[0.8125rem] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                {t('createSession.memoryOverride')}
                <InfoTooltip text={t('createSession.memoryOverrideHelp')} />
              </span>
              <span className="text-[0.75rem] text-[var(--text-muted)]">
                {showMemoryAdvanced ? t('createSession.memoryHide') : t('createSession.memoryShow')}
              </span>
            </button>
            {showMemoryAdvanced && (
              <div className="flex flex-col gap-3 p-3 rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)]">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">
                    {t('createSession.memoryProvider')}
                  </label>
                  <Selector
                    variant="field"
                    ariaLabel={t('createSession.memoryProvider')}
                    value={memoryProvider}
                    onChange={v => setMemoryProvider(v as typeof memoryProvider)}
                    items={[
                      { id: '', label: t('createSession.memoryProviderDefault') },
                      { id: 'disabled', label: t('createSession.memoryProviderDisabled') },
                      { id: 'ephemeral', label: t('createSession.memoryProviderEphemeral') },
                      { id: 'file', label: t('createSession.memoryProviderFile') },
                      { id: 'sql', label: t('createSession.memoryProviderSql') },
                    ] as SelectorItem[]}
                  />
                </div>

                {memoryProvider === 'file' && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">
                      {t('createSession.memoryRoot')}
                    </label>
                    <input
                      className="w-full py-2 px-3 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--border-radius)] text-[0.8125rem] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary-color)]"
                      placeholder="/var/lib/geny/memory"
                      value={memoryRoot}
                      onChange={e => setMemoryRoot(e.target.value)}
                    />
                    <small className="text-[0.6875rem] text-[var(--text-muted)]">
                      {t('createSession.memoryRootHelp')}
                    </small>
                  </div>
                )}

                {memoryProvider === 'sql' && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">
                        {t('createSession.memoryDsn')}
                      </label>
                      <input
                        className="w-full py-2 px-3 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--border-radius)] text-[0.8125rem] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary-color)]"
                        placeholder="sqlite:///./data/memory.db"
                        value={memoryDsn}
                        onChange={e => setMemoryDsn(e.target.value)}
                      />
                      <small className="text-[0.6875rem] text-[var(--text-muted)]">
                        {t('createSession.memoryDsnHelp')}
                      </small>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">
                        {t('createSession.memoryDialect')}
                      </label>
                      <Selector
                        variant="field"
                        ariaLabel={t('createSession.memoryDialect')}
                        value={memoryDialect}
                        onChange={v => setMemoryDialect(v as typeof memoryDialect)}
                        items={[
                          { id: '', label: t('createSession.memoryDialectAuto') },
                          { id: 'sqlite', label: 'sqlite' },
                          { id: 'postgres', label: 'postgres' },
                        ] as SelectorItem[]}
                      />
                    </div>
                  </>
                )}

                {memoryProvider && memoryProvider !== 'disabled' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">
                        {t('createSession.memoryScope')}
                      </label>
                      <input
                        className="w-full py-2 px-3 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--border-radius)] text-[0.8125rem] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary-color)]"
                        placeholder="session"
                        value={memoryScope}
                        onChange={e => setMemoryScope(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[0.75rem] font-medium text-[var(--text-secondary)]">
                        {t('createSession.memoryTimezone')}
                      </label>
                      <input
                        className="w-full py-2 px-3 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--border-radius)] text-[0.8125rem] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary-color)]"
                        placeholder="Asia/Seoul"
                        value={memoryTimezone}
                        onChange={e => setMemoryTimezone(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {/* Q.1 (cycle 20260426_3) — per-session tuning override.
                    Always available (independent of provider override) so
                    operators tuning recall behavior without changing the
                    storage backend can still use it. */}
                <div className="mt-3 pt-3 border-t border-[var(--border-color)]">
                  <button
                    type="button"
                    onClick={() => setMemoryTuningOpen(o => !o)}
                    className="text-[0.75rem] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5"
                  >
                    <span>{memoryTuningOpen ? '▾' : '▸'}</span>
                    {t('createSession.memoryTuningHeader')}
                  </button>
                  {memoryTuningOpen && (
                    <div className="mt-2 grid grid-cols-2 gap-2.5">
                      <div className="flex flex-col gap-1">
                        <label className="text-[0.6875rem] font-medium text-[var(--text-secondary)]">
                          max_inject_chars
                        </label>
                        <input
                          className="w-full py-1.5 px-2.5 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded text-[0.75rem] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary-color)]"
                          placeholder="(global)"
                          inputMode="numeric"
                          value={memoryTuningMaxInjectChars}
                          onChange={e => setMemoryTuningMaxInjectChars(e.target.value)}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[0.6875rem] font-medium text-[var(--text-secondary)]">
                          recent_turns
                        </label>
                        <input
                          className="w-full py-1.5 px-2.5 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded text-[0.75rem] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary-color)]"
                          placeholder="(global)"
                          inputMode="numeric"
                          value={memoryTuningRecentTurns}
                          onChange={e => setMemoryTuningRecentTurns(e.target.value)}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[0.6875rem] font-medium text-[var(--text-secondary)]">
                          enable_vector_search
                        </label>
                        <Selector
                          variant="field"
                          ariaLabel="enable_vector_search"
                          value={memoryTuningEnableVector}
                          onChange={v => setMemoryTuningEnableVector(v as typeof memoryTuningEnableVector)}
                          items={[
                            { id: '', label: '(global)' },
                            { id: 'true', label: 'true' },
                            { id: 'false', label: 'false' },
                          ] as SelectorItem[]}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[0.6875rem] font-medium text-[var(--text-secondary)]">
                          enable_reflection
                        </label>
                        <Selector
                          variant="field"
                          ariaLabel="enable_reflection"
                          value={memoryTuningEnableReflection}
                          onChange={v => setMemoryTuningEnableReflection(v as typeof memoryTuningEnableReflection)}
                          items={[
                            { id: '', label: '(global)' },
                            { id: 'true', label: 'true' },
                            { id: 'false', label: 'false' },
                          ] as SelectorItem[]}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* System Prompt — VTuber mode shows dual prompts with template selectors */}
          {formState.role === 'vtuber' ? (
            <>
              {/* VTuber Persona Prompt */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">{t('createSession.vtuberPromptLabel')} <InfoTooltip text={t('createSession.vtuberPromptHelp')} /></label>
                <Selector
                  variant="field"
                  ariaLabel={t('createSession.vtuberPromptLabel')}
                  value={selectedPrompt}
                  onChange={handlePromptChange}
                  items={[
                    { id: '', label: t('createSession.templateNone') },
                    ...vtuberPrompts.map(p => ({ id: p.name, label: p.name })),
                  ]}
                />
                <textarea className="w-full py-2.5 px-3 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-[var(--border-radius)] text-[0.875rem] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] transition-[border-color] focus:outline-none focus:border-[var(--primary-color)] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.15)] resize-y" rows={4} placeholder={t('createSession.systemPromptPlaceholder')}
                  value={formState.system_prompt || ''} onChange={e => setFormState(f => ({ ...f, system_prompt: e.target.value }))} />
              </div>
              {/* Sub-Worker prompt / env fields removed (2026-06-18 cutover):
                  the VTuber's sub-agent is now an ENVIRONMENT capability —
                  the env declares host_selections.extras.owned_subagent and
                  the executor builds it. Configure the sub-agent via the
                  environment, not per-session here. */}
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.8125rem] font-medium text-[var(--text-secondary)] inline-flex items-center gap-1.5">{t('createSession.systemPrompt')} <InfoTooltip text={t('createSession.systemPromptHelp')} /></label>
              <textarea className="w-full py-2.5 px-3 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-[var(--border-radius)] text-[0.875rem] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] transition-[border-color] focus:outline-none focus:border-[var(--primary-color)] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.15)] resize-y" rows={4} placeholder={t('createSession.systemPromptPlaceholder')}
                value={formState.system_prompt || ''} onChange={e => setFormState(f => ({ ...f, system_prompt: e.target.value }))} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end items-center gap-3 py-3 md:py-4 px-4 md:px-6 border-t border-[var(--border-color)]">
          <button className="py-2 px-4 bg-transparent hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] text-[0.8125rem] font-medium rounded-[var(--border-radius)] cursor-pointer transition-all duration-150 border border-[var(--border-color)]" onClick={onClose}>{t('common.cancel')}</button>
          <button className="py-2 px-4 bg-[var(--primary-color)] hover:bg-[var(--primary-hover)] text-white text-[0.8125rem] font-medium rounded-[var(--border-radius)] cursor-pointer transition-all duration-150 border-none disabled:opacity-50 disabled:cursor-not-allowed" onClick={handleSubmit} disabled={submitting}>
            {submitting ? t('createSession.creating') : t('createSession.createSession')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
