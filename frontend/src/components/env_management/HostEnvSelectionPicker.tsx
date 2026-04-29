'use client';

/**
 * HostEnvSelectionPicker — generic picker for the
 * "host-registered + env-pickable" pattern.
 *
 * Hooks, skills, and permission rules live host-level (one set of
 * files, every environment shares the registry). Each manifest
 * records which subset is *active for this env* via the
 * `host_selections.<section>` field added in geny-executor 1.3.3.
 *
 * Selection grammar (matches `HostSelections.resolve`):
 *
 *   ["*"]            wildcard — every host registration applies, plus
 *                    any future ones the host adds. Default.
 *   []               explicit opt-out. The env runs with this section
 *                    completely disabled.
 *   ["a", "b", ...]  literal subset. Intersected with the host
 *                    registry at runtime; names not registered are
 *                    silently dropped.
 *
 * The picker shows the host's available items and three modes:
 *   - Wildcard mode (one click): selection becomes ["*"]. Every row
 *     visually checked, future items implicitly included.
 *   - Subset mode: a literal list. The user toggles individual rows.
 *   - Empty mode: nothing checked, selection [].
 *
 * `disabled` puts the picker into read-only / mockup state so a
 * future feature (permissions today) can ship the UI shape without
 * binding to a backend that doesn't enforce it yet.
 */

import { useMemo, useState } from 'react';
import { Check, ListChecks, Search, Sparkles, Square, X } from 'lucide-react';
import { Input } from '@/components/ui/input';

export interface HostItem {
  /** Stable id used in the manifest selection list. */
  id: string;
  /** Short display label (one line). */
  label: string;
  /** Optional one-line subtitle / description. */
  description?: string;
  /** Optional capability badges shown on the right of the row. */
  badges?: Array<{ text: string; tone?: 'neutral' | 'warn' | 'good' }>;
}

export interface HostEnvSelectionPickerProps {
  /** Items the host has registered (loaded by the parent). */
  items: HostItem[];
  /** Current env selection from the manifest. */
  value: string[];
  /** Called whenever the user changes the selection. */
  onChange: (next: string[]) => void;
  /** Read-only / mockup state — clicks are ignored, header buttons
   *  are disabled. Used by the permissions panel until enforcement
   *  lands runtime-side. */
  disabled?: boolean;
  /** "이 환경에서 사용할" — section noun (훅 / 스킬 / 권한 룰 등). */
  itemNoun?: string;
  /** Empty-state copy when items.length === 0. */
  emptyText?: string;
  /** Loading state from the parent's fetch. */
  loading?: boolean;
  /** Error text from the parent's fetch. */
  errorText?: string | null;
}

const WILDCARD = '*';

