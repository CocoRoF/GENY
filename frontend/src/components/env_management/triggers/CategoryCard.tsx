'use client';

/**
 * CategoryCard — one situation card.
 *
 * Each card represents *one situation* (= category). It owns:
 *
 *   • Identity:  label, kind (thinking/activity), id (auto-generated)
 *   • Conditions: when this situation applies — consec range, Sub-Worker
 *                 state, time window, cooldown.
 *   • Weight:     how often this situation gets picked when multiple
 *                 situations match the current scenario (stage-1
 *                 roulette). Effective percentage under the active
 *                 scenario is shown next to it.
 *   • Prompts:    natural-language variants the agent might say when
 *                 this situation fires. Each variant has a sub-weight
 *                 (within-category roulette).
 *
 * The collapsed row shows the bare minimum: name, kind chip, condition
 * chips, situation weight, effective %. Click anywhere to expand and
 * edit everything inline.
 *
 * The "[THINKING_TRIGGER:id] [autonomous_signal: …]" tag prefix is
 * **never typed by the operator**. A small live preview shows what the
 * runtime will actually send for each prompt, generated from category
 * metadata.
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
  TriggerPromptVariant,
} from '@/types/triggerPreset';
import {
  describeConditions,
  renderPrompt,
  type BlockedReason,
} from './triggerSimulator';

const INPUT_SM =
  'h-8 px-2.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';
const TEXTAREA =
  'w-full px-2.5 py-1.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.875rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 resize-y';
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
  blocked: BlockedReason | null;
  effectivePct: number;
  /** Forced-expand control (e.g., when newly created). */
  defaultExpanded?: boolean;

  onPatch: (patch: Partial<TriggerCategory>) => void;
  onDelete: () => void;
}

export default function CategoryCard({
  category,
  blocked,
  effectivePct,
  defaultExpanded = false,
  onPatch,
  onDelete,
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
              {category.prompts.length}개 프롬프트
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
          <PromptsBlock category={category} onPatch={onPatch} />
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
        {/* Consec range */}
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
          <p className="text-[0.65rem] text-[hsl(var(--muted-foreground))]">
            {category.consec_min === 0 && category.consec_max === null
              ? '제한 없음 — 모든 횟수에서 후보'
              : `이 범위의 침묵에서만 후보 (예: 첫 침묵=0~0, 지속=1~3)`}
          </p>
        </div>

        {/* Sub-Worker mode */}
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

        {/* Time window */}
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

        {/* Cooldown */}
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
          <p className="text-[0.65rem] text-[hsl(var(--muted-foreground))]">
            한 번 발사된 후 이 시간 동안은 같은 상황이 다시 후보가 되지 않습니다.
          </p>
        </div>
      </div>
    </section>
  );
}

// ── Prompts ─────────────────────────────────────────────────────

