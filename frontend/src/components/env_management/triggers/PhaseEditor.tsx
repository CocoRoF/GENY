'use client';

/**
 * PhaseEditor — single phase row inside :mod:`TriggerPresetEditor`.
 *
 * A phase is a consecutive-trigger-count bracket plus a weighted
 * roulette table. The UI lets the operator:
 *
 *   - Edit the bracket (min / max, with max=null = open-ended top)
 *   - Reorder phases (↑/↓ within parent)
 *   - Add or remove events (one row per category, weight + remove)
 *   - Pick the category for new events from a dropdown of all defined
 *     categories that aren't already in this phase's events
 *
 * Weights are normalised at fire-time, but the editor surfaces the
 * total + per-event share so the operator can reason in percentages.
 */

import { useMemo } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Trash2,
  X,
} from 'lucide-react';

import type {
  PhaseEvent,
  TriggerCategory,
  TriggerPhase,
} from '@/types/triggerPreset';

const INPUT_SM =
  'h-7 px-2 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';

const ICON_BTN =
  'inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

export interface PhaseEditorProps {
  phase: TriggerPhase;
  categories: TriggerCategory[];
  isFirst: boolean;
  isLast: boolean;
  /** Sum of all event weights in this phase — drives the % column. */
  totalWeight: number;
  onPatch: (patch: Partial<TriggerPhase>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSetEvents: (events: PhaseEvent[]) => void;
}

export default function PhaseEditor({
  phase,
  categories,
  isFirst,
  isLast,
  totalWeight,
  onPatch,
  onRemove,
  onMoveUp,
  onMoveDown,
  onSetEvents,
}: PhaseEditorProps) {
  const referencedIds = useMemo(
    () => new Set(phase.events.map((e) => e.category_id)),
    [phase.events],
  );
  const availableCategories = useMemo(
    () => categories.filter((c) => !referencedIds.has(c.id)),
    [categories, referencedIds],
  );

  const totalForShare = totalWeight > 0 ? totalWeight : 1;

  const updateEvent = (
    categoryId: string,
    patch: Partial<PhaseEvent>,
  ) => {
    onSetEvents(
      phase.events.map((e) =>
        e.category_id === categoryId ? { ...e, ...patch } : e,
      ),
    );
  };

  const removeEvent = (categoryId: string) => {
    onSetEvents(phase.events.filter((e) => e.category_id !== categoryId));
  };

  const addEvent = (categoryId: string) => {
    if (!categoryId) return;
    if (referencedIds.has(categoryId)) return;
    onSetEvents([...phase.events, { category_id: categoryId, weight: 1 }]);
  };

  const handleMaxChange = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.toLowerCase() === '∞') {
      onPatch({ max_consecutive: null });
      return;
    }
    const n = Math.max(0, Math.round(Number(trimmed)));
    if (Number.isFinite(n)) onPatch({ max_consecutive: n });
  };

  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 flex flex-col gap-3">
      {/* ── Phase header ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
          페이즈
        </span>
        <input
          type="text"
          value={phase.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder="페이즈 이름"
          className={`${INPUT_SM} flex-1 min-w-[160px]`}
        />
        <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          연속 트리거
        </span>
        <input
          type="number"
          value={phase.min_consecutive}
          min={0}
          step={1}
          onChange={(e) =>
            onPatch({
              min_consecutive: Math.max(
                0,
                Math.round(Number(e.target.value)),
              ),
            })
          }
          className={`${INPUT_SM} w-16 text-center`}
        />
        <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          ~
        </span>
        <input
          type="text"
          value={phase.max_consecutive ?? '∞'}
          onChange={(e) => handleMaxChange(e.target.value)}
          className={`${INPUT_SM} w-16 text-center`}
          title="비워두거나 ∞ 입력 시 상한 없음"
        />
        <div className="flex-1 min-w-0" />
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            className={ICON_BTN}
            title="위로"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            className={ICON_BTN}
            title="아래로"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
            title="페이즈 삭제"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Event matrix ── */}
      {phase.events.length === 0 ? (
        <div className="rounded border border-dashed border-[hsl(var(--border))] px-3 py-4 text-center text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          이 페이즈는 아직 이벤트가 없어 발화하지 않습니다. 아래에서 카테고리를
          추가하세요.
        </div>
      ) : (
        <div className="rounded-md border border-[hsl(var(--border))] divide-y divide-[hsl(var(--border))]">
          <div className="grid grid-cols-[1fr_120px_80px_28px] items-center gap-2 px-3 py-1.5 text-[0.65rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold bg-[hsl(var(--muted)/0.4)]">
            <span>카테고리</span>
            <span>가중치</span>
            <span>비율</span>
            <span />
          </div>
          {phase.events.map((event) => {
            const cat = categories.find((c) => c.id === event.category_id);
            const share = totalWeight > 0
              ? (event.weight / totalForShare) * 100
              : 0;
            return (
              <div
                key={event.category_id}
                className="grid grid-cols-[1fr_120px_80px_28px] items-center gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-[0.8125rem] text-[hsl(var(--foreground))] truncate">
                    {cat?.label || event.category_id}
                    {!cat && (
                      <span className="ml-1.5 text-[0.6875rem] text-amber-600">
                        (없는 카테고리)
                      </span>
                    )}
                  </div>
                  <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] font-mono truncate">
                    {event.category_id}
                    {cat?.kind && (
                      <span className="ml-1.5 inline-block px-1 rounded text-[0.625rem] uppercase tracking-wider bg-[hsl(var(--muted))]">
                        {cat.kind}
                      </span>
                    )}
                  </div>
                </div>
                <input
                  type="number"
                  value={event.weight}
                  min={0}
                  step={1}
                  onChange={(e) =>
                    updateEvent(event.category_id, {
                      weight: Math.max(0, Number(e.target.value)),
                    })
                  }
                  className={`${INPUT_SM} text-right tabular-nums`}
                />
                <span className="text-[0.75rem] text-[hsl(var(--muted-foreground))] tabular-nums">
                  {share.toFixed(1)}%
                </span>
                <button
                  type="button"
                  onClick={() => removeEvent(event.category_id)}
                  className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
                  title="이벤트 제거"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[hsl(var(--muted)/0.25)] text-[0.7rem] text-[hsl(var(--muted-foreground))]">
            <span>총 가중치</span>
            <span className="tabular-nums font-semibold">
              {totalWeight.toFixed(1)}
            </span>
          </div>
        </div>
      )}

      {/* ── Add event ── */}
      {availableCategories.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            defaultValue=""
            onChange={(e) => {
              addEvent(e.target.value);
              // Reset the select so consecutive picks work.
              e.currentTarget.value = '';
            }}
            className={`${INPUT_SM} flex-1`}
          >
            <option value="" disabled>
              + 카테고리 선택해 추가
            </option>
            {availableCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label || c.id} ({c.kind})
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
