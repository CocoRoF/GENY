'use client';

/**
 * TriggersSection — situation-centric unified view.
 *
 * Cycle 20260507 redesign — replaced the dual "phases / categories"
 * tabs with a single surface organised the way operators actually
 * think about the problem:
 *
 *   1. Pick a *situation* (consec count + sub-worker state + time
 *      window) at the top.
 *   2. See **the triggers that fire in this situation** as a flat
 *      list, sorted by effective probability.
 *   3. Edit each trigger inline — weight, conditions, prompts — no
 *      jumping between tabs.
 *   4. Below that, blocked triggers grouped by reason so the operator
 *      can audit why something isn't firing.
 *   5. Phase ranges (consec buckets) live in a collapsed "advanced"
 *      panel at the bottom — touched only when one wants different
 *      weights per consec range.
 *
 * Data model unchanged from the backend: triggers are still backed by
 * (phase, category) records; this component just collapses the two
 * concepts into one operator-facing entity.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Plus } from 'lucide-react';

import type {
  PhaseEvent,
  TriggerCategory,
  TriggerPhase,
  TriggerPresetManifest,
} from '@/types/triggerPreset';
import {
  categoryReferences,
  type RuntimeScenario,
  selectPhase,
  simulatePhase,
} from './triggerSimulator';
import ScenarioBar from './ScenarioBar';
import TriggerCard from './TriggerCard';
import PhaseRangeManager from './PhaseRangeManager';

function freshId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now()
    .toString(36)
    .slice(-4)}`;
}

export interface TriggersSectionProps {
  manifest: TriggerPresetManifest;
  scenario: RuntimeScenario;
  onScenarioChange: (s: RuntimeScenario) => void;
  /** Apply a manifest mutation through the parent's update path. */
  onManifestUpdate: (
    next:
      | TriggerPresetManifest
      | ((prev: TriggerPresetManifest) => TriggerPresetManifest),
  ) => void;
}

