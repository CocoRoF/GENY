'use client';

/**
 * CategoryCard — one situation card.
 *
 * Each card represents *one situation* (= category). It owns:
 *
 *   • Identity:       label, kind (thinking/activity), id (auto)
 *   • Conditions:     when this situation applies — consec range,
 *                     Sub-Worker state, time window, cooldown.
 *   • Weight:         how often this situation is picked when
 *                     multiple situations match (stage-1 roulette).
 *                     Effective % under the active scenario shown next
 *                     to it.
 *   • Prompt refs:    list of prompts (from the library) that this
 *                     situation can fire, each with a per-reference
 *                     weight (stage-2 roulette).
 *
 * Prompt content is NOT edited here — only references. Editing the
 * prompt text happens in the "프롬프트" library section, and changes
 * propagate automatically to every situation that references it.
 */

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import type {
  TimeWindow,
  TriggerCategory,
  TriggerKind,
  TriggerPrompt,
  PromptRef,
} from '@/types/triggerPreset';
import {
  describeConditions,
  renderPrompt,
  type BlockedReason,
} from './triggerSimulator';

const INPUT_SM =
  'h-8 px-2.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';
const ICON_BTN =
  'inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors';

const TIME_WINDOW_OPTIONS: { value: TimeWindow | ''; label: string }[] = [
  { value: '', label: '제한 없음' },
  { value: 'morning', label: '아침' },
  { value: 'afternoon', label: '오후' },
  { value: 'evening', label: '저녁' },
  { value: 'night', label: '밤' },
];

export interface CategoryCardProps {
  category: TriggerCategory;
  /** Full prompt library — used to render labels + previews + the picker. */
  promptLibrary: TriggerPrompt[];
  blocked: BlockedReason | null;
  effectivePct: number;
  defaultExpanded?: boolean;

  onPatch: (patch: Partial<TriggerCategory>) => void;
  onDelete: () => void;
  /** Jump to the prompts library section (e.g. for editing wording). */
  onJumpToPrompts?: () => void;
}

