'use client';

/**
 * CategoryEditor — single category row inside :mod:`TriggerPresetEditor`.
 *
 * A category bundles:
 *   - id (immutable identifier referenced by phase events)
 *   - label, kind (thinking|activity), conditions, cooldown
 *   - prompts: locale → list of variants
 *
 * Conditions edit gates that filter the event out of the roulette
 * when the runtime context doesn't satisfy them — sub-worker state,
 * time-of-day window, consecutive-count bounds.
 *
 * Prompts editor is one block per locale with add/remove for
 * individual variants. EN and KO are surfaced as fixed slots; an
 * "add locale" affordance lets operators ship presets in additional
 * languages without code changes.
 */

import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import type {
  CategoryConditions,
  TriggerCategory,
  TriggerKind,
  TimeWindow,
} from '@/types/triggerPreset';

const INPUT_SM =
  'h-8 px-2.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';
const TEXTAREA =
  'w-full px-2.5 py-1.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 resize-y';
const ICON_BTN =
  'inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors';

const KIND_OPTIONS: { value: TriggerKind; label: string; hint: string }[] = [
  {
    value: 'thinking',
    label: 'Thinking',
    hint: '[THINKING_TRIGGER] 태그 — 자가 발화. 도구 사용 없음.',
  },
  {
    value: 'activity',
    label: 'Activity',
    hint: '[ACTIVITY_TRIGGER] 태그 — Sub-Worker로 위임 (웹 검색 등).',
  },
];

const TIME_WINDOWS: { value: TimeWindow | ''; label: string }[] = [
  { value: '', label: '제한 없음' },
  { value: 'morning', label: '아침' },
  { value: 'afternoon', label: '오후' },
  { value: 'evening', label: '저녁' },
  { value: 'night', label: '밤' },
];

const DEFAULT_LOCALES = ['en', 'ko'];

export interface CategoryEditorProps {
  category: TriggerCategory;
  /** Phase labels referencing this category (read-only display). */
  referencedBy: string[];
  onPatch: (patch: Partial<TriggerCategory>) => void;
  onRemove: () => void;
}