function PromptsBlock({
  category,
  onPatch,
}: {
  category: TriggerCategory;
  onPatch: (patch: Partial<TriggerCategory>) => void;
}) {
  const setPrompts = (next: TriggerPromptVariant[]) => {
    onPatch({ prompts: next });
  };

  const addPrompt = () => {
    setPrompts([
      ...category.prompts,
      { weight: 1, content: { en: '', ko: '' } },
    ]);
  };

  const removePrompt = (idx: number) => {
    setPrompts(category.prompts.filter((_, i) => i !== idx));
  };

  const updatePrompt = (idx: number, patch: Partial<TriggerPromptVariant>) => {
    setPrompts(
      category.prompts.map((p, i) => (i === idx ? { ...p, ...patch } : p)),
    );
  };

  const setLocaleContent = (idx: number, locale: string, text: string) => {
    const current = category.prompts[idx];
    if (!current) return;
    const nextContent = { ...current.content, [locale]: text };
    updatePrompt(idx, { content: nextContent });
  };

  const totalWeight = category.prompts.reduce(
    (s, p) => s + Math.max(0, p.weight),
    0,
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <SectionLabel>이 상황에서 어떤 말을 하나요? (프롬프트)</SectionLabel>
        <button
          type="button"
          onClick={addPrompt}
          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-[hsl(var(--border))] text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
        >
          <Plus className="w-3 h-3" />
          프롬프트 변형 추가
        </button>
      </div>

      <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] -mt-1">
        이 상황이 선택되면 아래 변형 중 하나가 가중치에 따라 무작위로 발사됩니다.
        자연어만 적으세요 — 시스템 태그는 자동으로 붙습니다.
      </p>

      {category.prompts.length === 0 ? (
        <div className="rounded-md border border-dashed border-[hsl(var(--border))] px-4 py-6 text-center text-[0.75rem] text-[hsl(var(--muted-foreground))]">
          프롬프트가 없으면 이 상황은 발화하지 않습니다.{' '}
          <button
            type="button"
            onClick={addPrompt}
            className="text-violet-600 dark:text-violet-300 underline"
          >
            첫 프롬프트 추가
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {category.prompts.map((prompt, idx) => {
            const promptShare =
              totalWeight > 0
                ? (Math.max(0, prompt.weight) / totalWeight) * 100
                : 0;
            return (
              <PromptVariantEditor
                key={idx}
                index={idx}
                prompt={prompt}
                category={category}
                share={promptShare}
                onWeight={(w) => updatePrompt(idx, { weight: w })}
                onLocale={(locale, text) =>
                  setLocaleContent(idx, locale, text)
                }
                onRemoveLocale={(locale) => {
                  const next = { ...prompt.content };
                  delete next[locale];
                  updatePrompt(idx, { content: next });
                }}
                onRemove={() => removePrompt(idx)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function PromptVariantEditor({
  index,
  prompt,
  category,
  share,
  onWeight,
  onLocale,
  onRemoveLocale,
  onRemove,
}: {
  index: number;
  prompt: TriggerPromptVariant;
  category: TriggerCategory;
  share: number;
  onWeight: (w: number) => void;
  onLocale: (locale: string, text: string) => void;
  onRemoveLocale: (locale: string) => void;
  onRemove: () => void;
}) {
  const [newLocale, setNewLocale] = useState('');
  const locales = Object.keys(prompt.content);
  // Always show en + ko as canonical surfaces
  const surfaceLocales = Array.from(new Set(['en', 'ko', ...locales]));

  const previewLocale =
    prompt.content['ko'] || prompt.content['en'] || prompt.content[locales[0]] || '';

  const addLocale = () => {
    const trimmed = newLocale.trim().toLowerCase();
    if (!trimmed || prompt.content[trimmed] !== undefined) return;
    onLocale(trimmed, '');
    setNewLocale('');
  };

  return (
    <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[hsl(var(--border))]">
        <span className="text-[0.7rem] font-semibold text-[hsl(var(--foreground))]">
          변형 #{index + 1}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex flex-col items-end">
            <label className="text-[0.6rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              가중치
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={prompt.weight}
                min={0}
                step={1}
                onChange={(e) => {
                  const n = Math.max(0, Number(e.target.value));
                  if (Number.isFinite(n)) onWeight(n);
                }}
                className={`${INPUT_SM} w-20 text-right tabular-nums h-7`}
              />
              <span className="text-[0.7rem] text-violet-700 dark:text-violet-300 tabular-nums w-12 text-right">
                {share.toFixed(0)}%
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onRemove}
            className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
            title="변형 제거"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="p-3 flex flex-col gap-2.5">
        {surfaceLocales.map((locale) => {
          const text = prompt.content[locale] ?? '';
          const isCanonical = locale === 'en' || locale === 'ko';
          return (
            <div key={locale} className="flex items-start gap-2">
              <div className="flex flex-col items-center gap-0.5 pt-1.5 min-w-[44px]">
                <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
                  {locale}
                </span>
                {!isCanonical && (
                  <button
                    type="button"
                    onClick={() => onRemoveLocale(locale)}
                    className="text-[0.6rem] text-[hsl(var(--muted-foreground))] hover:text-red-500"
                    title={`${locale} 로케일 제거`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <textarea
                value={text}
                onChange={(e) => onLocale(locale, e.target.value)}
                rows={2}
                placeholder={
                  locale === 'ko'
                    ? '예: 잠깐 조용해졌다. 내 내부 인식이 최근 대화 흐름을 감지하고 있다.'
                    : 'e.g., A brief silence has settled. My internal awareness notices recent conversation threads still in context.'
                }
                className={TEXTAREA}
              />
            </div>
          );
        })}

        <div className="flex items-center gap-1.5 pt-1">
          <input
            type="text"
            value={newLocale}
            onChange={(e) => setNewLocale(e.target.value)}
            placeholder="새 로케일 코드 (예: ja)"
            className={`${INPUT_SM} w-40 text-[0.7rem] h-7`}
          />
          <button
            type="button"
            onClick={addLocale}
            className="h-7 px-2 rounded text-[0.7rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]"
          >
            로케일 추가
          </button>
        </div>

        {/* Live preview of the rendered prompt */}
        {previewLocale && (
          <div className="rounded border border-violet-500/20 bg-violet-500/5 px-3 py-2 mt-1">
            <div className="text-[0.625rem] uppercase tracking-wider text-violet-700 dark:text-violet-300 font-semibold mb-1">
              실제 발사되는 형태 (시스템 자동 생성)
            </div>
            <div className="text-[0.7rem] font-mono text-[hsl(var(--foreground))] leading-relaxed break-words">
              {renderPrompt(category, previewLocale)}
            </div>
          </div>
        )}
      </div>
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
