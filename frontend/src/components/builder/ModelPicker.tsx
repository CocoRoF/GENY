'use client';

/**
 * ModelPicker — provider-aware model selector.
 *
 *   - For anthropic / openai / google / claude_code_cli:
 *     renders a styled Select with the curated catalog. The CLI
 *     catalog includes short aliases (sonnet / opus / haiku) plus
 *     a couple of date-pinned ids. Values not in the catalog (legacy
 *     manifests, hand-edited pins) still render with a "Custom"
 *     badge.
 *   - For vllm: pure free-form Input — the served model id is fully
 *     user-controlled and unbounded.
 *
 * "Custom value…" affordance: even non-freeForm providers expose a
 * synthetic ``__custom__`` entry at the bottom of the dropdown.
 * Picking it swaps the trigger to an inline Input so power users
 * can pin an arbitrary id (e.g. ``claude-3-5-sonnet-20241022``)
 * without leaving the editor.
 *
 * The shadcn Select underneath uses Radix's portal-positioned popover
 * so the dropdown floats above page chrome and never gets clipped by
 * ``overflow:hidden`` ancestors.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import {
  MODEL_CATALOG,
  getProviderInfo,
  type ProviderId,
} from '@/lib/modelCatalog';

interface Props {
  provider: ProviderId;
  value: string;
  onChange: (next: string) => void;
  id?: string;
  disabled?: boolean;
}

// Sentinel value that means "swap to custom input mode" when picked
// from the Select dropdown. Has to be a non-empty, catalog-distinct
// string because shadcn's SelectItem rejects empty values.
const CUSTOM_SENTINEL = '__geny_picker_custom__';


export function ModelPicker({ provider, value, onChange, id, disabled }: Props) {
  const { t } = useI18n();
  const reactId = useId();
  const inputId = id ?? reactId;

  const info = getProviderInfo(provider);
  const options = MODEL_CATALOG[provider];
  const currentInCatalog = options.some((o) => o.id === value);

  // ``customMode`` is sticky once entered, so the user can type their
  // arbitrary id without the picker yanking them back to the Select on
  // the next render. We exit custom mode when the user picks a real
  // catalog entry (handled via the Select's onChange below).
  const [customMode, setCustomMode] = useState<boolean>(() =>
    info.freeForm || (value !== '' && !currentInCatalog),
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  // When the provider switches, recompute whether we should land in
  // custom mode. vLLM (freeForm) is always custom; catalog-backed
  // providers only enter custom mode when the current value is
  // off-catalog OR the user explicitly opted in.
  useEffect(() => {
    if (info.freeForm) {
      setCustomMode(true);
      return;
    }
    if (value === '' || currentInCatalog) {
      setCustomMode(false);
    } else {
      setCustomMode(true);
    }
    // ``options`` reference changes per render but its contents are
    // stable per provider, so depending on ``provider`` is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, value]);

  // ── vLLM-style pure free-form (no catalog) ─────────────────────────
  if (info.freeForm) {
    return (
      <Input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('envManagement.modelEditor.vllmPlaceholder')}
        className="font-mono text-[0.75rem]"
        disabled={disabled}
      />
    );
  }

  // ── Custom-value input (sticky after the user picks "Custom…") ────
  if (customMode) {
    return (
      <div className="flex gap-2">
        <Input
          id={inputId}
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('envManagement.modelEditor.customPlaceholder')}
          className="font-mono text-[0.75rem] flex-1"
          disabled={disabled}
          autoFocus={!currentInCatalog && value === ''}
        />
        <button
          type="button"
          onClick={() => {
            // Switch back to the catalog dropdown. Reset the value to
            // the catalog's default for this provider so the Select
            // has a valid selection to render.
            const fallback = options[0]?.id ?? '';
            onChange(fallback);
            setCustomMode(false);
          }}
          disabled={disabled}
          className="px-2.5 rounded border border-[hsl(var(--border))] text-[0.6875rem] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))] disabled:opacity-50 transition-colors"
        >
          {t('envManagement.modelEditor.customExit')}
        </button>
      </div>
    );
  }

  // ── Catalog dropdown ──────────────────────────────────────────────
  return (
    <Select
      value={value || undefined}
      onValueChange={(next) => {
        if (next === CUSTOM_SENTINEL) {
          // Don't change the current model id when entering custom
          // mode — just unlock the Input so the user can edit.
          setCustomMode(true);
          // Autofocus after the next render.
          setTimeout(() => inputRef.current?.focus(), 0);
          return;
        }
        onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={inputId} className="text-[0.8125rem] h-9">
        <span className="flex-1 min-w-0 text-left truncate">
          {value ? (
            currentInCatalog ? (
              <CatalogLabel id={value} provider={provider} />
            ) : (
              <span className="inline-flex items-center gap-2 min-w-0">
                <span className="truncate font-mono text-[0.75rem]">{value}</span>
                <span className="text-[0.625rem] uppercase tracking-wider text-[hsl(var(--muted-foreground))] shrink-0">
                  {t('envManagement.modelEditor.customBadge')}
                </span>
              </span>
            )
          ) : (
            <span className="text-[hsl(var(--muted-foreground))]">
              {t('envManagement.modelEditor.modelPlaceholder')}
            </span>
          )}
        </span>
      </SelectTrigger>
      <SelectContent className="max-h-[320px]">
        {options.map((opt) => (
          <SelectItem key={opt.id} value={opt.id} className="py-2">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="font-mono text-[0.75rem] truncate">{opt.id}</span>
              <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] truncate">
                {opt.label}
              </span>
            </div>
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={CUSTOM_SENTINEL} className="py-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="font-mono text-[0.75rem] text-[hsl(var(--primary))]">
              {t('envManagement.modelEditor.customEntryLabel')}
            </span>
            <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] truncate">
              {t('envManagement.modelEditor.customEntryHint')}
            </span>
          </div>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}


function CatalogLabel({ id, provider }: { id: string; provider: ProviderId }) {
  const opt = MODEL_CATALOG[provider].find((o) => o.id === id);
  if (!opt) return <span className="truncate">{id}</span>;
  return (
    <span className="inline-flex items-baseline gap-2 min-w-0">
      <span className="truncate font-mono text-[0.75rem]">{opt.id}</span>
      <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] shrink-0">
        {opt.label}
      </span>
    </span>
  );
}
