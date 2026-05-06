'use client';

/**
 * TriggerPresetEditor — full-surface editor for one trigger preset.
 *
 * Layout follows :mod:`RegistryFormShell` so list view ↔ editor read
 * as two states of the same surface (no modal context-switch). The
 * body is a vertical stack of sections, each a self-contained form
 * group:
 *
 *   1. 메타데이터    — name / description / tags / master enabled toggle
 *   2. 타이밍        — base/max idle, tick interval, sub-worker cooldown
 *   3. 시간대 경계   — morning/afternoon/evening/night start hours
 *   4. 페이즈        — list of consecutive-count brackets + event matrix
 *   5. 카테고리      — list of firable buckets + conditions + prompts
 *
 * Save flow:
 *
 *   create → POST /api/trigger-presets  (with full manifest)
 *   edit   → PATCH metadata  +  PUT /manifest  (two calls so partial
 *            failures surface clearly; both are idempotent)
 *
 * Live reload contract: the backend bumps a version counter on every
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
  Plus,
  Save,
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

// ── Helpers ──────────────────────────────────────────────────────

function freshId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now()
    .toString(36)
    .slice(-4)}`;
}

function emptyManifest(): TriggerPresetManifest {
  // Used as a last-resort fallback if the defaults endpoint failed.
  // The server-side ``create_blank`` will replace this with the real
  // bundled defaults anyway.
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

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  // Re-seed on prop change — happens when caller re-fetches after a
  // reset-to-defaults call.
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

  // Mark dirty on any state change after first paint. Cheap proxy:
  // wrap setManifest so callers don't have to remember.
  const updateManifest = useCallback(
    (next: TriggerPresetManifest | ((prev: TriggerPresetManifest) => TriggerPresetManifest)) => {
      dirtyRef.current = true;
      setManifest((prev) =>
        typeof next === 'function' ? (next as (p: TriggerPresetManifest) => TriggerPresetManifest)(prev) : next,
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

  const totalWeightByPhase = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of manifest.phases) {
      map[p.id] = p.events.reduce((sum, e) => sum + Math.max(0, e.weight), 0);
    }
    return map;
  }, [manifest.phases]);

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
      // If the previous phase was open-ended, close it at minNext - 1
      // so the new phase has a valid range.
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
        // Drop the category and any phase events referencing it so the
        // server-side validator doesn't reject the save.
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

  // ── Render ────────────────────────────────────────────────────

  return (
    <RegistryFormShell
      icon={Zap}
      title={
        mode === 'create' ? '새 트리거 프리셋' : `편집: ${name || '이름 없음'}`
      }
      subtitle={
        mode === 'create'
          ? '현재 기본 동작과 동일한 페이즈/카테고리/프롬프트가 미리 채워져 있어요. 필요한 부분만 조정하세요.'
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
      {/* 1. Metadata */}
      <SectionCard title="메타데이터" subtitle="프리셋 식별 정보와 마스터 스위치">
        <FormRow label="이름" required>
          <input
            type="text"
            value={name}
            onChange={(e) => updateName(e.target.value)}
            placeholder="예: 차분한 오후 페르소나"
            className={INPUT_CLS}
          />
        </FormRow>
        <FormRow label="설명">
          <textarea
            value={description}
            onChange={(e) => updateDescription(e.target.value)}
            rows={2}
            placeholder="이 프리셋이 어떤 분위기인지 메모"
            className={`${INPUT_CLS} resize-y min-h-[60px]`}
          />
        </FormRow>
        <FormRow label="태그" hint="쉼표로 구분. preset 태그는 공유 프리셋 섹션에 표시됩니다.">
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => updateTagsInput(e.target.value)}
            placeholder="preset, vtuber, calm"
            className={INPUT_CLS}
          />
        </FormRow>
        <FormRow label="활성화">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={manifest.enabled}
              onChange={(e) =>
                updateManifest({ ...manifest, enabled: e.target.checked })
              }
              className="w-4 h-4 accent-violet-500"
            />
            <span className="text-[0.8125rem] text-[hsl(var(--foreground))]">
              {manifest.enabled
                ? '이 프리셋이 부착된 세션에 트리거가 발사됩니다'
                : '비활성화 — 부착된 세션은 자가 발화하지 않습니다'}
            </span>
          </label>
        </FormRow>
      </SectionCard>

      {/* 2. Timing */}
      <SectionCard
        title="타이밍"
        subtitle="유저 침묵 후 첫 트리거가 발사되기까지의 시간과 적응형 백오프"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <NumericField
            label="기본 침묵 시간 (초)"
            hint="이 시간이 지나면 첫 트리거 발사"
            value={manifest.timing.base_idle_seconds}
            min={5}
            step={5}
            onChange={(v) =>
              updateManifest({
                ...manifest,
                timing: { ...manifest.timing, base_idle_seconds: v },
              })
            }
          />
          <NumericField
            label="최대 침묵 시간 (초)"
            hint="연속 트리거가 누적될수록 임계값이 이 값으로 수렴"
            value={manifest.timing.max_idle_seconds}
            min={manifest.timing.base_idle_seconds}
            step={60}
            onChange={(v) =>
              updateManifest({
                ...manifest,
                timing: { ...manifest.timing, max_idle_seconds: v },
              })
            }
          />
          <NumericField
            label="틱 주기 (초)"
            hint="스캔 주기 — 짧을수록 반응이 빠르지만 부하 증가"
            value={manifest.timing.tick_interval_seconds}
            min={5}
            step={5}
            onChange={(v) =>
              updateManifest({
                ...manifest,
                timing: { ...manifest.timing, tick_interval_seconds: v },
              })
            }
          />
          <NumericField
            label="Sub-Worker 진행 중 쿨다운 (초)"
            hint="Sub-Worker가 작업 중일 때 'still working' 메시지 반복 억제"
            value={manifest.timing.sub_worker_working_cooldown_seconds}
            min={0}
            step={10}
            onChange={(v) =>
              updateManifest({
                ...manifest,
                timing: {
                  ...manifest.timing,
                  sub_worker_working_cooldown_seconds: v,
                },
              })
            }
          />
          <NumericField
            label="적응형 스케일 트리거 수"
            hint="이 횟수만큼 트리거가 누적되면 임계값이 최대치에 도달 (log scale)"
            value={manifest.timing.adaptive_scale_triggers}
            min={1}
            step={1}
            onChange={(v) =>
              updateManifest({
                ...manifest,
                timing: { ...manifest.timing, adaptive_scale_triggers: v },
              })
            }
          />
        </div>
      </SectionCard>

      {/* 3. Time boundaries */}
      <SectionCard
        title="시간대 경계"
        subtitle="time_window 조건이 어느 시간대를 'morning/afternoon/evening/night' 으로 인식할지 (KST 기준 시간)"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <HourField
            label="아침 시작"
            value={manifest.time_boundaries.morning_start}
            onChange={(v) =>
              updateManifest({
                ...manifest,
                time_boundaries: {
                  ...manifest.time_boundaries,
                  morning_start: v,
                },
              })
            }
          />
          <HourField
            label="오후 시작"
            value={manifest.time_boundaries.afternoon_start}
            onChange={(v) =>
              updateManifest({
                ...manifest,
                time_boundaries: {
                  ...manifest.time_boundaries,
                  afternoon_start: v,
                },
              })
            }
          />
          <HourField
            label="저녁 시작"
            value={manifest.time_boundaries.evening_start}
            onChange={(v) =>
              updateManifest({
                ...manifest,
                time_boundaries: {
                  ...manifest.time_boundaries,
                  evening_start: v,
                },
              })
            }
          />
          <HourField
            label="밤 시작"
            value={manifest.time_boundaries.night_start}
            onChange={(v) =>
              updateManifest({
                ...manifest,
                time_boundaries: {
                  ...manifest.time_boundaries,
                  night_start: v,
                },
              })
            }
          />
        </div>
      </SectionCard>

      {/* 4. Phases */}
      <SectionCard
        title="페이즈"
        subtitle="연속 트리거 횟수에 따라 어떤 카테고리가 어떤 비율로 발화될지 정의합니다. 위에서부터 매칭되는 첫 페이즈가 적용돼요."
        rightSlot={
          <button
            type="button"
            onClick={addPhase}
            className={SUBHEADER_BTN_CLS}
          >
            <Plus className="w-3.5 h-3.5" />
            페이즈 추가
          </button>
        }
      >
        {manifest.phases.length === 0 ? (
          <EmptyHint text="아직 페이즈가 없습니다. ＋ 페이즈 추가로 시작하세요." />
        ) : (
          <div className="flex flex-col gap-3">
            {manifest.phases.map((phase, idx) => (
              <PhaseEditor
                key={phase.id}
                phase={phase}
                categories={manifest.categories}
                isFirst={idx === 0}
                isLast={idx === manifest.phases.length - 1}
                totalWeight={totalWeightByPhase[phase.id] ?? 0}
                onPatch={(patch) => updatePhase(phase.id, patch)}
                onRemove={() => removePhase(phase.id)}
                onMoveUp={() => movePhase(phase.id, -1)}
                onMoveDown={() => movePhase(phase.id, 1)}
                onSetEvents={(events) => setPhaseEvents(phase.id, events)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {/* 5. Categories */}
      <SectionCard
        title="카테고리"
        subtitle="발사 가능한 이벤트 종류 — 조건 게이트와 로케일별 프롬프트 묶음을 갖습니다."
        rightSlot={
          <button
            type="button"
            onClick={addCategory}
            className={SUBHEADER_BTN_CLS}
          >
            <Plus className="w-3.5 h-3.5" />
            카테고리 추가
          </button>
        }
      >
        {manifest.categories.length === 0 ? (
          <EmptyHint text="카테고리가 없으면 어떤 페이즈도 발화할 수 없어요." />
        ) : (
          <div className="flex flex-col gap-3">
            {manifest.categories.map((cat) => (
              <CategoryEditor
                key={cat.id}
                category={cat}
                referencedBy={manifest.phases
                  .filter((p) => p.events.some((e) => e.category_id === cat.id))
                  .map((p) => p.label || p.id)}
                onPatch={(patch) => updateCategory(cat.id, patch)}
                onRemove={() => removeCategory(cat.id)}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </RegistryFormShell>
  );
}

// ── Local primitives ─────────────────────────────────────────────

const INPUT_CLS =
  'w-full h-9 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';

const SUBHEADER_BTN_CLS =
  'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors';

interface SectionCardProps {
  title: string;
  subtitle?: string;
  rightSlot?: ReactNode;
  children: ReactNode;
}

function SectionCard({ title, subtitle, rightSlot, children }: SectionCardProps) {
  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-[0.9375rem] font-semibold text-[hsl(var(--foreground))]">
            {title}
          </h3>
          {subtitle && (
            <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] leading-relaxed mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
        {rightSlot && <div className="shrink-0">{rightSlot}</div>}
      </header>
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

// Re-export for type completeness in callers — keeps the editor's
// internal types accessible without leaking implementation.
export type { CategoryConditions, TimeWindow, TriggerKind };
