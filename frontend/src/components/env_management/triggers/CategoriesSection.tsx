'use client';

/**
 * CategoriesSection — situation-centric editor for one preset.
 *
 * Each category card represents *one situation* with its own conditions,
 * weight, and prompts. The page composes around those cards:
 *
 *   1. ScenarioBar      — pick a runtime scenario to preview against.
 *   2. Active situation banner — which situations match this scenario,
 *                          how the matching ones split the probability.
 *   3. List of cards    — situations sorted by effective % desc;
 *                          blocked ones drop into a collapsed group.
 *   4. + Situation 추가 — creates a fresh card and auto-expands it.
 *
 * Mirrors the backend's two-stage roulette (category → prompt) via
 * :mod:`triggerSimulator`. The displayed "실제 비율" tracks the active
 * scenario, so editing weights or conditions and watching the numbers
 * update is the operator's primary feedback loop.
 */

import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';

import type {
  TriggerCategory,
  TriggerPresetManifest,
} from '@/types/triggerPreset';
import { simulate, type RuntimeScenario } from './triggerSimulator';
import ScenarioBar from './ScenarioBar';
import CategoryCard from './CategoryCard';

function freshId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now()
    .toString(36)
    .slice(-4)}`;
}

export interface CategoriesSectionProps {
  manifest: TriggerPresetManifest;
  scenario: RuntimeScenario;
  onScenarioChange: (s: RuntimeScenario) => void;
  onManifestUpdate: (
    next:
      | TriggerPresetManifest
      | ((prev: TriggerPresetManifest) => TriggerPresetManifest),
  ) => void;
  /** Click-through to the prompts library section. */
  onJumpToPrompts?: () => void;
}

export default function CategoriesSection({
  manifest,
  scenario,
  onScenarioChange,
  onManifestUpdate,
  onJumpToPrompts,
}: CategoriesSectionProps) {
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [recentlyAddedId, setRecentlyAddedId] = useState<string | null>(null);

  const simulation = useMemo(
    () => simulate(manifest, scenario),
    [manifest, scenario],
  );

  const eligibleCount = simulation.categories.filter((c) => !c.blocked).length;
  const blockedCount = simulation.categories.length - eligibleCount;

  // Sort eligible by effective % desc; blocked at the bottom in their group.
  const eligibleSorted = useMemo(
    () =>
      [...simulation.categories]
        .filter((c) => !c.blocked)
        .sort((a, b) => b.effectivePct - a.effectivePct),
    [simulation.categories],
  );
  const blockedList = useMemo(
    () => simulation.categories.filter((c) => !!c.blocked),
    [simulation.categories],
  );

  // ── Mutation helpers ───────────────────────────────────────

  const updateCategory = useCallback(
    (categoryId: string, patch: Partial<TriggerCategory>) => {
      onManifestUpdate((prev) => ({
        ...prev,
        categories: prev.categories.map((c) =>
          c.id === categoryId ? { ...c, ...patch } : c,
        ),
      }));
    },
    [onManifestUpdate],
  );

  const removeCategory = useCallback(
    (categoryId: string) => {
      onManifestUpdate((prev) => ({
        ...prev,
        categories: prev.categories.filter((c) => c.id !== categoryId),
      }));
    },
    [onManifestUpdate],
  );

  const addCategory = useCallback(() => {
    const id = freshId('situation');
    onManifestUpdate((prev) => ({
      ...prev,
      categories: [
        ...prev.categories,
        {
          id,
          label: '새 상황',
          kind: 'thinking',
          weight: 1,
          consec_min: 0,
          consec_max: null,
          requires_sub_worker_busy: false,
          requires_sub_worker_idle: false,
          time_window: null,
          cooldown_seconds: 0,
          autonomous_signal: '',
          prompt_refs: [],
        },
      ],
    }));
    setRecentlyAddedId(id);
  }, [onManifestUpdate]);

  // Quick scenario-shortcut buttons derived from category consec_min.
  const consecShortcuts = useMemo(() => {
    const seen = new Set<number>();
    const out: { label: string; consecutive: number }[] = [];
    for (const c of manifest.categories) {
      if (c.consec_min > 0 && !seen.has(c.consec_min)) {
        seen.add(c.consec_min);
        out.push({ label: c.label || `consec ${c.consec_min}`, consecutive: c.consec_min });
      }
    }
    return out.slice(0, 4);
  }, [manifest.categories]);

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      <ModelExplainer />

      <ScenarioBar
        scenario={scenario}
        onChange={onScenarioChange}
        phaseShortcuts={consecShortcuts}
      />

      <ActiveScenarioBanner
        scenario={scenario}
        eligibleCount={eligibleCount}
        blockedCount={blockedCount}
      />

      {/* Eligible list */}
      <section className="flex flex-col gap-2">
        <header className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h4 className="text-[0.875rem] font-semibold text-[hsl(var(--foreground))]">
              이 상황에서 발화 가능한 상황들
            </h4>
            <span className="text-[0.75rem] text-[hsl(var(--muted-foreground))] tabular-nums">
              {eligibleCount}개 · 합 100%
            </span>
          </div>
          <button
            type="button"
            onClick={addCategory}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-violet-500 text-white text-[0.75rem] font-medium hover:bg-violet-600 transition-colors shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            상황 추가
          </button>
        </header>

        {eligibleSorted.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[hsl(var(--border))] px-4 py-6 text-center text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
            현재 시나리오에 매칭되는 상황이 없어요.{' '}
            <button
              type="button"
              onClick={addCategory}
              className="text-violet-600 dark:text-violet-300 underline hover:no-underline"
            >
              새 상황 추가
            </button>
            {' '}또는 시나리오를 바꿔보세요.
          </div>
        ) : (
          eligibleSorted.map((sim) => (
            <CategoryCard
              key={sim.category.id}
              category={sim.category}
              promptLibrary={manifest.prompts}
              blocked={null}
              effectivePct={sim.effectivePct}
              defaultExpanded={recentlyAddedId === sim.category.id}
              onPatch={(patch) => updateCategory(sim.category.id, patch)}
              onDelete={() => removeCategory(sim.category.id)}
              onJumpToPrompts={onJumpToPrompts}
            />
          ))
        )}
      </section>

      {/* Blocked list — collapsed */}
      {blockedList.length > 0 && (
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
              이 시나리오에서 차단된 상황들
            </h4>
            <span className="text-[0.75rem] text-[hsl(var(--muted-foreground))] tabular-nums">
              {blockedList.length}개
            </span>
          </button>

          {blockedOpen &&
            blockedList.map((sim) => (
              <CategoryCard
                key={sim.category.id}
                category={sim.category}
                promptLibrary={manifest.prompts}
                blocked={sim.blocked}
                effectivePct={0}
                defaultExpanded={recentlyAddedId === sim.category.id}
                onPatch={(patch) => updateCategory(sim.category.id, patch)}
                onDelete={() => removeCategory(sim.category.id)}
                onJumpToPrompts={onJumpToPrompts}
              />
            ))}
        </section>
      )}
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
          한 카드 = 한 <strong>상황</strong>입니다. 카드는 그 상황의 조건(언제
          발화), 가중치(얼마나 자주), 프롬프트 변형(어떤 말을 할지)을 모두 갖고
          있어요.
        </li>
        <li>
          위쪽 <strong>시나리오</strong>를 바꾸면 그 시나리오에서 어떤 상황이
          매칭되는지, 매칭된 상황 사이에서 발사 비율이 어떻게 나뉘는지가 카드의
          "실제 비율" 에 즉시 반영됩니다.
        </li>
        <li>
          프롬프트는 <strong>자연어만</strong> 적으세요. 시스템이{' '}
          <code className="font-mono text-[0.75rem]">[THINKING_TRIGGER:…]</code>{' '}
          같은 태그를 자동으로 붙입니다 — 카드 안의 "실제 발사되는 형태"
          미리보기에서 확인할 수 있어요.
        </li>
        <li>
          런타임 흐름: ① 매칭 상황 모음 → ② <strong>상황 가중치</strong>로 룰렛 →
          ③ 그 상황의 <strong>프롬프트 가중치</strong>로 룰렛 → ④ 자동 태그
          붙여서 발사.
        </li>
      </ol>
    </div>
  );
}

function ActiveScenarioBanner({
  scenario,
  eligibleCount,
  blockedCount,
}: {
  scenario: RuntimeScenario;
  eligibleCount: number;
  blockedCount: number;
}) {
  const subWorkerLabel =
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
          현재 시나리오
        </span>
      </div>
      <span className="text-[0.8125rem] text-[hsl(var(--foreground))]">
        연속 <strong className="font-mono">{scenario.consecutive}</strong>회 ·{' '}
        {subWorkerLabel} · {scenario.timeWindow} 시간대
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
