'use client';

/**
 * TriggerPresetEditor — section-driven editor for one trigger preset.
 *
 * Cycle 20260507 redesign — replaced the long vertical stack with a
 * StageProgressBar-style section navigator. Five sections are
 * surfaced as numbered nodes on a top bar; clicking one swaps the
 * body to a focused workspace for that section.
 *
 *   ┌─ TriggerFormShell ─────────────────────────────────────────────┐
 *   │  hero (icon · title · subtitle)               [Discard] [Back]│
 *   │  ─ TriggerSectionBar ──────────────────────────────────────── │
 *   │   ◯ 메타 ── ◯ 타이밍 ── ◯ 시간대 ── ◯ 페이즈 ── ◯ 카테고리      │
 *   │  ──────────────────────────────────────────────────────────── │
 *   │   {active section body — full-bleed, breathing room}           │
 *   │                                                                │
 *   ├─ sticky footer ────────────────────────────────────────────────┤
 *   │  [Cancel]                                       [Save]        │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Save flow:
 *   create → POST /api/trigger-presets  (with full manifest)
 *   edit   → PATCH metadata  +  PUT /manifest  (idempotent, two calls)
 *
 * Live reload contract: backend bumps a version counter on every
 * write, and :class:`ThinkingTriggerService` re-reads the cached
 * manifest on its next tick. Saves are visible to running sessions
 * within one tick (~30 s) without restart.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Boxes,
  Clock,
  Layers,
  Plus,
  Save,
  Sun,
  Tag,
  Zap,
} from 'lucide-react';

import { RegistryFormShell } from '@/components/env_management/registry';
import { triggerPresetApi } from '@/lib/triggerPresetApi';
import type {
  CategoryConditions,
  PhaseEvent,
  TriggerCategory,
  TriggerKind,
  TriggerPhase,
  TriggerPresetDetail,
  TriggerPresetManifest,
  TriggerPresetSummary,
  TimeWindow,
} from '@/types/triggerPreset';

import PhaseEditor from './PhaseEditor';
import CategoryEditor from './CategoryEditor';
import ScenarioBar from './ScenarioBar';
import TriggerSectionBar, {
  type TriggerSectionDef,
} from './TriggerSectionBar';
import {
  categoryReferences,
  currentTimeWindow,
  type RuntimeScenario,
} from './triggerSimulator';

// ── Section identifiers ──────────────────────────────────────────

type SectionId =
  | 'metadata'
  | 'timing'
  | 'time_boundaries'
  | 'phases'
  | 'categories';

// ── Helpers ──────────────────────────────────────────────────────

function freshId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now()
    .toString(36)
    .slice(-4)}`;
}

function emptyManifest(): TriggerPresetManifest {
  return {
    enabled: true,
    timing: {
      base_idle_seconds: 120,
      max_idle_seconds: 3600,
      tick_interval_seconds: 30,
      sub_worker_working_cooldown_seconds: 90,
      adaptive_scale_triggers: 20,
    },
    time_boundaries: {
      morning_start: 6,
      afternoon_start: 12,
      evening_start: 18,
      night_start: 22,
    },
    phases: [],
    categories: [],
  };
}

function cloneManifest(src: TriggerPresetManifest): TriggerPresetManifest {
  return JSON.parse(JSON.stringify(src)) as TriggerPresetManifest;
}

// ── Component ─────────────────────────────────────────────────────

export interface TriggerPresetEditorProps {
  mode: 'create' | 'edit';
  /** Seed manifest — defaults for create, current detail for edit. */
  seed: TriggerPresetDetail | null;
  /** List-view summary for the edited preset (used in the title). */
  existingSummary?: TriggerPresetSummary;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export default function TriggerPresetEditor({
  mode,
  seed,
  existingSummary,
  onClose,
  onSaved,
}: TriggerPresetEditorProps) {
  // ── Form state ────────────────────────────────────────────────
  const [name, setName] = useState(
    mode === 'create' ? '' : (seed?.name ?? existingSummary?.name ?? ''),
  );
  const [description, setDescription] = useState(
    mode === 'create' ? '' : (seed?.description ?? ''),
  );
  const [tagsInput, setTagsInput] = useState(
    mode === 'create' ? '' : (seed?.tags?.join(', ') ?? ''),
  );
  const [manifest, setManifest] = useState<TriggerPresetManifest>(() =>
    seed?.manifest ? cloneManifest(seed.manifest) : emptyManifest(),
  );

  const [section, setSection] = useState<SectionId>('metadata');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  // Scenario for the phase preview — defaults to "auto" (current
  // KST time window + sub-worker idle, consec=0) so the operator
  // sees a sensible baseline. They can switch axes in ScenarioBar.
  const [scenario, setScenario] = useState<RuntimeScenario>(() => ({
    consecutive: 0,
    subWorker: 'idle',
    timeWindow: currentTimeWindow(
      seed?.manifest ? cloneManifest(seed.manifest) : emptyManifest(),
    ),
    honourCooldowns: false,
  }));

  // Cross-section navigation: phase row → categories tab focusing on
  // a specific category, and vice versa.
  const [focusCategoryId, setFocusCategoryId] = useState<string | null>(null);
  const [focusPhaseId, setFocusPhaseId] = useState<string | null>(null);

  // Re-seed on prop change.
  useEffect(() => {
    if (seed?.manifest) {
      setManifest(cloneManifest(seed.manifest));
      if (mode === 'edit') {
        setName(seed.name);
        setDescription(seed.description);
        setTagsInput(seed.tags.join(', '));
      }
      dirtyRef.current = false;
    }
  }, [seed, mode]);

  const updateManifest = useCallback(
    (
      next:
        | TriggerPresetManifest
        | ((prev: TriggerPresetManifest) => TriggerPresetManifest),
    ) => {
      dirtyRef.current = true;
      setManifest((prev) =>
        typeof next === 'function'
          ? (next as (p: TriggerPresetManifest) => TriggerPresetManifest)(prev)
          : next,
      );
    },
    [],
  );

  const updateName = useCallback((v: string) => {
    dirtyRef.current = true;
    setName(v);
  }, []);
  const updateDescription = useCallback((v: string) => {
    dirtyRef.current = true;
    setDescription(v);
  }, []);
  const updateTagsInput = useCallback((v: string) => {
    dirtyRef.current = true;
    setTagsInput(v);
  }, []);

  // ── Computed ──────────────────────────────────────────────────

  const tagList = useMemo(
    () =>
      tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    [tagsInput],
  );

  // Reverse references — used by the categories tab + the simulator.
  const references = useMemo(
    () => categoryReferences(manifest),
    [manifest],
  );

  // Phase shortcuts surfaced on the scenario bar so the operator can
  // jump to the lower bound of each phase with one click.
  const phaseShortcuts = useMemo(
    () =>
      manifest.phases.map((p) => ({
        label: p.label || `phase ${p.min_consecutive}+`,
        consecutive: p.min_consecutive,
      })),
    [manifest.phases],
  );

  // ── Validation flags surfaced as red dots on the section bar ──

  const validation = useMemo(() => {
    const phasesNoEvents = manifest.phases.filter(
      (p) => p.events.length === 0,
    ).length;
    const phasesZeroWeight = manifest.phases.filter(
      (p) =>
        p.events.length > 0 &&
        p.events.every((e) => e.weight <= 0),
    ).length;

    const orphanRefs: string[] = [];
    const knownIds = new Set(manifest.categories.map((c) => c.id));
    for (const p of manifest.phases) {
      for (const ev of p.events) {
        if (!knownIds.has(ev.category_id)) orphanRefs.push(ev.category_id);
      }
    }

    const dupeCategoryIds =
      manifest.categories.length !==
      new Set(manifest.categories.map((c) => c.id)).size;

    const noPrompts = manifest.categories.filter(
      (c) =>
        Object.values(c.prompts).reduce(
          (sum, list) => sum + (list?.length ?? 0),
          0,
        ) === 0,
    ).length;

    return {
      metadata: !name.trim(),
      timing:
        manifest.timing.base_idle_seconds <= 0 ||
        manifest.timing.max_idle_seconds < manifest.timing.base_idle_seconds,
      time_boundaries: false, // hours are clamped 0–23 at input
      phases:
        manifest.phases.length === 0 ||
        phasesNoEvents > 0 ||
        phasesZeroWeight > 0 ||
        orphanRefs.length > 0,
      categories: dupeCategoryIds || (manifest.categories.length > 0 && noPrompts === manifest.categories.length),
      // Diagnostic notes surfaced inline on the relevant section.
      _details: {
        phasesNoEvents,
        phasesZeroWeight,
        orphanRefs,
        noPromptsCount: noPrompts,
        dupeCategoryIds,
      },
    };
  }, [manifest, name]);

  // ── Phase actions ─────────────────────────────────────────────

  const addPhase = useCallback(() => {
    updateManifest((prev) => {
      const last = prev.phases[prev.phases.length - 1];
      const minNext = last
        ? (last.max_consecutive ?? last.min_consecutive) + 1
        : 0;
      const newPhase: TriggerPhase = {
        id: freshId('phase'),
        label: '새 페이즈',
        min_consecutive: minNext,
        max_consecutive: null,
        events: [],
      };
      const phases = prev.phases.map((p, i) =>
        i === prev.phases.length - 1 && p.max_consecutive === null
          ? { ...p, max_consecutive: minNext - 1 }
          : p,
      );
      return { ...prev, phases: [...phases, newPhase] };
    });
  }, [updateManifest]);

  const updatePhase = useCallback(
    (phaseId: string, patch: Partial<TriggerPhase>) => {
      updateManifest((prev) => ({
        ...prev,
        phases: prev.phases.map((p) =>
          p.id === phaseId ? { ...p, ...patch } : p,
        ),
      }));
    },
    [updateManifest],
  );

  const removePhase = useCallback(
    (phaseId: string) => {
      updateManifest((prev) => ({
        ...prev,
        phases: prev.phases.filter((p) => p.id !== phaseId),
      }));
    },
    [updateManifest],
  );

  const movePhase = useCallback(
    (phaseId: string, dir: -1 | 1) => {
      updateManifest((prev) => {
        const idx = prev.phases.findIndex((p) => p.id === phaseId);
        if (idx < 0) return prev;
        const next = idx + dir;
        if (next < 0 || next >= prev.phases.length) return prev;
        const phases = [...prev.phases];
        [phases[idx], phases[next]] = [phases[next], phases[idx]];
        return { ...prev, phases };
      });
    },
    [updateManifest],
  );

  const setPhaseEvents = useCallback(
    (phaseId: string, events: PhaseEvent[]) => {
      updateManifest((prev) => ({
        ...prev,
        phases: prev.phases.map((p) =>
          p.id === phaseId ? { ...p, events } : p,
        ),
      }));
    },
    [updateManifest],
  );

  // ── Category actions ──────────────────────────────────────────

  const addCategory = useCallback(() => {
    updateManifest((prev) => {
      const id = freshId('cat');
      const newCat: TriggerCategory = {
        id,
        label: '새 카테고리',
        kind: 'thinking',
        conditions: {},
        cooldown_seconds: 0,
        prompts: { en: [], ko: [] },
      };
      return { ...prev, categories: [...prev.categories, newCat] };
    });
  }, [updateManifest]);

  const updateCategory = useCallback(
    (catId: string, patch: Partial<TriggerCategory>) => {
      updateManifest((prev) => ({
        ...prev,
        categories: prev.categories.map((c) =>
          c.id === catId ? { ...c, ...patch } : c,
        ),
      }));
    },
    [updateManifest],
  );

  const removeCategory = useCallback(
    (catId: string) => {
      updateManifest((prev) => ({
        ...prev,
        categories: prev.categories.filter((c) => c.id !== catId),
        phases: prev.phases.map((p) => ({
          ...p,
          events: p.events.filter((e) => e.category_id !== catId),
        })),
      }));
    },
    [updateManifest],
  );

  // ── Save ──────────────────────────────────────────────────────

  const onSave = useCallback(async () => {
    setError(null);
    if (!name.trim()) {
      setSection('metadata');
      setError('이름을 입력해주세요.');
      return;
    }
    setSaving(true);
    try {
      if (mode === 'create') {
        await triggerPresetApi.create({
          name: name.trim(),
          description,
          tags: tagList,
          manifest,
        });
      } else if (seed?.id) {
        await triggerPresetApi.replaceManifest(seed.id, manifest);
        await triggerPresetApi.patch(seed.id, {
          name: name.trim(),
          description,
          tags: tagList,
        });
      }
      dirtyRef.current = false;
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [description, manifest, mode, name, onSaved, seed?.id, tagList]);

  const requestClose = useCallback(() => {
    if (dirtyRef.current) {
      const ok = window.confirm(
        '저장하지 않은 변경사항이 있어요. 그래도 닫을까요?',
      );
      if (!ok) return;
    }
    onClose();
  }, [onClose]);

  // ── Section definitions for the top bar ───────────────────────

  const sections: TriggerSectionDef<SectionId>[] = useMemo(
    () => [
      {
        id: 'metadata',
        label: '메타데이터',
        icon: Tag,
        hint: '프리셋 이름과 마스터 스위치',
        hasIssue: validation.metadata,
      },
      {
        id: 'timing',
        label: '타이밍',
        icon: Clock,
        hint: '침묵 임계값과 적응형 백오프',
        hasIssue: validation.timing,
      },
      {
        id: 'time_boundaries',
        label: '시간대 경계',
        icon: Sun,
        hint: '아침 / 오후 / 저녁 / 밤 시작 시각',
      },
      {
        id: 'phases',
        label: '페이즈',
        icon: Layers,
        hint: '연속 트리거 횟수별 확률 매트릭스',
        badge: `${manifest.phases.length}개`,
        hasIssue: validation.phases,
      },
      {
        id: 'categories',
        label: '카테고리',
        icon: Boxes,
        hint: '발사 가능한 이벤트와 프롬프트',
        badge: `${manifest.categories.length}개`,
        hasIssue: validation.categories,
      },
    ],
    [
      manifest.categories.length,
      manifest.phases.length,
      validation.categories,
      validation.metadata,
      validation.phases,
      validation.timing,
    ],
  );

  const activeSection = sections.find((s) => s.id === section) ?? sections[0];

  // ── Render ────────────────────────────────────────────────────

  return (
    <RegistryFormShell
      icon={Zap}
      title={
        mode === 'create' ? '새 트리거 프리셋' : `편집: ${name || '이름 없음'}`
      }
      subtitle={
        mode === 'create'
          ? '현재 기본 동작과 동일한 페이즈/카테고리/프롬프트가 미리 채워져 있어요. 아래 섹션을 골라 필요한 부분만 조정하세요.'
          : '저장하면 이 프리셋을 부착한 모든 VTuber 세션에 다음 틱(약 30초)부터 자동 반영됩니다.'
      }
      backLabel="목록으로"
      onBack={requestClose}
      error={error}
      onDismissError={() => setError(null)}
      footer={
        <>
          <button
            type="button"
            onClick={requestClose}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md border border-[hsl(var(--border))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            취소
          </button>
          <div className="hidden sm:flex items-center gap-1.5 mx-3 text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500/70" />
            현재 섹션: <span className="font-medium text-[hsl(var(--foreground))]">{activeSection.label}</span>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-violet-500 text-white text-[0.8125rem] font-medium hover:bg-violet-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      {/* ── Section navigator ── */}
      <div className="-mx-6">
        <TriggerSectionBar
          sections={sections}
          selected={section}
          onSelect={(id) => setSection(id)}
        />
      </div>

      {/* ── Section header (active section's title + hint) ── */}
      <SectionHeader section={activeSection} />

      {/* ── Section body ── */}
      {section === 'metadata' && (
        <MetadataSection
          name={name}
          description={description}
          tagsInput={tagsInput}
          enabled={manifest.enabled}
          onName={updateName}
          onDescription={updateDescription}
          onTagsInput={updateTagsInput}
          onEnabled={(enabled) =>
            updateManifest({ ...manifest, enabled })
          }
        />
      )}

      {section === 'timing' && (
        <TimingSection
          manifest={manifest}
          onChange={(timing) =>
            updateManifest({ ...manifest, timing })
          }
        />
      )}

      {section === 'time_boundaries' && (
        <TimeBoundariesSection
          manifest={manifest}
          onChange={(time_boundaries) =>
            updateManifest({ ...manifest, time_boundaries })
          }
        />
      )}

      {section === 'phases' && (
        <PhasesSection
          manifest={manifest}
          scenario={scenario}
          onScenarioChange={setScenario}
          phaseShortcuts={phaseShortcuts}
          focusPhaseId={focusPhaseId}
          onAdd={addPhase}
          onPatch={updatePhase}
          onRemove={removePhase}
          onMove={movePhase}
          onSetEvents={setPhaseEvents}
          onJumpToCategory={(categoryId) => {
            setFocusCategoryId(categoryId);
            setSection('categories');
          }}
          onJumpToCategoriesTab={() => setSection('categories')}
          missingCategories={validation._details.orphanRefs}
        />
      )}

      {section === 'categories' && (
        <CategoriesSection
          categories={manifest.categories}
          references={references}
          focusCategoryId={focusCategoryId}
          onAdd={addCategory}
          onPatch={updateCategory}
          onRemove={removeCategory}
          onJumpToPhase={(phaseId) => {
            setFocusPhaseId(phaseId);
            setSection('phases');
          }}
        />
      )}
    </RegistryFormShell>
  );
}

// ── Section header ─────────────────────────────────────────────

function SectionHeader({
  section,
}: {
  section: TriggerSectionDef<SectionId>;
}) {
  const Icon = section.icon;
  return (
    <div className="flex items-start gap-3 px-1">
      <div className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[hsl(var(--primary)/0.1)] shrink-0 mt-0.5">
        <Icon className="w-4 h-4 text-[hsl(var(--primary))]" strokeWidth={2.25} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h3 className="text-[1.0625rem] font-semibold text-[hsl(var(--foreground))]">
            {section.label}
          </h3>
          {section.badge && (
            <span className="text-[0.75rem] tabular-nums text-[hsl(var(--muted-foreground))]">
              {section.badge}
            </span>
          )}
        </div>
        {section.hint && (
          <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] leading-relaxed mt-0.5">
            {section.hint}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Per-section bodies ─────────────────────────────────────────

function MetadataSection({
  name,
  description,
  tagsInput,
  enabled,
  onName,
  onDescription,
  onTagsInput,
  onEnabled,
}: {
  name: string;
  description: string;
  tagsInput: string;
  enabled: boolean;
  onName: (v: string) => void;
  onDescription: (v: string) => void;
  onTagsInput: (v: string) => void;
  onEnabled: (v: boolean) => void;
}) {
  return (
    <BodyCard>
      <FormRow label="이름" required>
        <input
          type="text"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="예: 차분한 오후 페르소나"
          className={INPUT_CLS}
        />
      </FormRow>
      <FormRow label="설명">
        <textarea
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          rows={2}
          placeholder="이 프리셋이 어떤 분위기인지 메모"
          className={`${INPUT_CLS} resize-y min-h-[60px]`}
        />
      </FormRow>
      <FormRow
        label="태그"
        hint="쉼표로 구분. preset 태그는 공유 프리셋 섹션에 표시됩니다."
      >
        <input
          type="text"
          value={tagsInput}
          onChange={(e) => onTagsInput(e.target.value)}
          placeholder="preset, vtuber, calm"
          className={INPUT_CLS}
        />
      </FormRow>
      <FormRow label="활성화">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabled(e.target.checked)}
            className="w-4 h-4 accent-violet-500"
          />
          <span className="text-[0.8125rem] text-[hsl(var(--foreground))]">
            {enabled
              ? '이 프리셋이 부착된 세션에 트리거가 발사됩니다'
              : '비활성화 — 부착된 세션은 자가 발화하지 않습니다'}
          </span>
        </label>
      </FormRow>
    </BodyCard>
  );
}

function TimingSection({
  manifest,
  onChange,
}: {
  manifest: TriggerPresetManifest;
  onChange: (timing: TriggerPresetManifest['timing']) => void;
}) {
  const t = manifest.timing;
  return (
    <BodyCard>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <NumericField
          label="기본 침묵 시간 (초)"
          hint="이 시간이 지나면 첫 트리거가 발사됩니다."
          value={t.base_idle_seconds}
          min={5}
          step={5}
          onChange={(v) => onChange({ ...t, base_idle_seconds: v })}
        />
        <NumericField
          label="최대 침묵 시간 (초)"
          hint="연속 트리거가 누적될수록 임계값이 이 값으로 수렴합니다."
          value={t.max_idle_seconds}
          min={t.base_idle_seconds}
          step={60}
          onChange={(v) => onChange({ ...t, max_idle_seconds: v })}
        />
        <NumericField
          label="틱 주기 (초)"
          hint="스캔 주기 — 짧을수록 반응이 빠르지만 부하가 늘어납니다."
          value={t.tick_interval_seconds}
          min={5}
          step={5}
          onChange={(v) => onChange({ ...t, tick_interval_seconds: v })}
        />
        <NumericField
          label="Sub-Worker 진행 중 쿨다운 (초)"
          hint="Sub-Worker가 작업 중일 때 'still working' 메시지가 반복되지 않도록 억제합니다."
          value={t.sub_worker_working_cooldown_seconds}
          min={0}
          step={10}
          onChange={(v) =>
            onChange({ ...t, sub_worker_working_cooldown_seconds: v })
          }
        />
        <NumericField
          label="적응형 스케일 트리거 수"
          hint="이 횟수만큼 트리거가 누적되면 임계값이 최대치에 도달합니다 (log scale)."
          value={t.adaptive_scale_triggers}
          min={1}
          step={1}
          onChange={(v) => onChange({ ...t, adaptive_scale_triggers: v })}
        />
      </div>
    </BodyCard>
  );
}

function TimeBoundariesSection({
  manifest,
  onChange,
}: {
  manifest: TriggerPresetManifest;
  onChange: (tb: TriggerPresetManifest['time_boundaries']) => void;
}) {
  const tb = manifest.time_boundaries;
  return (
    <BodyCard>
      <p className="text-[0.8125rem] text-[hsl(var(--muted-foreground))] -mt-1">
        time_window 조건이 어느 시간대를 morning/afternoon/evening/night 으로
        인식할지 (KST 기준).
      </p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <HourField
          label="아침 시작"
          value={tb.morning_start}
          onChange={(v) => onChange({ ...tb, morning_start: v })}
        />
        <HourField
          label="오후 시작"
          value={tb.afternoon_start}
          onChange={(v) => onChange({ ...tb, afternoon_start: v })}
        />
        <HourField
          label="저녁 시작"
          value={tb.evening_start}
          onChange={(v) => onChange({ ...tb, evening_start: v })}
        />
        <HourField
          label="밤 시작"
          value={tb.night_start}
          onChange={(v) => onChange({ ...tb, night_start: v })}
        />
      </div>
    </BodyCard>
  );
}

function PhasesSection({
  manifest,
  scenario,
  onScenarioChange,
  phaseShortcuts,
  focusPhaseId,
  onAdd,
  onPatch,
  onRemove,
  onMove,
  onSetEvents,
  onJumpToCategory,
  onJumpToCategoriesTab,
  missingCategories,
}: {
  manifest: TriggerPresetManifest;
  scenario: RuntimeScenario;
  onScenarioChange: (s: RuntimeScenario) => void;
  phaseShortcuts: { label: string; consecutive: number }[];
  focusPhaseId: string | null;
  onAdd: () => void;
  onPatch: (phaseId: string, patch: Partial<TriggerPhase>) => void;
  onRemove: (phaseId: string) => void;
  onMove: (phaseId: string, dir: -1 | 1) => void;
  onSetEvents: (phaseId: string, events: PhaseEvent[]) => void;
  onJumpToCategory: (categoryId: string) => void;
  onJumpToCategoriesTab: () => void;
  missingCategories: string[];
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Model explainer — one-time educational. */}
      <ModelExplainer />

      {/* Scenario picker drives all phase percentages. */}
      <ScenarioBar
        scenario={scenario}
        onChange={onScenarioChange}
        phaseShortcuts={phaseShortcuts}
      />

      <BodyCard
        rightSlot={
          <button
            type="button"
            onClick={onAdd}
            className={SUBHEADER_BTN_CLS}
          >
            <Plus className="w-3.5 h-3.5" />
            페이즈 추가
          </button>
        }
      >
        {missingCategories.length > 0 && (
          <NoticeChip tone="warn">
            {missingCategories.length}개 페이즈 이벤트가 존재하지 않는 카테고리(
            <code className="font-mono text-[0.7rem]">
              {Array.from(new Set(missingCategories)).slice(0, 3).join(', ')}
              {missingCategories.length > 3 ? '…' : ''}
            </code>
            )를 참조하고 있어요.{' '}
            <button
              type="button"
              onClick={onJumpToCategoriesTab}
              className="underline hover:no-underline"
            >
              카테고리 섹션으로 가서 정리하기
            </button>
          </NoticeChip>
        )}

        {manifest.phases.length === 0 ? (
          <EmptyHint text="아직 페이즈가 없습니다. ＋ 페이즈 추가로 시작하세요." />
        ) : (
          <div className="flex flex-col gap-3">
            {manifest.phases.map((phase, idx) => (
              <div
                key={phase.id}
                className={
                  focusPhaseId === phase.id
                    ? 'rounded-lg ring-2 ring-violet-500/40 -m-0.5'
                    : ''
                }
              >
                <PhaseEditor
                  phase={phase}
                  categories={manifest.categories}
                  manifest={manifest}
                  scenario={scenario}
                  isFirst={idx === 0}
                  isLast={idx === manifest.phases.length - 1}
                  onPatch={(patch) => onPatch(phase.id, patch)}
                  onRemove={() => onRemove(phase.id)}
                  onMoveUp={() => onMove(phase.id, -1)}
                  onMoveDown={() => onMove(phase.id, 1)}
                  onSetEvents={(events) => onSetEvents(phase.id, events)}
                  onJumpToCategory={onJumpToCategory}
                />
              </div>
            ))}
          </div>
        )}
      </BodyCard>
    </div>
  );
}

/**
 * One-time explainer card — shows the Phase ↔ Category model so the
 * operator's mental model matches the runtime. Compact, optional, and
 * collapsible would be overkill: kept always-visible for now since the
 * concept is the load-bearing one for this whole tab.
 */
function ModelExplainer() {
  return (
    <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 flex flex-col gap-2">
      <div className="text-[0.6875rem] uppercase tracking-wider font-semibold text-violet-700 dark:text-violet-300">
        모델 — 페이즈와 카테고리는 어떻게 함께 동작하나요?
      </div>
      <ol className="text-[0.8125rem] text-[hsl(var(--foreground))] leading-relaxed space-y-1 pl-5 list-decimal">
        <li>
          <span className="font-medium">카테고리</span>는 발사 가능한 이벤트의
          정의입니다. 프롬프트 풀과 발사 조건(Sub-Worker 상태, 시간대, 연속
          횟수, 쿨다운)을 갖습니다.
        </li>
        <li>
          <span className="font-medium">페이즈</span>는 연속 트리거 횟수 범위
          별로 어떤 카테고리를 어떤 가중치로 후보에 올릴지 정의합니다.
        </li>
        <li>
          런타임에서는 ① 매칭되는 페이즈를 고르고 ② 그 페이즈의 이벤트 중
          카테고리 조건을 통과한 것만 남기고 ③ 남은 가중치를 정규화해 룰렛으로
          하나를 뽑습니다.
        </li>
        <li>
          따라서 페이즈에 적힌 가중치 자체가 발사 비율은 아닙니다. 아래
          시나리오 바를 바꾸면 실제 비율이 어떻게 변하는지 즉시 확인할 수
          있어요.
        </li>
      </ol>
    </div>
  );
}

function CategoriesSection({
  categories,
  references,
  focusCategoryId,
  onAdd,
  onPatch,
  onRemove,
  onJumpToPhase,
}: {
  categories: TriggerCategory[];
  references: Map<
    string,
    { phaseId: string; phaseLabel: string; weight: number }[]
  >;
  focusCategoryId: string | null;
  onAdd: () => void;
  onPatch: (catId: string, patch: Partial<TriggerCategory>) => void;
  onRemove: (catId: string) => void;
  onJumpToPhase: (phaseId: string) => void;
}) {
  return (
    <BodyCard
      rightSlot={
        <button type="button" onClick={onAdd} className={SUBHEADER_BTN_CLS}>
          <Plus className="w-3.5 h-3.5" />
          카테고리 추가
        </button>
      }
    >
      <NoticeChip tone="info">
        카테고리는 발사 가능한 이벤트의 카탈로그입니다. 각 카테고리는 어떤
        조건에서 발사 가능한지(Sub-Worker, 시간대, 연속 횟수)와 로케일별
        프롬프트를 갖고, 페이즈 섹션에서 어떤 가중치로 후보에 올릴지가
        결정됩니다. 같은 카테고리를 여러 페이즈에서 다른 가중치로 사용할 수
        있어요.
      </NoticeChip>

      {categories.length === 0 ? (
        <EmptyHint text="카테고리가 없으면 어떤 페이즈도 발화할 수 없어요." />
      ) : (
        <div className="flex flex-col gap-3">
          {categories.map((cat) => (
            <div
              key={cat.id}
              className={
                focusCategoryId === cat.id
                  ? 'rounded-lg ring-2 ring-violet-500/40 -m-0.5'
                  : ''
              }
            >
              <CategoryEditor
                category={cat}
                references={references.get(cat.id) ?? []}
                onPatch={(patch) => onPatch(cat.id, patch)}
                onRemove={() => onRemove(cat.id)}
                onJumpToPhase={onJumpToPhase}
              />
            </div>
          ))}
        </div>
      )}
    </BodyCard>
  );
}

// ── Local primitives ─────────────────────────────────────────────

const INPUT_CLS =
  'w-full h-9 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';

const SUBHEADER_BTN_CLS =
  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors';

function BodyCard({
  rightSlot,
  children,
}: {
  rightSlot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 flex flex-col gap-4">
      {rightSlot && <div className="flex justify-end -mt-1">{rightSlot}</div>}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

interface FormRowProps {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}

function FormRow({ label, hint, required, children }: FormRowProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-2 sm:gap-4 sm:items-start">
      <div className="pt-2">
        <label className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
        {hint && (
          <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] leading-snug mt-0.5">
            {hint}
          </p>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

interface NumericFieldProps {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}

function NumericField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: NumericFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
        {label}
      </label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(n);
        }}
        className={INPUT_CLS}
      />
      {hint && (
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] leading-snug">
          {hint}
        </p>
      )}
    </div>
  );
}

function HourField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
        {label}
      </label>
      <input
        type="number"
        value={value}
        min={0}
        max={23}
        step={1}
        onChange={(e) => {
          const n = Math.max(0, Math.min(23, Math.round(Number(e.target.value))));
          if (Number.isFinite(n)) onChange(n);
        }}
        className={INPUT_CLS}
      />
      <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
        {value}:00 ~
      </p>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[hsl(var(--border))] px-4 py-6 text-center text-[0.75rem] text-[hsl(var(--muted-foreground))]">
      {text}
    </div>
  );
}

function NoticeChip({
  tone,
  children,
}: {
  tone: 'info' | 'warn';
  children: ReactNode;
}) {
  const cls =
    tone === 'warn'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300'
      : 'border-sky-500/25 bg-sky-500/5 text-sky-800 dark:text-sky-300';
  return (
    <div
      className={`px-3 py-2 rounded-lg border text-[0.75rem] leading-relaxed ${cls}`}
    >
      {children}
    </div>
  );
}

// Re-export types for callers — keeps the editor's internal types
// accessible without leaking implementation.
export type { CategoryConditions, TimeWindow, TriggerKind };
