'use client';

/**
 * ModelPicker — provider-aware model selector.
 *
 *   - For anthropic / openai / google: renders a styled Select with
 *     the curated catalog. The current value is shown as the trigger
 *     label even when it isn't in the catalog (so existing manifests
 *     with custom dated identifiers still render correctly).
 *   - For vllm: renders a free-form Input — the served model id is
 *     user-controlled and unbounded.
 *
 * The shadcn Select underneath uses Radix's portal-positioned popover
 * so the dropdown floats above page chrome and never gets clipped by
 * `overflow:hidden` ancestors — fixing the broken positioning the
 * native <datalist> dropdown had inside the env-management body.
 */

import { useId } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
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
  /** Optional override for the input id (a11y). */
  id?: string;
  /** Disabled state (e.g. when a stage is bypassed). */
  disabled?: boolean;
}

export function ModelPicker({ provider, value, onChange, id, disabled }: Props) {
  const { t } = useI18n();
  const reactId = useId();
  const inputId = id ?? reactId;

  const info = getProviderInfo(provider);

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

  const options = MODEL_CATALOG[provider];
  const currentInCatalog = options.some((o) => o.id === value);

  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
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
