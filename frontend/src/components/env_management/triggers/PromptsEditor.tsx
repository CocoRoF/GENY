'use client';

/**
 * PromptsEditor — locale-keyed prompts editor.
 *
 * Used by :mod:`TriggerCard`. Each locale gets its own block with a
 * list of prompt variants — add, edit, remove individually. Adding a
 * new locale is a small affordance at the top so operators can ship
 * presets in additional languages without code changes.
 */

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';

const INPUT_SM =
  'h-8 px-2.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60';
const TEXTAREA =
  'w-full px-2.5 py-1.5 rounded border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60 resize-y';
const ICON_BTN =
  'inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors';

const DEFAULT_LOCALES = ['en', 'ko'];

export interface PromptsEditorProps {
  prompts: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
}

export default function PromptsEditor({ prompts, onChange }: PromptsEditorProps) {
  const [newLocaleInput, setNewLocaleInput] = useState('');

  const locales = useMemo(() => {
    const set = new Set<string>(DEFAULT_LOCALES);
    Object.keys(prompts).forEach((l) => set.add(l));
    return Array.from(set);
  }, [prompts]);

  const setList = (locale: string, list: string[]) => {
    onChange({ ...prompts, [locale]: list });
  };
  const addPrompt = (locale: string) => {
    setList(locale, [...(prompts[locale] ?? []), '']);
  };
  const updatePrompt = (locale: string, idx: number, value: string) => {
    const next = [...(prompts[locale] ?? [])];
    next[idx] = value;
    setList(locale, next);
  };
  const removePrompt = (locale: string, idx: number) => {
    setList(locale, (prompts[locale] ?? []).filter((_, i) => i !== idx));
  };
  const addLocale = () => {
    const trimmed = newLocaleInput.trim().toLowerCase();
    if (!trimmed || prompts[trimmed]) return;
    onChange({ ...prompts, [trimmed]: [] });
    setNewLocaleInput('');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[0.6875rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] font-semibold">
          프롬프트
        </span>
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

      <div className="flex flex-col gap-2">
        {locales.map((locale) => {
          const list = prompts[locale] ?? [];
          return (
            <div
              key={locale}
              className="rounded-md border border-[hsl(var(--border))] p-3 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-[0.7rem] uppercase tracking-wider font-semibold text-[hsl(var(--foreground))]">
                  {locale}
                  <span className="ml-1.5 text-[0.65rem] font-normal text-[hsl(var(--muted-foreground))]">
                    {list.length}개
                  </span>
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
                  이 로케일은 비어 있어요. (다른 로케일이 있으면 EN으로
                  폴백됩니다.)
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
  );
}