export default function TriggersSection({
  manifest,
  scenario,
  onScenarioChange,
  onManifestUpdate,
}: TriggersSectionProps) {
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  // ── Active phase derivation ──────────────────────────────────

  const activePhase = useMemo(
    () => selectPhase(manifest, scenario.consecutive),
    [manifest, scenario.consecutive],
  );

  const simulation = useMemo(() => {
    if (!activePhase) return null;
    return simulatePhase(activePhase, manifest, scenario);
  }, [activePhase, manifest, scenario]);

  // Reverse references — used by TriggerCard to flag shared triggers.
  const references = useMemo(
    () => categoryReferences(manifest),
    [manifest],
  );

  const phaseShortcuts = useMemo(
    () =>
      manifest.phases.map((p) => ({
        label: p.label || `phase ${p.min_consecutive}+`,
        consecutive: p.min_consecutive,
      })),
    [manifest.phases],
  );

  // Orphan categories — defined but never referenced by any phase.
  const orphans = useMemo(
    () =>
      manifest.categories.filter(
        (c) => !references.has(c.id) || references.get(c.id)!.length === 0,
      ),
    [manifest.categories, references],
  );

  // ── Mutation helpers ─────────────────────────────────────────

  const updatePhaseEvent = useCallback(
    (phaseId: string, categoryId: string, patch: Partial<PhaseEvent>) => {
      onManifestUpdate((prev) => ({
        ...prev,
        phases: prev.phases.map((p) =>
          p.id === phaseId
            ? {
                ...p,
                events: p.events.map((ev) =>
                  ev.category_id === categoryId ? { ...ev, ...patch } : ev,
                ),
              }
            : p,
        ),
      }));
    },
    [onManifestUpdate],
  );

  const removePhaseEvent = useCallback(
    (phaseId: string, categoryId: string) => {
      onManifestUpdate((prev) => ({
        ...prev,
        phases: prev.phases.map((p) =>
          p.id === phaseId
            ? {
                ...p,
                events: p.events.filter((ev) => ev.category_id !== categoryId),
              }
            : p,
        ),
      }));
    },
    [onManifestUpdate],
  );

  const updateCategory = useCallback(
    (categoryId: string, patch: Partial<TriggerCategory>) => {
      onManifestUpdate((prev) => {
        const idChanging = patch.id && patch.id !== categoryId;
        const newId = patch.id ?? categoryId;
        return {
          ...prev,
          categories: prev.categories.map((c) =>
            c.id === categoryId ? { ...c, ...patch } : c,
          ),
          // If the user renamed the id, retarget every phase event too.
          phases: idChanging
            ? prev.phases.map((p) => ({
                ...p,
                events: p.events.map((ev) =>
                  ev.category_id === categoryId
                    ? { ...ev, category_id: newId }
                    : ev,
                ),
              }))
            : prev.phases,
        };
      });
    },
    [onManifestUpdate],
  );

  const duplicateCategoryForPhase = useCallback(
    (categoryId: string, phaseId: string) => {
      onManifestUpdate((prev) => {
        const source = prev.categories.find((c) => c.id === categoryId);
        if (!source) return prev;
        const newId = freshId(source.id);
        const clone: TriggerCategory = {
          ...source,
          id: newId,
          label: `${source.label} (copy)`,
          conditions: { ...source.conditions },
          prompts: Object.fromEntries(
            Object.entries(source.prompts).map(([k, v]) => [k, [...v]]),
          ),
        };
        return {
          ...prev,
          categories: [...prev.categories, clone],
          phases: prev.phases.map((p) =>
            p.id === phaseId
              ? {
                  ...p,
                  events: p.events.map((ev) =>
                    ev.category_id === categoryId
                      ? { ...ev, category_id: newId }
                      : ev,
                  ),
                }
              : p,
          ),
        };
      });
    },
    [onManifestUpdate],
  );

  const addNewTrigger = useCallback(
    (input: NewTriggerInput) => {
      if (!activePhase) return;
      onManifestUpdate((prev) => {
        const newCategory: TriggerCategory = {
          id: input.id || freshId('trigger'),
          label: input.label,
          kind: input.kind,
          conditions: {},
          cooldown_seconds: 0,
          prompts: { en: [], ko: [] },
        };
        return {
          ...prev,
          categories: [...prev.categories, newCategory],
          phases: prev.phases.map((p) =>
            p.id === activePhase.id
              ? {
                  ...p,
                  events: [
                    ...p.events,
                    { category_id: newCategory.id, weight: input.weight },
                  ],
                }
              : p,
          ),
        };
      });
      setAdding(false);
    },
    [activePhase, onManifestUpdate],
  );

  const attachExistingTrigger = useCallback(
    (categoryId: string, weight: number) => {
      if (!activePhase) return;
      onManifestUpdate((prev) => ({
        ...prev,
        phases: prev.phases.map((p) =>
          p.id === activePhase.id
            ? {
                ...p,
                events: [...p.events, { category_id: categoryId, weight }],
              }
            : p,
        ),
      }));
      setAdding(false);
    },
    [activePhase, onManifestUpdate],
  );

  const addPhase = useCallback(() => {
    onManifestUpdate((prev) => {
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
  }, [onManifestUpdate]);

  const updatePhase = useCallback(
    (phaseId: string, patch: Partial<TriggerPhase>) => {
      onManifestUpdate((prev) => ({
        ...prev,
        phases: prev.phases.map((p) =>
          p.id === phaseId ? { ...p, ...patch } : p,
        ),
      }));
    },
    [onManifestUpdate],
  );

  const removePhase = useCallback(
    (phaseId: string) => {
      onManifestUpdate((prev) => ({
        ...prev,
        phases: prev.phases.filter((p) => p.id !== phaseId),
      }));
    },
    [onManifestUpdate],
  );

  const movePhase = useCallback(
    (phaseId: string, dir: -1 | 1) => {
      onManifestUpdate((prev) => {
        const idx = prev.phases.findIndex((p) => p.id === phaseId);
        if (idx < 0) return prev;
        const next = idx + dir;
        if (next < 0 || next >= prev.phases.length) return prev;
        const phases = [...prev.phases];
        [phases[idx], phases[next]] = [phases[next], phases[idx]];
        return { ...prev, phases };
      });
    },
    [onManifestUpdate],
  );

  // ── Render ───────────────────────────────────────────────────

  const eligible =
    simulation?.events
      .filter((e) => !e.blocked && e.category)
      // Sort by effective % desc so the most-frequent triggers float top.
      .sort((a, b) => b.effectivePct - a.effectivePct) ?? [];
  const blocked =
    simulation?.events.filter((e) => !!e.blocked && e.category) ?? [];

  const usableCategoryIds = new Set(
    activePhase?.events.map((e) => e.category_id) ?? [],
  );
  const attachableCategories = manifest.categories.filter(
    (c) => !usableCategoryIds.has(c.id),
  );

  return (
    <div className="flex flex-col gap-4">
      <ModelExplainer />

      <ScenarioBar
        scenario={scenario}
        onChange={onScenarioChange}
        phaseShortcuts={phaseShortcuts}
      />

      {/* Active situation summary */}
      <ActiveSituationBanner
        activePhase={activePhase}
        scenario={scenario}
        eligibleCount={eligible.length}
        blockedCount={blocked.length}
      />

      {/* Eligible triggers */}
      <section className="flex flex-col gap-2">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h4 className="text-[0.875rem] font-semibold text-[hsl(var(--foreground))]">
              발화 가능한 트리거
            </h4>
            <span className="text-[0.75rem] text-[hsl(var(--muted-foreground))] tabular-nums">
              {eligible.length}개 · 효과 비율 합 {totalEffPct(eligible)}%
            </span>
          </div>
          {activePhase && (
            <button
              type="button"
              onClick={() => setAdding((v) => !v)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-violet-500 text-white text-[0.75rem] font-medium hover:bg-violet-600 transition-colors shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              트리거 추가
            </button>
          )}
        </header>

        {adding && activePhase && (
          <NewTriggerForm
            attachableCategories={attachableCategories}
            onCancel={() => setAdding(false)}
            onCreate={addNewTrigger}
            onAttach={attachExistingTrigger}
          />
        )}

        {!activePhase && (
          <NoMatchingPhase onAdd={addPhase} consec={scenario.consecutive} />
        )}

        {activePhase && eligible.length === 0 && (
          <div className="rounded-lg border border-dashed border-[hsl(var(--border))] px-4 py-6 text-center text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
            이 상황에서 발화 가능한 트리거가 없어요.{' '}
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="text-violet-600 dark:text-violet-300 underline hover:no-underline"
            >
              새 트리거 추가
            </button>{' '}
            를 누르거나 시나리오를 바꿔보세요.
          </div>
        )}

        {activePhase &&
          eligible.map((sim) => (
            <TriggerCard
              key={sim.event.category_id}
              category={sim.category!}
              weight={sim.event.weight}
              activePhaseId={activePhase.id}
              activePhaseLabel={activePhase.label || activePhase.id}
              blocked={null}
              effectivePct={sim.effectivePct}
              references={references.get(sim.event.category_id) ?? []}
              onWeight={(w) =>
                updatePhaseEvent(activePhase.id, sim.event.category_id, {
                  weight: w,
                })
              }
              onCategoryPatch={(patch) =>
                updateCategory(sim.event.category_id, patch)
              }
              onRemoveFromPhase={() =>
                removePhaseEvent(activePhase.id, sim.event.category_id)
              }
              onDuplicate={() =>
                duplicateCategoryForPhase(
                  sim.event.category_id,
                  activePhase.id,
                )
              }
            />
          ))}
      </section>

      {/* Blocked triggers — collapsed by default */}
      {activePhase && blocked.length > 0 && (
        <section className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setBlockedOpen((v) => !v)}
            className="flex items-center gap-2 text-left"
          >
            {blockedOpen ? (
              <ChevronDown className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
            ) : (
              <ChevronRight className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
            )}
            <h4 className="text-[0.875rem] font-semibold text-[hsl(var(--foreground))]">
              차단된 트리거
            </h4>
            <span className="text-[0.75rem] text-[hsl(var(--muted-foreground))] tabular-nums">
              {blocked.length}개 · 현재 상황에서 발화 불가
            </span>
          </button>

          {blockedOpen &&
            blocked.map((sim) => (
              <TriggerCard
                key={sim.event.category_id}
                category={sim.category!}
                weight={sim.event.weight}
                activePhaseId={activePhase.id}
                activePhaseLabel={activePhase.label || activePhase.id}
                blocked={sim.blocked}
                effectivePct={0}
                references={references.get(sim.event.category_id) ?? []}
                onWeight={(w) =>
                  updatePhaseEvent(activePhase.id, sim.event.category_id, {
                    weight: w,
                  })
                }
                onCategoryPatch={(patch) =>
                  updateCategory(sim.event.category_id, patch)
                }
                onRemoveFromPhase={() =>
                  removePhaseEvent(activePhase.id, sim.event.category_id)
                }
                onDuplicate={() =>
                  duplicateCategoryForPhase(
                    sim.event.category_id,
                    activePhase.id,
                  )
                }
              />
            ))}
        </section>
      )}

      {/* Orphan triggers (defined but unused) */}
      {orphans.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
          <div className="flex-1 text-[0.75rem] text-amber-800 dark:text-amber-300">
            <strong className="font-semibold">
              사용되지 않는 트리거 {orphans.length}개:
            </strong>{' '}
            {orphans.map((c) => c.label || c.id).join(', ')} — 어떤 페이즈에도
            등록되지 않아 발화하지 않아요. 시나리오 / 페이즈를 바꿔서 추가해
            주세요.
          </div>
        </div>
      )}

      {/* Phase range management — advanced */}
      <PhaseRangeManager
        phases={manifest.phases}
        activePhaseId={activePhase?.id ?? null}
        onPatch={updatePhase}
        onRemove={removePhase}
        onMove={movePhase}
        onAdd={addPhase}
      />
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────

function ModelExplainer() {
  return (
    <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 flex flex-col gap-2">
      <div className="text-[0.6875rem] uppercase tracking-wider font-semibold text-violet-700 dark:text-violet-300">
        이 화면 사용법
      </div>
      <ol className="text-[0.8125rem] text-[hsl(var(--foreground))] leading-relaxed space-y-1 pl-5 list-decimal">
        <li>
          위쪽 <strong>시나리오</strong>에서 보고 싶은 상황을 골라요. 연속 트리거
          횟수, Sub-Worker 상태, 시간대를 지정합니다.
        </li>
        <li>
          그 상황에서 <strong>실제로 발화 가능한 트리거</strong>가 비율 순으로
          나옵니다. 가중치, 조건, 프롬프트는 각 카드에서 바로 펼쳐 편집해요.
        </li>
        <li>
          <strong>차단된 트리거</strong>는 어떤 조건 때문에 빠졌는지 사유와
          함께 따로 보여줘요.
        </li>
        <li>
          연속 트리거 횟수에 따라 다른 가중치를 쓰고 싶으면 맨 아래의 "고급 —
          페이즈 범위 관리"에서 구간을 나눌 수 있어요.
        </li>
      </ol>
    </div>
  );
}

function ActiveSituationBanner({
  activePhase,
  scenario,
  eligibleCount,
  blockedCount,
}: {
  activePhase: TriggerPhase | null;
  scenario: RuntimeScenario;
  eligibleCount: number;
  blockedCount: number;
}) {
  if (!activePhase) {
    return null;
  }
  const subWorker =
    scenario.subWorker === 'busy'
      ? 'Sub-Worker 작업 중'
      : scenario.subWorker === 'idle'
        ? 'Sub-Worker idle'
        : 'Sub-Worker 미연결';
  return (
    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-4 py-3 flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-full bg-violet-500" />
        <span className="text-[0.75rem] uppercase tracking-wider font-semibold text-violet-700 dark:text-violet-300">
          현재 상황
        </span>
      </div>
      <span className="text-[0.8125rem] text-[hsl(var(--foreground))]">
        연속 <strong className="font-mono">{scenario.consecutive}</strong>회 ·{' '}
        {subWorker} · {scenario.timeWindow} 시간대
      </span>
      <span className="text-[0.75rem] text-[hsl(var(--muted-foreground))]">
        →
      </span>
      <span className="text-[0.8125rem] text-[hsl(var(--foreground))]">
        매칭 페이즈 <strong>{activePhase.label || activePhase.id}</strong>{' '}
        <span className="text-[0.75rem] text-[hsl(var(--muted-foreground))] font-mono">
          (consec {activePhase.min_consecutive}~
          {activePhase.max_consecutive ?? '∞'})
        </span>
      </span>
      <span className="ml-auto text-[0.7rem] flex items-center gap-2.5">
        <span className="text-emerald-700 dark:text-emerald-300">
          ● 발화 {eligibleCount}
        </span>
        {blockedCount > 0 && (
          <span className="text-red-600 dark:text-red-400">
            ● 차단 {blockedCount}
          </span>
        )}
      </span>
    </div>
  );
}

function NoMatchingPhase({
  consec,
  onAdd,
}: {
  consec: number;
  onAdd: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-4 flex items-start gap-3">
      <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
      <div className="flex-1 text-[0.8125rem] text-amber-800 dark:text-amber-300">
        <div className="font-semibold mb-1">
          연속 {consec}회를 커버하는 페이즈가 없어요
        </div>
        <div className="leading-relaxed">
          이 상황에서는 어떤 트리거도 발화하지 않습니다. 아래의 "고급 — 페이즈
          범위 관리"에서{' '}
          <button
            type="button"
            onClick={onAdd}
            className="underline font-medium hover:no-underline"
          >
            새 페이즈 추가
          </button>
          하거나 기존 페이즈의 범위를 넓혀 주세요.
        </div>
      </div>
    </div>
  );
}

interface NewTriggerInput {
  id?: string;
  label: string;
  kind: 'thinking' | 'activity';
  weight: number;
}

function NewTriggerForm({
  attachableCategories,
  onCancel,
  onCreate,
  onAttach,
}: {
  attachableCategories: TriggerCategory[];
  onCancel: () => void;
  onCreate: (input: NewTriggerInput) => void;
  onAttach: (categoryId: string, weight: number) => void;
}) {
  const [mode, setMode] = useState<'new' | 'attach'>(
    attachableCategories.length > 0 ? 'attach' : 'new',
  );
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'thinking' | 'activity'>('thinking');
  const [weight, setWeight] = useState(10);
  const [attachId, setAttachId] = useState(
    attachableCategories[0]?.id ?? '',
  );

  const submit = () => {
    if (mode === 'new') {
      if (!label.trim()) return;
      onCreate({ label: label.trim(), kind, weight });
    } else {
      if (!attachId) return;
      onAttach(attachId, weight);
    }
  };

  return (
    <div className="rounded-lg border border-violet-500/40 bg-violet-500/5 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[0.75rem] uppercase tracking-wider font-semibold text-violet-700 dark:text-violet-300">
          새 트리거 추가
        </span>
        <div className="ml-auto inline-flex rounded-md border border-[hsl(var(--border))] overflow-hidden">
          {attachableCategories.length > 0 && (
            <button
              type="button"
              onClick={() => setMode('attach')}
              className={`px-2.5 h-7 text-[0.7rem] font-medium ${
                mode === 'attach'
                  ? 'bg-violet-500 text-white'
                  : 'bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))]'
              }`}
            >
              기존 트리거 연결
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode('new')}
            className={`px-2.5 h-7 text-[0.7rem] font-medium ${
              mode === 'new'
                ? 'bg-violet-500 text-white'
                : 'bg-[hsl(var(--background))] text-[hsl(var(--muted-foreground))]'
            }`}
          >
            새로 만들기
          </button>
        </div>
      </div>

      {mode === 'attach' ? (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px_auto] gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              연결할 트리거
            </label>
            <select
              value={attachId}
              onChange={(e) => setAttachId(e.target.value)}
              className="h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem]"
            >
              {attachableCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label || c.id} ({c.kind})
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              가중치
            </label>
            <input
              type="number"
              value={weight}
              min={0}
              step={1}
              onChange={(e) => setWeight(Math.max(0, Number(e.target.value)))}
              className="h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] tabular-nums"
            />
          </div>
          <FormButtons onSubmit={submit} onCancel={onCancel} submitLabel="연결" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_120px_auto] gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              이름
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="예: Curious thought"
              className="h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              종류
            </label>
            <select
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as 'thinking' | 'activity')
              }
              className="h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem]"
            >
              <option value="thinking">Thinking</option>
              <option value="activity">Activity</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              가중치
            </label>
            <input
              type="number"
              value={weight}
              min={0}
              step={1}
              onChange={(e) => setWeight(Math.max(0, Number(e.target.value)))}
              className="h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] tabular-nums"
            />
          </div>
          <FormButtons
            onSubmit={submit}
            onCancel={onCancel}
            submitLabel="만들기"
            disabled={!label.trim()}
          />
        </div>
      )}
      {mode === 'new' && (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          만든 후 트리거 카드를 펼쳐서 발사 조건과 프롬프트를 추가하세요.
        </p>
      )}
    </div>
  );
}

function FormButtons({
  onSubmit,
  onCancel,
  submitLabel,
  disabled = false,
}: {
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-end gap-1.5">
      <button
        type="button"
        onClick={onCancel}
        className="h-9 px-3 rounded-md border border-[hsl(var(--border))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
      >
        취소
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled}
        className="h-9 px-3 rounded-md bg-violet-500 text-white text-[0.8125rem] font-medium hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitLabel}
      </button>
    </div>
  );
}

function totalEffPct(
  list: { effectivePct: number }[],
): string {
  const total = list.reduce((s, e) => s + e.effectivePct, 0);
  return total.toFixed(1);
}
