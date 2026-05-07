'use client';

/**
 * TriggerCard — single trigger row in the situation-centric view.
 *
 * Collapsed: name, weight, effective % (or block reason), condition
 * chips. Click to expand.
 *
 * Expanded: weight, conditions, prompts — everything edited in place,
 * one screen, no jumping between tabs.
 *
 * "Shared trigger" notice: when this trigger's underlying category is
 * referenced by multiple phases, edits to prompts/conditions/cooldown
 * propagate everywhere. The card surfaces this with a notice + a
 * "복제" affordance so operators can fork the trigger if they want
 * the current phase to diverge.
 */

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Copy,
  Lock,
  Trash2,
} from 'lucide-react';

import type {
  CategoryConditions,
  TriggerCategory,
  TriggerKind,
} from '@/types/triggerPreset';
import {
  describeConditions,
  type BlockedReason,
} from './triggerSimulator';
import ConditionsEditor from './ConditionsEditor';
import PromptsEditor from './PromptsEditor';

const INPUT_SM =
  'h-8 px-2.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';
const ICON_BTN =
  'inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors';

export interface TriggerReference {
  phaseId: string;
  phaseLabel: string;
  weight: number;
}

export interface TriggerCardProps {
  /** The underlying category — source of truth for prompts/conditions. */
  category: TriggerCategory;
  /** Weight of this trigger in the *current* (active) phase. */
  weight: number;
  /** Active phase's id — for label / context. */
  activePhaseId: string;
  activePhaseLabel: string;
  /** Block reason under the current scenario, if any. */
  blocked: BlockedReason | null;
  effectivePct: number;
  /** All phases that reference this trigger (incl. active phase). */
  references: TriggerReference[];

  /** Mutate weight in the active phase only. */
  onWeight: (w: number) => void;
  /** Mutate the underlying category — propagates to all references. */
  onCategoryPatch: (patch: Partial<TriggerCategory>) => void;
  /** Remove this trigger from the active phase. */
  onRemoveFromPhase: () => void;
  /** Fork: create a copy of this category and bind active phase to it. */
  onDuplicate: () => void;
}

export default function TriggerCard({
  category,
  weight,
  activePhaseId,
  activePhaseLabel,
  blocked,
  effectivePct,
  references,
  onWeight,
  onCategoryPatch,
  onRemoveFromPhase,
  onDuplicate,
}: TriggerCardProps) {
  const [expanded, setExpanded] = useState(false);

  const conditionChips = describeConditions(category);
  const otherRefs = references.filter((r) => r.phaseId !== activePhaseId);
  const isShared = otherRefs.length > 0;

  return (
    <div
      className={`rounded-lg border bg-[hsl(var(--background))] transition-colors ${
        blocked
          ? 'border-[hsl(var(--border))] opacity-70'
          : 'border-[hsl(var(--border))] hover:border-violet-500/30'
      }`}
    >
      {/* ── Collapsed row ── */}
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={ICON_BTN}
          title={expanded ? '접기' : '펼쳐서 편집'}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </button>

        {/* Trigger identity + chips */}
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[0.875rem] font-semibold text-[hsl(var(--foreground))] truncate">
              {category.label || category.id}
            </span>
            <span className="inline-block px-1.5 py-0.5 rounded text-[0.6rem] uppercase tracking-wider bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
              {category.kind}
            </span>
            <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] font-mono">
              {category.id}
            </span>
            {isShared && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.65rem] font-medium bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30"
                title={`${otherRefs.length}개 다른 페이즈에서도 사용 중 — 프롬프트/조건은 공유됨`}
              >
                <Copy className="w-3 h-3" />
                공유 ({references.length}개 페이즈)
              </span>
            )}
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

          {blocked && (
            <div className="inline-flex items-center gap-1 text-[0.7rem] text-red-600 dark:text-red-400">
              {blocked.code === 'unknown_category' ? (
                <Lock className="w-3 h-3" />
              ) : (
                <CircleSlash className="w-3 h-3" />
              )}
              <span>차단 — {blocked.message}</span>
            </div>
          )}
        </div>

        {/* Weight + % column */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex flex-col items-end gap-0.5">
            <label className="text-[0.625rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              가중치
            </label>
            <input
              type="number"
              value={weight}
              min={0}
              step={1}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                const n = Math.max(0, Number(e.target.value));
                if (Number.isFinite(n)) onWeight(n);
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
              `이 페이즈("${activePhaseLabel}")에서 "${
                category.label || category.id
              }" 트리거를 제거할까요?`,
            );
            if (ok) onRemoveFromPhase();
          }}
          className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
          title={`이 페이즈("${activePhaseLabel}")에서 트리거 제거`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div className="border-t border-[hsl(var(--border))] p-4 flex flex-col gap-4">
          {/* Sharing notice */}
          {isShared && (
            <div className="rounded-md border border-sky-500/25 bg-sky-500/5 px-3 py-2.5 text-[0.75rem] text-sky-800 dark:text-sky-300 flex items-start gap-2">
              <Copy className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium mb-0.5">
                  공유된 트리거입니다
                </div>
                <div className="leading-relaxed">
                  이 트리거의 <strong>이름 / 조건 / 쿨다운 / 프롬프트</strong>는
                  다른{' '}
                  <strong>
                    {otherRefs.map((r) => r.phaseLabel).join(', ')}
                  </strong>{' '}
                  에서도 동일하게 쓰여요. 이 페이즈에서만 다르게 만들고
                  싶다면{' '}
                  <button
                    type="button"
                    onClick={onDuplicate}
                    className="underline font-medium hover:no-underline"
                  >
                    복제 후 분리
                  </button>
                  하세요. (가중치는 페이즈마다 따로 관리됩니다.)
                </div>
              </div>
            </div>
          )}

          {/* Identity */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={category.label}
              onChange={(e) => onCategoryPatch({ label: e.target.value })}
              placeholder="트리거 이름"
              className={`${INPUT_SM} flex-1 min-w-[200px]`}
            />
            <input
              type="text"
              value={category.id}
              onChange={(e) =>
                onCategoryPatch({
                  id: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_'),
                })
              }
              placeholder="trigger_id"
              className={`${INPUT_SM} w-44 font-mono text-[0.7rem]`}
              title="ID — 페이즈 이벤트 참조에 쓰임. 변경 시 기존 참조가 끊어집니다."
            />
            <select
              value={category.kind}
              onChange={(e) =>
                onCategoryPatch({ kind: e.target.value as TriggerKind })
              }
              className={INPUT_SM}
            >
              <option value="thinking">Thinking</option>
              <option value="activity">Activity</option>
            </select>
          </div>

          {/* Conditions */}
          <ConditionsEditor
            conditions={category.conditions}
            cooldownSeconds={category.cooldown_seconds}
            onConditions={(c: CategoryConditions) =>
              onCategoryPatch({ conditions: c })
            }
            onCooldown={(s: number) =>
              onCategoryPatch({ cooldown_seconds: s })
            }
          />

          {/* Prompts */}
          <PromptsEditor
            prompts={category.prompts}
            onChange={(p) => onCategoryPatch({ prompts: p })}
          />
        </div>
      )}
    </div>
  );
}
