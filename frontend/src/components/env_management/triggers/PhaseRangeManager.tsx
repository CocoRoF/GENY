'use client';

/**
 * PhaseRangeManager — manage *only* the consec-count buckets ("페이즈
 * 범위") that drive which trigger group is active for a given session.
 *
 * Lives at the bottom of :mod:`TriggersSection` as an expandable
 * "advanced" panel. The vast majority of operators won't need to touch
 * it — the default 3-bucket layout (0-0 / 1-3 / 4+) covers every
 * historical preset. When they do open it, the controls are limited
 * to:
 *
 *   - Rename a phase
 *   - Adjust the [min, max] range (max=null = open-ended)
 *   - Reorder (up / down)
 *   - Delete
 *   - Add a new phase (appends with auto-computed range)
 *
 * Triggers (events + categories) live elsewhere — this component owns
 * only the consec-range axis.
 */

import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';

import type { TriggerPhase } from '@/types/triggerPreset';

const INPUT_SM =
  'h-7 px-2 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';
const ICON_BTN =
  'inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

export interface PhaseRangeManagerProps {
  phases: TriggerPhase[];
  /** Phase id that the situation picker is currently focused on. */
  activePhaseId: string | null;
  onPatch: (phaseId: string, patch: Partial<TriggerPhase>) => void;
  onRemove: (phaseId: string) => void;
  onMove: (phaseId: string, dir: -1 | 1) => void;
  onAdd: () => void;
}

export default function PhaseRangeManager({
  phases,
  activePhaseId,
  onPatch,
  onRemove,
  onMove,
  onAdd,
}: PhaseRangeManagerProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-[hsl(var(--accent))/0.4] transition-colors"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
        ) : (
          <ChevronRight className="w-4 h-4 text-[hsl(var(--muted-foreground))]" />
        )}
        <span className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
          고급 — 페이즈 범위 관리
        </span>
        <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          · 연속 트리거 횟수에 따라 다른 가중치를 쓰고 싶을 때
        </span>
        <span className="ml-auto text-[0.7rem] text-[hsl(var(--muted-foreground))]">
          {phases.length}개 페이즈
        </span>
      </button>

      {open && (
        <div className="border-t border-[hsl(var(--border))] p-4 flex flex-col gap-3">
          <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
            페이즈는 연속 트리거 횟수에 따라 트리거의 가중치를 다르게 적용하기
            위한 그룹입니다. 처음 침묵, 지속 침묵, 장기 침묵처럼 단계별로
            다른 행동을 주고 싶을 때만 쓰세요. 단순한 프리셋이라면 페이즈는
            하나만 있어도 충분합니다.
          </p>

          <div className="flex flex-col gap-2">
            {phases.map((phase, idx) => {
              const isActive = phase.id === activePhaseId;
              return (
                <div
                  key={phase.id}
                  className={`flex items-center gap-2 p-2.5 rounded-md border ${
                    isActive
                      ? 'border-violet-500/40 bg-violet-500/5'
                      : 'border-[hsl(var(--border))] bg-[hsl(var(--background))]'
                  }`}
                >
                  {isActive && (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[0.6rem] uppercase tracking-wider font-semibold bg-violet-500/15 text-violet-700 dark:text-violet-300">
                      활성
                    </span>
                  )}
                  <input
                    type="text"
                    value={phase.label}
                    onChange={(e) =>
                      onPatch(phase.id, { label: e.target.value })
                    }
                    placeholder="페이즈 이름"
                    className={`${INPUT_SM} flex-1 min-w-[120px]`}
                  />
                  <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
                    consec
                  </span>
                  <input
                    type="number"
                    value={phase.min_consecutive}
                    min={0}
                    step={1}
                    onChange={(e) =>
                      onPatch(phase.id, {
                        min_consecutive: Math.max(
                          0,
                          Math.round(Number(e.target.value)),
                        ),
                      })
                    }
                    className={`${INPUT_SM} w-14 text-center`}
                  />
                  <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
                    ~
                  </span>
                  <input
                    type="text"
                    value={phase.max_consecutive ?? '∞'}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      if (v === '' || v === '∞') {
                        onPatch(phase.id, { max_consecutive: null });
                      } else {
                        const n = Math.max(0, Math.round(Number(v)));
                        if (Number.isFinite(n))
                          onPatch(phase.id, { max_consecutive: n });
                      }
                    }}
                    className={`${INPUT_SM} w-14 text-center`}
                    title="비워두거나 ∞ 입력 시 상한 없음"
                  />
                  <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] tabular-nums">
                    이벤트 {phase.events.length}개
                  </span>
                  <div className="flex items-center gap-0.5 ml-auto">
                    <button
                      type="button"
                      onClick={() => onMove(phase.id, -1)}
                      disabled={idx === 0}
                      className={ICON_BTN}
                      title="위로"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onMove(phase.id, 1)}
                      disabled={idx === phases.length - 1}
                      className={ICON_BTN}
                      title="아래로"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const ok = window.confirm(
                          `"${
                            phase.label || phase.id
                          }" 페이즈를 삭제할까요? 이 페이즈에 등록된 이벤트도 함께 사라집니다.`,
                        );
                        if (ok) onRemove(phase.id);
                      }}
                      className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
                      title="페이즈 삭제"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={onAdd}
            className="self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            페이즈 추가
          </button>
        </div>
      )}
    </div>
  );
}