export default function CategoryEditor({
  category,
  referencedBy,
  onPatch,
  onRemove,
}: CategoryEditorProps) {
  const [expanded, setExpanded] = useState(false);
  const [newLocaleInput, setNewLocaleInput] = useState('');

  const locales = useMemo(() => {
    const set = new Set<string>(DEFAULT_LOCALES);
    Object.keys(category.prompts).forEach((l) => set.add(l));
    return Array.from(set);
  }, [category.prompts]);

  const setCondition = (patch: Partial<CategoryConditions>) => {
    onPatch({ conditions: { ...category.conditions, ...patch } });
  };

  const setPromptList = (locale: string, list: string[]) => {
    onPatch({
      prompts: { ...category.prompts, [locale]: list },
    });
  };

  const addPrompt = (locale: string) => {
    const list = category.prompts[locale] ?? [];
    setPromptList(locale, [...list, '']);
  };

  const updatePrompt = (locale: string, index: number, value: string) => {
    const list = category.prompts[locale] ?? [];
    const next = [...list];
    next[index] = value;
    setPromptList(locale, next);
  };

  const removePrompt = (locale: string, index: number) => {
    const list = category.prompts[locale] ?? [];
    const next = list.filter((_, i) => i !== index);
    setPromptList(locale, next);
  };

  const addLocale = () => {
    const trimmed = newLocaleInput.trim().toLowerCase();
    if (!trimmed) return;
    if (category.prompts[trimmed]) return;
    onPatch({
      prompts: { ...category.prompts, [trimmed]: [] },
    });
    setNewLocaleInput('');
  };

  const promptCount = useMemo(() => {
    return Object.values(category.prompts).reduce(
      (sum, list) => sum + (list?.length || 0),
      0,
    );
  }, [category.prompts]);

  return (
    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={ICON_BTN}
          title={expanded ? '접기' : '펼치기'}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
        </button>
        <input
          type="text"
          value={category.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder="카테고리 이름"
          className={`${INPUT_SM} flex-1 min-w-[160px]`}
        />
        <input
          type="text"
          value={category.id}
          onChange={(e) => {
            // ID is referenced by phase events — but this is the only
            // place to edit it; a parent-level rename hook would be
            // safer, so we treat manual edits as advanced and warn.
            onPatch({ id: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') });
          }}
          placeholder="category_id"
          className={`${INPUT_SM} w-44 font-mono text-[0.7rem]`}
          title="ID는 페이즈 이벤트에서 참조하므로 변경하면 기존 참조가 끊어집니다."
        />
        <select
          value={category.kind}
          onChange={(e) => onPatch({ kind: e.target.value as TriggerKind })}
          className={INPUT_SM}
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))] tabular-nums shrink-0">
          {promptCount} 프롬프트
        </span>
        <button
          type="button"
          onClick={onRemove}
          className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
          title="카테고리 삭제"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Body ── */}
      {expanded && (
        <div className="border-t border-[hsl(var(--border))] p-3 flex flex-col gap-4">
          {/* Reference list */}
          {referencedBy.length > 0 && (
            <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
              참조 페이즈: {referencedBy.join(', ')}
            </div>
          )}

          {/* Conditions */}
          <div>
            <div className="text-[0.6875rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold mb-2">
              발사 조건
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <CheckboxField
                label="Sub-Worker가 작업 중일 때만"
                checked={!!category.conditions.requires_sub_worker_busy}
                onChange={(v) =>
                  setCondition({ requires_sub_worker_busy: v || undefined })
                }
              />
              <CheckboxField
                label="Sub-Worker가 idle일 때만"
                checked={!!category.conditions.requires_sub_worker_idle}
                onChange={(v) =>
                  setCondition({ requires_sub_worker_idle: v || undefined })
                }
              />
              <div className="flex flex-col gap-1">
                <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
                  시간대 제한
                </label>
                <select
                  value={category.conditions.time_window ?? ''}
                  onChange={(e) =>
                    setCondition({
                      time_window: (e.target.value || null) as
                        | TimeWindow
                        | null,
                    })
                  }
                  className={INPUT_SM}
                >
                  {TIME_WINDOWS.map((o) => (
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
                  onChange={(e) =>
                    onPatch({
                      cooldown_seconds: Math.max(
                        0,
                        Number(e.target.value),
                      ),
                    })
                  }
                  className={INPUT_SM}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
                  최소 연속 트리거 (옵션)
                </label>
                <input
                  type="number"
                  value={category.conditions.min_consecutive ?? ''}
                  min={0}
                  step={1}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setCondition({
                      min_consecutive:
                        raw === '' ? null : Math.max(0, Number(raw)),
                    });
                  }}
                  placeholder="제한 없음"
                  className={INPUT_SM}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[0.7rem] text-[hsl(var(--muted-foreground))]">
                  최대 연속 트리거 (옵션)
                </label>
                <input
                  type="number"
                  value={category.conditions.max_consecutive ?? ''}
                  min={0}
                  step={1}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setCondition({
                      max_consecutive:
                        raw === '' ? null : Math.max(0, Number(raw)),
                    });
                  }}
                  placeholder="제한 없음"
                  className={INPUT_SM}
                />
              </div>
            </div>
          </div>

          {/* Prompts */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[0.6875rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold">
                프롬프트
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={newLocaleInput}
                  onChange={(e) => setNewLocaleInput(e.target.value)}
                  placeholder="새 로케일 (예: ja)"
                  className={`${INPUT_SM} w-32 text-[0.7rem]`}
                />
                <button
                  type="button"
                  onClick={addLocale}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded border border-[hsl(var(--border))] text-[0.7rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  로케일
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {locales.map((locale) => {
                const list = category.prompts[locale] ?? [];
                return (
                  <div
                    key={locale}
                    className="rounded-md border border-[hsl(var(--border))] p-3 flex flex-col gap-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[0.7rem] uppercase tracking-wider font-semibold text-[hsl(var(--foreground))]">
                        {locale}
                      </span>
                      <button
                        type="button"
                        onClick={() => addPrompt(locale)}
                        className="inline-flex items-center gap-1 h-6 px-2 rounded text-[0.7rem] text-[hsl(var(--muted-foreground))] hover:text-violet-500 hover:bg-violet-500/10 transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                        프롬프트 추가
                      </button>
                    </div>

                    {list.length === 0 ? (
                      <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] text-center py-2">
                        이 로케일은 아직 프롬프트가 없어요. (다른 로케일이
                        있으면 EN로 폴백됩니다.)
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {list.map((prompt, idx) => (
                          <div key={idx} className="flex items-start gap-1.5">
                            <textarea
                              value={prompt}
                              onChange={(e) =>
                                updatePrompt(locale, idx, e.target.value)
                              }
                              rows={3}
                              className={`${TEXTAREA} font-mono text-[0.75rem]`}
                              placeholder="[THINKING_TRIGGER:cat] ... 본문"
                            />
                            <button
                              type="button"
                              onClick={() => removePrompt(locale, idx)}
                              className={`${ICON_BTN} mt-1 hover:!text-red-500 hover:!bg-red-500/10`}
                              title="프롬프트 제거"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 accent-violet-500"
      />
      <span className="text-[0.8125rem] text-[hsl(var(--foreground))]">
        {label}
      </span>
    </label>
  );
}