export default function CategoryCard({
  category,
  promptLibrary,
  blocked,
  effectivePct,
  defaultExpanded = false,
  onPatch,
  onDelete,
  onJumpToPrompts,
}: CategoryCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const conditionChips = describeConditions(category);

  return (
    <div
      className={`rounded-lg border bg-[hsl(var(--background))] transition-all ${
        blocked
          ? 'border-[hsl(var(--border))] opacity-70'
          : 'border-[hsl(var(--border))] hover:border-violet-500/30'
      } ${expanded ? 'shadow-sm' : ''}`}
    >
      {/* ── Collapsed row ── */}
      <div
        className="flex items-start gap-2 p-3 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <button
          type="button"
          className={ICON_BTN}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </button>

        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[0.9375rem] font-semibold text-[hsl(var(--foreground))] truncate">
              {category.label || category.id}
            </span>
            <span className="inline-block px-1.5 py-0.5 rounded text-[0.625rem] uppercase tracking-wider bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
              {category.kind}
            </span>
            <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] tabular-nums">
              {category.prompt_refs.length}개 프롬프트 참조
            </span>
          </div>

          {conditionChips.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {conditionChips.map((chip, i) => (
                <span
                  key={i}
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[0.65rem] font-medium ${
                    chip.tone === 'warn'
                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30'
                      : chip.tone === 'info'
                        ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30'
                        : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))]'
                  }`}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          )}

          {conditionChips.length === 0 && (
            <span className="text-[0.65rem] italic text-[hsl(var(--muted-foreground))]">
              조건 없음 — 모든 상황에서 후보
            </span>
          )}

          {blocked && (
            <div className="inline-flex items-center gap-1 text-[0.7rem] text-red-600 dark:text-red-400">
              <CircleSlash className="w-3 h-3" />
              <span>차단 — {blocked.message}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex flex-col items-end gap-0.5">
            <label className="text-[0.625rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              상황 가중치
            </label>
            <input
              type="number"
              value={category.weight}
              min={0}
              step={1}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const n = Math.max(0, Number(e.target.value));
                if (Number.isFinite(n)) onPatch({ weight: n });
              }}
              className={`${INPUT_SM} w-20 text-right tabular-nums`}
            />
          </div>
          <div className="flex flex-col items-end gap-0.5 min-w-[64px]">
            <label className="text-[0.625rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              실제 비율
            </label>
            {blocked ? (
              <span className="text-[0.875rem] text-[hsl(var(--muted-foreground))]">
                —
              </span>
            ) : (
              <span className="text-[0.9375rem] font-bold text-violet-700 dark:text-violet-300 tabular-nums">
                {effectivePct.toFixed(1)}%
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const ok = window.confirm(
              `"${category.label || category.id}" 상황을 삭제할까요?`,
            );
            if (ok) onDelete();
          }}
          className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
          title="이 상황 삭제"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div className="border-t border-[hsl(var(--border))] p-4 flex flex-col gap-5">
          <IdentityRow category={category} onPatch={onPatch} />
          <ConditionsBlock category={category} onPatch={onPatch} />
          <PromptRefsBlock
            category={category}
            promptLibrary={promptLibrary}
            onPatch={onPatch}
            onJumpToPrompts={onJumpToPrompts}
          />
          <AdvancedBlock category={category} onPatch={onPatch} />
        </div>
      )}
    </div>
  );
}

// ── Identity ───────────────────────────────────────────────────

function IdentityRow({
  category,
  onPatch,
}: {
  category: TriggerCategory;
  onPatch: (patch: Partial<TriggerCategory>) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>이 상황은 무엇인가요?</SectionLabel>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-2">
        <input
          type="text"
          value={category.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder="상황 이름 — 예: '첫 침묵', '점심 시간대 분위기'"
          className={INPUT_SM}
        />
        <select
          value={category.kind}
          onChange={(e) => onPatch({ kind: e.target.value as TriggerKind })}
          className={INPUT_SM}
        >
          <option value="thinking">Thinking — 생각 (도구 X)</option>
          <option value="activity">Activity — Sub-Worker 위임</option>
        </select>
      </div>
    </section>
  );
}

// ── Conditions ─────────────────────────────────────────────────

function ConditionsBlock({
  category,
  onPatch,
}: {
  category: TriggerCategory;
  onPatch: (patch: Partial<TriggerCategory>) => void;
}) {
  const subWorkerMode: 'any' | 'busy' | 'idle' = category.requires_sub_worker_busy
    ? 'busy'
    : category.requires_sub_worker_idle
      ? 'idle'
      : 'any';

  const setSubWorker = (mode: 'any' | 'busy' | 'idle') => {
    onPatch({
      requires_sub_worker_busy: mode === 'busy',
      requires_sub_worker_idle: mode === 'idle',
    });
  };

  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>언제 발화되나요? (조건)</SectionLabel>
      <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] -mt-1">
        모든 조건을 만족할 때만 이 상황이 후보가 됩니다. 비워두면 그 축에는
        제한 없음.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            연속 트리거 횟수 (consec)
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              value={category.consec_min}
              min={0}
              step={1}
              onChange={(e) =>
                onPatch({
                  consec_min: Math.max(0, Math.round(Number(e.target.value))),
                })
              }
              className={`${INPUT_SM} w-20 text-center`}
            />
            <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              ~
            </span>
            <input
              type="text"
              value={category.consec_max ?? '∞'}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === '' || v === '∞') {
                  onPatch({ consec_max: null });
                  return;
                }
                const n = Math.max(0, Math.round(Number(v)));
                if (Number.isFinite(n)) onPatch({ consec_max: n });
              }}
              className={`${INPUT_SM} w-20 text-center`}
              title="비워두거나 ∞ 입력 시 상한 없음"
            />
            <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              회
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            Sub-Worker 상태
          </label>
          <div className="flex items-center gap-1">
            {(['any', 'busy', 'idle'] as const).map((mode) => {
              const active = subWorkerMode === mode;
              const labelMap = {
                any: '제한 없음',
                busy: '작업 중일 때만',
                idle: 'idle일 때만',
              } as const;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSubWorker(mode)}
                  className={`h-8 px-2.5 rounded-md text-[0.75rem] font-medium border transition-colors ${
                    active
                      ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40'
                      : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
                  }`}
                >
                  {labelMap[mode]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            화면 관찰
          </label>
          <button
            type="button"
            onClick={() =>
              onPatch({ requires_screen_active: !category.requires_screen_active })
            }
            title="켜면 사용자가 화면 공유 중일 때만 발동하고, 라이브 화면 프레임이 자동 첨부됩니다"
            className={`h-8 px-2.5 rounded-md text-[0.75rem] font-medium border transition-colors ${
              category.requires_screen_active
                ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40'
                : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
            }`}
          >
            {category.requires_screen_active ? '화면 공유 중일 때만' : '제한 없음'}
          </button>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            시간대
          </label>
          <select
            value={category.time_window ?? ''}
            onChange={(e) =>
              onPatch({
                time_window: (e.target.value || null) as TimeWindow | null,
              })
            }
            className={INPUT_SM}
          >
            {TIME_WINDOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            쿨다운 (초)
          </label>
          <input
            type="number"
            value={category.cooldown_seconds}
            min={0}
            step={5}
            onChange={(e) => {
              const n = Math.max(0, Number(e.target.value));
              if (Number.isFinite(n)) onPatch({ cooldown_seconds: n });
            }}
            className={INPUT_SM}
          />
        </div>
      </div>
    </section>
  );
}

// ── Prompt refs ────────────────────────────────────────────────

function PromptRefsBlock({
  category,
  promptLibrary,
  onPatch,
  onJumpToPrompts,
}: {
  category: TriggerCategory;
  promptLibrary: TriggerPrompt[];
  onPatch: (patch: Partial<TriggerCategory>) => void;
  onJumpToPrompts?: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const promptIndex = new Map(promptLibrary.map((p) => [p.id, p]));
  const referencedIds = new Set(category.prompt_refs.map((r) => r.prompt_id));
  const attachable = promptLibrary.filter((p) => !referencedIds.has(p.id));

  const totalWeight = category.prompt_refs.reduce(
    (s, r) => s + Math.max(0, r.weight),
    0,
  );

  const setRefs = (next: PromptRef[]) => {
    onPatch({ prompt_refs: next });
  };

  const updateRef = (idx: number, patch: Partial<PromptRef>) => {
    setRefs(
      category.prompt_refs.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  };

  const removeRef = (idx: number) => {
    setRefs(category.prompt_refs.filter((_, i) => i !== idx));
  };

  const attachPrompt = (promptId: string) => {
    if (!promptId || referencedIds.has(promptId)) return;
    setRefs([...category.prompt_refs, { prompt_id: promptId, weight: 1 }]);
    setPickerOpen(false);
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <SectionLabel>이 상황에서 어떤 말을 하나요? (프롬프트 참조)</SectionLabel>
        <div className="flex items-center gap-1.5">
          {onJumpToPrompts && (
            <button
              type="button"
              onClick={onJumpToPrompts}
              className="text-[0.7rem] text-violet-600 dark:text-violet-300 hover:underline"
            >
              프롬프트 라이브러리 편집 →
            </button>
          )}
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-[hsl(var(--border))] text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
            disabled={attachable.length === 0}
            title={
              attachable.length === 0
                ? '연결할 프롬프트가 없어요. 라이브러리에서 먼저 추가하세요.'
                : '라이브러리에서 프롬프트 연결'
            }
          >
            <Plus className="w-3 h-3" />
            프롬프트 연결
          </button>
        </div>
      </div>

      <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] -mt-1">
        이 상황이 선택되면 아래 프롬프트 중 하나가 가중치에 따라 무작위로
        발사됩니다. 같은 프롬프트를 다른 상황에서도 다른 가중치로 쓸 수 있어요.
      </p>

      {pickerOpen && (
        <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-2 flex flex-col gap-1 max-h-60 overflow-y-auto">
          {attachable.length === 0 ? (
            <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))] py-2 text-center">
              연결할 프롬프트가 없어요. 라이브러리에서 먼저 추가하세요.
            </span>
          ) : (
            attachable.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => attachPrompt(p.id)}
                className="text-left rounded px-2 py-1.5 hover:bg-violet-500/10 flex flex-col gap-0.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
                    {p.label || p.id}
                  </span>
                  <span className="text-[0.65rem] text-[hsl(var(--muted-foreground))] font-mono">
                    {p.id}
                  </span>
                </div>
                <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))] line-clamp-1">
                  {p.content['ko'] || p.content['en'] || '(빈 프롬프트)'}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {category.prompt_refs.length === 0 ? (
        <div className="rounded-md border border-dashed border-[hsl(var(--border))] px-4 py-6 text-center text-[0.75rem] text-[hsl(var(--muted-foreground))]">
          아직 연결된 프롬프트가 없어요.{' '}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="text-violet-600 dark:text-violet-300 underline"
          >
            프롬프트 연결
          </button>
          {' '}을 누르세요.
        </div>
      ) : (
        <div className="rounded-md border border-[hsl(var(--border))] divide-y divide-[hsl(var(--border))]">
          <div className="grid grid-cols-[1fr_120px_70px_28px] items-center gap-2 px-3 py-1.5 text-[0.65rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold bg-[hsl(var(--muted)/0.4)]">
            <span>프롬프트</span>
            <span className="text-right">참조 가중치</span>
            <span className="text-right">비율</span>
            <span />
          </div>
          {category.prompt_refs.map((ref, idx) => {
            const prompt = promptIndex.get(ref.prompt_id);
            const share =
              totalWeight > 0
                ? (Math.max(0, ref.weight) / totalWeight) * 100
                : 0;
            return (
              <PromptRefRow
                key={`${ref.prompt_id}-${idx}`}
                category={category}
                prompt={prompt ?? null}
                promptId={ref.prompt_id}
                weight={ref.weight}
                share={share}
                onWeight={(w) => updateRef(idx, { weight: w })}
                onRemove={() => removeRef(idx)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function PromptRefRow({
  category,
  prompt,
  promptId,
  weight,
  share,
  onWeight,
  onRemove,
}: {
  category: TriggerCategory;
  prompt: TriggerPrompt | null;
  promptId: string;
  weight: number;
  share: number;
  onWeight: (w: number) => void;
  onRemove: () => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const previewLocale = prompt
    ? prompt.content['ko'] ||
      prompt.content['en'] ||
      Object.values(prompt.content)[0] ||
      ''
    : '';

  return (
    <div className="grid grid-cols-[1fr_120px_70px_28px] items-start gap-2 px-3 py-2.5">
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))] truncate">
            {prompt?.label || promptId}
          </span>
          <span className="text-[0.65rem] text-[hsl(var(--muted-foreground))] font-mono">
            {promptId}
          </span>
          {!prompt && (
            <span className="text-[0.65rem] text-amber-600">
              (라이브러리에 없음)
            </span>
          )}
        </div>
        {previewLocale && (
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="text-[0.7rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] text-left line-clamp-1"
            title={showPreview ? '미리보기 숨기기' : '실제 발사 형태 미리보기'}
          >
            {previewLocale}
          </button>
        )}
        {showPreview && prompt && (
          <div className="rounded border border-violet-500/20 bg-violet-500/5 px-2 py-1.5 mt-1">
            <div className="text-[0.6rem] uppercase tracking-wider text-violet-700 dark:text-violet-300 font-semibold mb-0.5">
              실제 발사 형태
            </div>
            <div className="text-[0.7rem] font-mono leading-relaxed break-words">
              {renderPrompt(category, previewLocale)}
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end pt-0.5">
        <input
          type="number"
          value={weight}
          min={0}
          step={1}
          onChange={(e) => {
            const n = Math.max(0, Number(e.target.value));
            if (Number.isFinite(n)) onWeight(n);
          }}
          className={`${INPUT_SM} w-24 text-right tabular-nums h-7`}
        />
      </div>
      <div className="text-right pt-1.5 tabular-nums">
        <span className="text-[0.75rem] text-violet-700 dark:text-violet-300 font-medium">
          {share.toFixed(0)}%
        </span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
        title="참조 해제"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── Advanced ───────────────────────────────────────────────────

function AdvancedBlock({
  category,
  onPatch,
}: {
  category: TriggerCategory;
  onPatch: (patch: Partial<TriggerCategory>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-2 border-t border-[hsl(var(--border))] pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
        )}
        <span className="text-[0.7rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
          고급
        </span>
        <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          · ID 변경 / autonomous_signal 메타데이터
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 pl-5">
          <div className="flex flex-col gap-1">
            <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              상황 ID (자동 생성, 변경 시 외부 참조 끊김)
            </label>
            <input
              type="text"
              value={category.id}
              onChange={(e) =>
                onPatch({ id: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })
              }
              className={`${INPUT_SM} font-mono text-[0.7rem] w-72`}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              autonomous_signal 메타데이터 (선택)
            </label>
            <input
              type="text"
              value={category.autonomous_signal}
              onChange={(e) => onPatch({ autonomous_signal: e.target.value })}
              placeholder="예: idle_detected, elapsed=short"
              className={`${INPUT_SM} font-mono text-[0.7rem]`}
            />
            <p className="text-[0.65rem] text-[hsl(var(--muted-foreground))]">
              비워두면 [autonomous_signal: …] 블록이 발사 메시지에서 생략됩니다.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Common ─────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[0.75rem] uppercase tracking-wider font-semibold text-[hsl(var(--foreground))]">
      {children}
    </div>
  );
}
