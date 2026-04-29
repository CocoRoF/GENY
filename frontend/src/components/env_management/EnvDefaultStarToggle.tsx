'use client';

/**
 * EnvDefaultStarToggle — per-row "default for new envs" toggle.
 *
 * Lives at the right edge of every row in the four registry tabs
 * (HooksTab / SkillsTab / PermissionsTab / McpServersTab). Click =
 * POST /api/env-defaults/{category}/toggle/{id}; the response
 * refreshes the parent context so every star on the page stays in
 * sync without a manual reload.
 *
 * Visual:
 *   filled star (violet)  → id is in the env-defaults list →
 *                          new envs ship with this item enabled
 *   hollow star (muted)   → id is NOT in the list → new envs
 *                          omit it (or, if the list is empty
 *                          across the board, fall back to wildcard
 *                          which is "every host registration on")
 *
 * Disabled state: rendered when the parent context reports a
 * persistence failure (DB down → 503). Toggle clicks are no-ops;
 * tooltip explains the fallback.
 *
 * The component is intentionally thin — it doesn't fetch on its
 * own. The parent registry tab owns the `useEnvDefaults` hook so
 * a single GET serves all rows in the table.
 */

import { Star, StarOff } from 'lucide-react';
import { useEnvDefaults } from './useEnvDefaults';
import type { EnvDefaultsCategory } from '@/lib/envDefaultsApi';

export interface EnvDefaultStarToggleProps {
  category: EnvDefaultsCategory;
  /** Stable id derived per-category — see lib/envDefaultsApi. */
  itemId: string | null;
  /** Override the default tooltip when the row needs more context. */
  title?: string;
  /** Skip rendering when the row genuinely has no addressable id
   *  (malformed skill frontmatter, stub permission row, etc.). The
   *  parent could also branch on this themselves; centralising the
   *  guard here keeps tabs from accidentally calling toggle('null'). */
  showWhenIdMissing?: boolean;
}

export default function EnvDefaultStarToggle({
  category,
  itemId,
  title,
  showWhenIdMissing = false,
}: EnvDefaultStarToggleProps) {
  const ctx = useEnvDefaults();

  if (!itemId) {
    return showWhenIdMissing ? (
      <span
        className="inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] opacity-30 cursor-not-allowed"
        title="이 항목은 식별 가능한 id가 없어 기본값으로 등록할 수 없습니다."
      >
        <StarOff size={13} />
      </span>
    ) : null;
  }

  const isOn = ctx.isDefault(category, itemId);
  const persistFailed = ctx.error !== null;
  const pending = ctx.pendingId === itemId;

  const tooltip =
    title ??
    (persistFailed
      ? '저장 실패 — env-defaults DB 사용 불가'
      : isOn
        ? '새 env에서 기본 포함 — 클릭해서 끄기'
        : '클릭하면 새 env에서 기본 포함');

  const handleClick = () => {
    if (persistFailed || pending) return;
    void ctx.toggle(category, itemId);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={persistFailed || pending}
      title={tooltip}
      aria-pressed={isOn}
      className={[
        'inline-flex items-center justify-center w-7 h-7 rounded transition-colors',
        persistFailed
          ? 'text-[hsl(var(--muted-foreground))] opacity-40 cursor-not-allowed'
          : isOn
            ? 'text-violet-500 hover:bg-violet-500/10'
            : 'text-[hsl(var(--muted-foreground))] hover:text-violet-500 hover:bg-violet-500/10',
        pending ? 'opacity-50' : '',
      ].join(' ')}
    >
      {isOn ? (
        <Star size={13} fill="currentColor" />
      ) : (
        <Star size={13} />
      )}
    </button>
  );
}
