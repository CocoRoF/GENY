'use client';

/**
 * TriggerPresetEditor — section-driven editor for one trigger preset.
 *
 * Cycle 20260507 redesign — collapsed the previous "phases / categories"
 * dual-pane workspace into a single situation-centric "트리거" section
 * (see :mod:`TriggersSection`). The four-section navigator now reads:
 *
 *   ◯ 메타 ── ◯ 타이밍 ── ◯ 시간대 ── ◯ 트리거
 *
 * The trigger section is the load-bearing surface; the other three
 * exist for once-per-preset configuration.
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
  Clock,
  MessageSquare,
  Save,
  Sun,
  Tag,
  Zap,
} from 'lucide-react';

import { RegistryFormShell } from '@/components/env_management/registry';
import { triggerPresetApi } from '@/lib/triggerPresetApi';
import type {
  TriggerKind,
  TriggerPresetDetail,
  TriggerPresetManifest,
  TriggerPresetSummary,
  TimeWindow,
} from '@/types/triggerPreset';

import TriggerSectionBar, {
  type TriggerSectionDef,
} from './TriggerSectionBar';
import CategoriesSection from './CategoriesSection';
import { currentTimeWindow, type RuntimeScenario } from './triggerSimulator';

// ── Section identifiers ──────────────────────────────────────────

type SectionId = 'metadata' | 'timing' | 'time_boundaries' | 'categories';

// ── Helpers ──────────────────────────────────────────────────────

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

  const [scenario, setScenario] = useState<RuntimeScenario>(() => ({
    consecutive: 0,
    subWorker: 'idle',
    timeWindow: currentTimeWindow(
      seed?.manifest ? cloneManifest(seed.manifest) : emptyManifest(),
    ),
    honourCooldowns: false,
  }));

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

  const validation = useMemo(() => {
    const noPrompts = manifest.categories.every(
      (c) => c.prompts.length === 0,
    );
    const dupIds =
      manifest.categories.length !==
      new Set(manifest.categories.map((c) => c.id)).size;
    return {
      metadata: !name.trim(),
      timing:
        manifest.timing.base_idle_seconds <= 0 ||
        manifest.timing.max_idle_seconds < manifest.timing.base_idle_seconds,
      time_boundaries: false,
      categories: manifest.categories.length === 0 || noPrompts || dupIds,
    };
  }, [manifest, name]);

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

  const categoryCount = manifest.categories.length;
  const promptCount = useMemo(
    () => manifest.categories.reduce((s, c) => s + c.prompts.length, 0),
    [manifest.categories],
  );

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
        id: 'categories',
        label: '카테고리',
        icon: MessageSquare,
        hint: '발화 상황 — 조건 + 프롬프트. 한 카드에서 모든 게 편집됩니다.',
        badge: `${categoryCount}개 · ${promptCount}프롬프트`,
        hasIssue: validation.categories,
      },
    ],
    [categoryCount, promptCount, validation.metadata, validation.timing, validation.categories],
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
          ? '현재 기본 동작과 동일한 트리거가 미리 채워져 있어요. 위 섹션을 골라 필요한 부분만 조정하세요.'
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
            현재 섹션:{' '}
            <span className="font-medium text-[hsl(var(--foreground))]">
              {activeSection.label}
            </span>
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
      {/* Section navigator */}
      <div className="-mx-6">
        <TriggerSectionBar
          sections={sections}
          selected={section}
          onSelect={(id) => setSection(id)}
        />
      </div>

      {/* Section header */}
      <SectionHeader section={activeSection} />

      {/* Section bodies */}
      {section === 'metadata' && (
        <MetadataSection
          name={name}
          description={description}
          tagsInput={tagsInput}
          enabled={manifest.enabled}
          onName={updateName}
          onDescription={updateDescription}
          onTagsInput={updateTagsInput}
          onEnabled={(enabled) => updateManifest({ ...manifest, enabled })}
        />
      )}

      {section === 'timing' && (
        <TimingSection
          manifest={manifest}
          onChange={(timing) => updateManifest({ ...manifest, timing })}
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

      {section === 'categories' && (
        <CategoriesSection
          manifest={manifest}
          scenario={scenario}
          onScenarioChange={setScenario}
          onManifestUpdate={updateManifest}
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

// ── Per-section bodies for the simple sections ─────────────────

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

// ── Local primitives ─────────────────────────────────────────────

const INPUT_CLS =
  'w-full h-9 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';

function BodyCard({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 flex flex-col gap-3">
      {children}
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

// Re-export types for callers
export type { TimeWindow, TriggerKind };
