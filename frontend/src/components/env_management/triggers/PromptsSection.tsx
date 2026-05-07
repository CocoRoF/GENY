'use client';

/**
 * PromptsSection — top-level prompt library editor.
 *
 * The library is a flat list of re-usable :class:`TriggerPrompt`
 * objects. Each prompt holds locale-keyed natural-language text and
 * is referenced by zero or more :class:`TriggerCategory` entries
 * via their ``prompt_refs``.
 *
 * Operators manage prompts here (write the words). Wiring prompts
 * into situations + setting weights happens in the "상황" section.
 */

import { useCallback, useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';

import type {
  TriggerPresetManifest,
  TriggerPrompt,
} from '@/types/triggerPreset';
import { promptUsageMap } from './triggerSimulator';
import PromptCard from './PromptCard';

function freshId(prefix = 'prompt') {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now()
    .toString(36)
    .slice(-4)}`;
}

export interface PromptsSectionProps {
  manifest: TriggerPresetManifest;
  onManifestUpdate: (
    next:
      | TriggerPresetManifest
      | ((prev: TriggerPresetManifest) => TriggerPresetManifest),
  ) => void;
}

export default function PromptsSection({
  manifest,
  onManifestUpdate,
}: PromptsSectionProps) {
  const [recentlyAddedId, setRecentlyAddedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const usageMap = useMemo(
    () => promptUsageMap(manifest),
    [manifest],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return manifest.prompts;
    return manifest.prompts.filter((p) => {
      if (p.id.toLowerCase().includes(q)) return true;
      if (p.label.toLowerCase().includes(q)) return true;
      if (p.tags.some((t) => t.toLowerCase().includes(q))) return true;
      return Object.values(p.content).some((v) =>
        v.toLowerCase().includes(q),
      );
    });
  }, [manifest.prompts, filter]);

  const orphanCount = useMemo(
    () =>
      manifest.prompts.filter((p) => (usageMap.get(p.id) ?? []).length === 0)
        .length,
    [manifest.prompts, usageMap],
  );

  const updatePrompt = useCallback(
    (promptId: string, patch: Partial<TriggerPrompt>) => {
      onManifestUpdate((prev) => {
        const idChanging = patch.id && patch.id !== promptId;
        const newId = patch.id ?? promptId;
        const idCollision =
          idChanging && prev.prompts.some((p) => p.id === newId);
        if (idCollision) {
          // Refuse the rename — silently ignore the id field, keep
          // everything else. The UI's text input shows the actual
          // stored id on the next render so the user sees the no-op.
          patch = { ...patch, id: promptId };
        }
        return {
          ...prev,
          prompts: prev.prompts.map((p) =>
            p.id === promptId ? { ...p, ...patch } : p,
          ),
          // Retarget any category prompt_refs that pointed at the old id.
          categories: idChanging
            ? prev.categories.map((c) => ({
                ...c,
                prompt_refs: c.prompt_refs.map((r) =>
                  r.prompt_id === promptId
                    ? { ...r, prompt_id: newId }
                    : r,
                ),
              }))
            : prev.categories,
        };
      });
    },
    [onManifestUpdate],
  );

  const removePrompt = useCallback(
    (promptId: string) => {
      onManifestUpdate((prev) => ({
        ...prev,
        prompts: prev.prompts.filter((p) => p.id !== promptId),
        // Cascade: drop dangling refs from every category.
        categories: prev.categories.map((c) => ({
          ...c,
          prompt_refs: c.prompt_refs.filter((r) => r.prompt_id !== promptId),
        })),
      }));
    },
    [onManifestUpdate],
  );

  const addPrompt = useCallback(() => {
    const id = freshId();
    onManifestUpdate((prev) => ({
      ...prev,
      prompts: [
        ...prev.prompts,
        {
          id,
          label: '새 프롬프트',
          content: { en: '', ko: '' },
          tags: [],
        },
      ],
    }));
    setRecentlyAddedId(id);
  }, [onManifestUpdate]);

  return (
    <div className="flex flex-col gap-4">
      <Explainer />

      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="이름 / 본문 / 태그로 검색"
            className="w-full h-9 pl-8 pr-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/60"
          />
        </div>
        <span className="text-[0.7rem] text-[hsl(var(--muted-foreground))] tabular-nums">
          {filtered.length} / {manifest.prompts.length}개 표시
          {orphanCount > 0 && (
            <span className="ml-2 text-amber-600 dark:text-amber-400">
              · 미사용 {orphanCount}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={addPrompt}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-violet-500 text-white text-[0.75rem] font-medium hover:bg-violet-600 transition-colors shadow-sm"
        >
          <Plus className="w-3.5 h-3.5" />
          프롬프트 추가
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[hsl(var(--border))] px-4 py-8 text-center text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
          {manifest.prompts.length === 0
            ? '아직 프롬프트가 없어요. ＋ 프롬프트 추가로 시작하세요.'
            : '검색 결과가 없어요.'}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((prompt) => (
            <PromptCard
              key={prompt.id}
              prompt={prompt}
              usages={usageMap.get(prompt.id) ?? []}
              defaultExpanded={recentlyAddedId === prompt.id}
              onPatch={(patch) => updatePrompt(prompt.id, patch)}
              onDelete={() => removePrompt(prompt.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Explainer() {
  return (
    <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 flex flex-col gap-2">
      <div className="text-[0.6875rem] uppercase tracking-wider font-semibold text-violet-700 dark:text-violet-300">
        프롬프트 라이브러리 사용법
      </div>
      <ol className="text-[0.8125rem] text-[hsl(var(--foreground))] leading-relaxed space-y-1 pl-5 list-decimal">
        <li>
          여기서는 <strong>자연어 프롬프트만</strong> 적습니다.{' '}
          <code className="font-mono text-[0.75rem]">[THINKING_TRIGGER:…]</code>{' '}
          같은 시스템 태그는 발화 시점에 자동으로 붙어요.
        </li>
        <li>
          한 프롬프트는 여러{' '}
          <strong>상황(카테고리)</strong>에서 재사용할 수 있어요. 어디서
          쓰이는지 카드의 "사용처"에서 확인합니다.
        </li>
        <li>
          상황에 연결하고 가중치를 정하는 건 옆쪽 <strong>"상황"</strong>{' '}
          섹션에서 합니다. 여기서 만든 프롬프트가 거기에서 후보로 나타나요.
        </li>
      </ol>
    </div>
  );
}