export default function HostEnvSelectionPicker({
  items,
  value,
  onChange,
  disabled = false,
  itemNoun = '항목',
  emptyText,
  loading = false,
  errorText = null,
}: HostEnvSelectionPickerProps) {
  const [query, setQuery] = useState('');
  const isWildcard = value.includes(WILDCARD);
  const isEmpty = !isWildcard && value.length === 0;

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.id.toLowerCase().includes(q) ||
        (it.description ?? '').toLowerCase().includes(q),
    );
  }, [items, query]);

  const selectedIds = useMemo(() => {
    if (isWildcard) return new Set(items.map((it) => it.id));
    return new Set(value);
  }, [items, value, isWildcard]);

  const totalCount = items.length;
  const selectedCount = isWildcard ? totalCount : value.length;

  // ── Mode handlers ────────────────────────────────────────────

  const handleWildcard = () => {
    if (disabled) return;
    onChange([WILDCARD]);
  };

  const handleSelectAll = () => {
    if (disabled) return;
    // Materialise the wildcard into an explicit list — useful when
    // the user wants "everything currently registered" but with the
    // ability to drop a single item later without flipping back to
    // wildcard.
    onChange(items.map((it) => it.id));
  };

  const handleClearAll = () => {
    if (disabled) return;
    onChange([]);
  };

  const handleToggleOne = (id: string) => {
    if (disabled) return;
    if (isWildcard) {
      // First narrowing click: materialise wildcard, then drop the
      // toggled id. Matches BuiltinToolsExplorer's "leave wildcard
      // by removing one" behaviour.
      const all = items.map((it) => it.id);
      onChange(all.filter((x) => x !== id));
      return;
    }
    if (selectedIds.has(id)) {
      onChange(value.filter((x) => x !== id));
    } else {
      onChange([...value, id]);
    }
  };

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
          <ListChecks className="w-4 h-4" />
          <span>
            이 환경에서 사용할 {itemNoun} ·{' '}
            <span className="font-semibold text-[hsl(var(--foreground))] tabular-nums">
              {isWildcard ? `전체(${totalCount})` : `${selectedCount} / ${totalCount}`}
            </span>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <ModeButton
            active={isWildcard}
            disabled={disabled}
            onClick={handleWildcard}
            icon={Sparkles}
            label="와일드카드"
            hint="앞으로 추가될 항목까지 자동 포함"
          />
          <ModeButton
            active={!isWildcard && selectedCount === totalCount && totalCount > 0}
            disabled={disabled || totalCount === 0}
            onClick={handleSelectAll}
            icon={Check}
            label="전체 선택"
          />
          <ModeButton
            active={isEmpty}
            disabled={disabled}
            onClick={handleClearAll}
            icon={X}
            label="전체 해제"
          />
        </div>
      </div>

      {/* Wildcard banner */}
      {isWildcard && !disabled && (
        <div className="px-3 py-2 rounded-md border border-violet-500/30 bg-violet-500/10 text-[0.7rem] text-violet-800 dark:text-violet-300 leading-relaxed">
          <span className="font-semibold uppercase tracking-wider mr-2">
            와일드카드
          </span>
          호스트에 등록된 모든 {itemNoun}이 적용됩니다 — 새로 등록되는 것도
          자동 포함. 일부만 쓰고 싶으면 항목을 클릭해서 좁히세요 (자동으로
          서브셋 모드로 전환됩니다).
        </div>
      )}

      {/* Empty banner */}
      {isEmpty && !disabled && (
        <div className="px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-[0.7rem] text-amber-800 dark:text-amber-300 leading-relaxed">
          <span className="font-semibold uppercase tracking-wider mr-2">
            opt-out
          </span>
          이 환경에서는 {itemNoun}을 사용하지 않습니다. 호스트에 등록된 항목이
          있어도 모두 비활성.
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`${itemNoun} 검색…`}
          className="pl-8 h-8 text-[0.8125rem]"
          disabled={disabled}
        />
      </div>

      {/* List */}
      <div
        className={`flex flex-col gap-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-1 ${
          disabled ? 'opacity-60' : ''
        }`}
      >
        {loading && (
          <RowMessage text={`${itemNoun} 목록을 불러오는 중…`} />
        )}
        {!loading && errorText && (
          <RowMessage text={errorText} tone="error" />
        )}
        {!loading && !errorText && totalCount === 0 && (
          <RowMessage
            text={
              emptyText ??
              `호스트에 등록된 ${itemNoun}이 없습니다. 아래의 호스트 편집기에서 추가하세요.`
            }
          />
        )}
        {!loading &&
          !errorText &&
          totalCount > 0 &&
          filtered.length === 0 && (
            <RowMessage text={`'${query}'와 매칭되는 ${itemNoun}이 없습니다.`} />
          )}
        {!loading &&
          !errorText &&
          filtered.map((item) => {
            const checked = selectedIds.has(item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleToggleOne(item.id)}
                disabled={disabled}
                className={`flex items-start gap-2.5 px-2.5 py-1.5 rounded text-left transition-colors ${
                  disabled
                    ? 'cursor-not-allowed'
                    : 'hover:bg-[hsl(var(--accent))]/60'
                } ${checked ? 'bg-[hsl(var(--accent))]/30' : ''}`}
              >
                <span
                  className={`mt-0.5 inline-flex w-4 h-4 items-center justify-center rounded border shrink-0 ${
                    checked
                      ? 'bg-violet-500 border-violet-500 text-white'
                      : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] text-transparent'
                  }`}
                >
                  {checked ? <Check className="w-3 h-3" /> : <Square className="w-3 h-3" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))] truncate">
                      {item.label}
                    </span>
                    {item.badges?.map((b, i) => (
                      <Badge key={i} text={b.text} tone={b.tone} />
                    ))}
                  </div>
                  {item.description && (
                    <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] truncate">
                      {item.description}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────

function ModeButton({
  active,
  disabled,
  onClick,
  icon: Icon,
  label,
  hint,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={`inline-flex items-center gap-1 h-7 px-2 rounded text-[0.7rem] font-medium transition-colors ${
        active
          ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/40'
          : 'border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </button>
  );
}

function Badge({
  text,
  tone = 'neutral',
}: {
  text: string;
  tone?: 'neutral' | 'warn' | 'good';
}) {
  const palette = {
    neutral:
      'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))]',
    warn: 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30',
    good: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30',
  }[tone];
  return (
    <span
      className={`text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold ${palette}`}
    >
      {text}
    </span>
  );
}

function RowMessage({
  text,
  tone = 'muted',
}: {
  text: string;
  tone?: 'muted' | 'error';
}) {
  const cls =
    tone === 'error'
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-[hsl(var(--muted-foreground))]';
  return (
    <div className={`px-3 py-3 text-[0.75rem] ${cls}`}>{text}</div>
  );
}
