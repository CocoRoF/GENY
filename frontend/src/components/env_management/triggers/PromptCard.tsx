'use client';

/**
 * PromptCard — single prompt in the library.
 *
 * Owns identity (label / id / tags) + locale-keyed content. Lives
 * inside :mod:`PromptsSection`. Categories link to prompts by id from
 * the "상황" section, so editing a prompt's content here propagates
 * automatically — the card surfaces the count of referencing
 * situations as a "사용처" line.
 */

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import type { TriggerPrompt } from '@/types/triggerPreset';
import type { PromptUsage } from './triggerSimulator';

const INPUT_SM =
  'h-8 px-2.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';
const TEXTAREA =
  'w-full px-2.5 py-1.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.875rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 resize-y';
const ICON_BTN =
  'inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors';

const CANONICAL_LOCALES = ['en', 'ko'];

export interface PromptCardProps {
  prompt: TriggerPrompt;
  usages: PromptUsage[];
  defaultExpanded?: boolean;
  onPatch: (patch: Partial<TriggerPrompt>) => void;
  onDelete: () => void;
}

export default function PromptCard({
  prompt,
  usages,
  defaultExpanded = false,
  onPatch,
  onDelete,
}: PromptCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [newLocale, setNewLocale] = useState('');

  const locales = Array.from(
    new Set([...CANONICAL_LOCALES, ...Object.keys(prompt.content)]),
  );

  const previewLocale =
    prompt.content['ko'] ||
    prompt.content['en'] ||
    Object.values(prompt.content)[0] ||
    '';

  const setLocale = (locale: string, text: string) => {
    onPatch({ content: { ...prompt.content, [locale]: text } });
  };

  const removeLocale = (locale: string) => {
    const next = { ...prompt.content };
    delete next[locale];
    onPatch({ content: next });
  };

  const addLocale = () => {
    const trimmed = newLocale.trim().toLowerCase();
    if (!trimmed || prompt.content[trimmed] !== undefined) return;
    onPatch({ content: { ...prompt.content, [trimmed]: '' } });
    setNewLocale('');
  };

  const usageCount = usages.length;
  const isOrphan = usageCount === 0;

  return (
    <div
      className={`rounded-lg border bg-[hsl(var(--background))] transition-all ${
        isOrphan
          ? 'border-amber-500/30'
          : 'border-[hsl(var(--border))] hover:border-violet-500/30'
      } ${expanded ? 'shadow-sm' : ''}`}
    >
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

        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[0.875rem] font-medium text-[hsl(var(--foreground))] truncate">
              {prompt.label || prompt.id}
            </span>
            <span className="text-[0.65rem] text-[hsl(var(--muted-foreground))] font-mono">
              {prompt.id}
            </span>
            <span className="text-[0.65rem] text-[hsl(var(--muted-foreground))]">
              {Object.keys(prompt.content).length}개 로케일
            </span>
            {isOrphan ? (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                미사용
              </span>
            ) : (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[0.6rem] font-medium bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/30">
                {usageCount}개 상황에서 사용
              </span>
            )}
          </div>

          {previewLocale && (
            <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] line-clamp-1">
              {previewLocale}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const ok = window.confirm(
              `"${prompt.label || prompt.id}" 프롬프트를 삭제할까요?` +
                (usageCount > 0
                  ? `\n\n현재 ${usageCount}개 상황에서 사용 중이며, 삭제 시 그 참조도 자동으로 제거됩니다.`
                  : ''),
            );
            if (ok) onDelete();
          }}
          className={`${ICON_BTN} hover:!text-red-500 hover:!bg-red-500/10`}
          title="프롬프트 삭제"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-[hsl(var(--border))] p-4 flex flex-col gap-4">
          {/* Identity */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-2">
            <input
              type="text"
              value={prompt.label}
              onChange={(e) => onPatch({ label: e.target.value })}
              placeholder="프롬프트 이름 (식별용)"
              className={INPUT_SM}
            />
            <input
              type="text"
              value={prompt.id}
              onChange={(e) =>
                onPatch({
                  id: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_'),
                })
              }
              className={`${INPUT_SM} font-mono text-[0.7rem]`}
              title="ID — 상황의 prompt_refs에서 참조하는 키. 변경 시 모든 참조가 자동 갱신됩니다."
            />
          </div>

          {/* Usages */}
          {usages.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
                사용처
              </span>
              <div className="flex flex-wrap gap-1.5">
                {usages.map((u) => (
                  <span
                    key={u.categoryId}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-violet-500/30 bg-violet-500/10 text-[0.7rem] text-violet-700 dark:text-violet-300"
                    title={`${u.categoryLabel} 상황에서 가중치 ${u.weight}`}
                  >
                    <span className="font-medium">{u.categoryLabel}</span>
                    <span className="text-[0.65rem] tabular-nums opacity-80">
                      w={u.weight}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[0.7rem] text-amber-700 dark:text-amber-300">
              어떤 상황에서도 사용되지 않습니다 — "상황" 섹션에서 이 프롬프트를
              연결해야 발화됩니다.
            </div>
          )}

          {/* Locales */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
                내용 (자연어만 — 시스템 태그는 자동)
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={newLocale}
                  onChange={(e) => setNewLocale(e.target.value)}
                  placeholder="새 로케일 (예: ja)"
                  className={`${INPUT_SM} w-32 text-[0.7rem] h-7`}
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

            {locales.map((locale) => {
              const text = prompt.content[locale] ?? '';
              const isCanonical = CANONICAL_LOCALES.includes(locale);
              return (
                <div key={locale} className="flex items-start gap-2">
                  <div className="flex flex-col items-center gap-0.5 pt-1.5 min-w-[44px]">
                    <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
                      {locale}
                    </span>
                    {!isCanonical && (
                      <button
                        type="button"
                        onClick={() => removeLocale(locale)}
                        className="text-[0.6rem] text-[hsl(var(--muted-foreground))] hover:text-red-500"
                        title={`${locale} 로케일 제거`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <textarea
                    value={text}
                    onChange={(e) => setLocale(locale, e.target.value)}
                    rows={2}
                    placeholder={
                      locale === 'ko'
                        ? '예: 잠깐 조용해졌다. 내 내부 인식이 최근 대화 흐름을 감지하고 있다.'
                        : 'e.g., A brief silence has settled.'
                    }
                    className={TEXTAREA}
                  />
                </div>
              );
            })}
          </div>

          {/* Tags */}
          <div className="flex flex-col gap-1">
            <span className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
              태그 (선택, 검색용)
            </span>
            <input
              type="text"
              value={prompt.tags.join(', ')}
              onChange={(e) =>
                onPatch({
                  tags: e.target.value
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
              placeholder="idle, calm"
              className={INPUT_SM}
            />
          </div>
        </div>
      )}
    </div>
  );
}
