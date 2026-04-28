'use client';

/**
 * Shared building blocks for curated stage editors.
 *
 * Every curated editor follows the same shape: tile picker for the
 * registered impl keys, conditional inline panel when the picked
 * impl exposes runtime config, and an Advanced wrapper that drops
 * into StageGenericEditor for raw-everything access. Centralising
 * the JSX here keeps each stage editor short and visually identical.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { StageManifestEntry } from '@/types/environment';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import StageGenericEditor from '../StageGenericEditor';

export interface TileOption {
  id: string;
  titleKey: string;
  descKey: string;
}

interface TilePickerProps {
  titleKey: string;
  hintKey?: string;
  options: TileOption[];
  available: Set<string>;
  current: string;
  cols?: 1 | 2 | 3;
  onPick: (id: string) => void;
  children?: React.ReactNode;
}

export function TilePicker({
  titleKey,
  hintKey,
  options,
  available,
  current,
  cols = 2,
  onPick,
  children,
}: TilePickerProps) {
  const { t } = useI18n();
  const grid =
    cols === 3 ? 'md:grid-cols-3' : cols === 1 ? 'md:grid-cols-1' : 'md:grid-cols-2';
  return (
    <section className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <header className="flex items-center gap-2">
        <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
          {t(titleKey)}
        </h4>
      </header>
      {hintKey && (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          {t(hintKey)}
        </p>
      )}
      <div className={`grid grid-cols-1 ${grid} gap-2`}>
        {options.map((opt) => {
          const isAvailable = available.has(opt.id);
          const isActive = current === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={!isAvailable}
              onClick={() => onPick(opt.id)}
              className={`flex items-start gap-2 p-2.5 rounded-md border text-left transition-colors ${
                isActive
                  ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]'
                  : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))]'
              } ${!isAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <div className="min-w-0">
                <div className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
                  {t(opt.titleKey)}
                </div>
                <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mt-0.5">
                  {t(opt.descKey)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {children}
    </section>
  );
}

interface NumberRowProps {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}

export function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: NumberRowProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
        {label}
      </label>
      {hint && (
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">{hint}</p>
      )}
      <Input
        type="number"
        value={String(value)}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n =
            step && step < 1
              ? parseFloat(e.target.value)
              : parseInt(e.target.value, 10);
          if (!isNaN(n)) onChange(n);
        }}
        className="h-7 text-[0.75rem] max-w-[180px] font-mono"
      />
    </div>
  );
}

interface StringRowProps {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}

export function StringRow({ label, hint, value, placeholder, onChange }: StringRowProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
        {label}
      </label>
      {hint && (
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">{hint}</p>
      )}
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-[0.75rem] max-w-[400px] font-mono"
      />
    </div>
  );
}

interface BoolRowProps {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

export function BoolRow({ label, hint, value, onChange }: BoolRowProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
          {label}
        </label>
        {hint && (
          <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mt-0.5">
            {hint}
          </p>
        )}
      </div>
      <Switch checked={value} onCheckedChange={onChange} />
    </div>
  );
}

interface TextareaRowProps {
  label: string;
  hint?: string;
  value: string;
  rows?: number;
  placeholder?: string;
  onChange: (v: string) => void;
}

export function TextareaRow({
  label,
  hint,
  value,
  rows,
  placeholder,
  onChange,
}: TextareaRowProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
        {label}
      </label>
      {hint && (
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">{hint}</p>
      )}
      <Textarea
        value={value}
        rows={rows ?? 3}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="text-[0.75rem] resize-y"
      />
    </div>
  );
}

interface ChipListProps {
  label: string;
  hint?: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

export function ChipList({
  label,
  hint,
  items,
  onChange,
  placeholder,
}: ChipListProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...items, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
        {label}
      </label>
      {hint && (
        <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">{hint}</p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-1 mt-1">
          {items.map((p, idx) => (
            <li
              key={`${p}-${idx}`}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-[hsl(var(--accent))] border border-[hsl(var(--border))]"
            >
              <code className="text-[0.7rem] font-mono">{p}</code>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, i) => i !== idx))}
                className="w-4 h-4 inline-flex items-center justify-center rounded hover:bg-[hsl(var(--destructive)/0.15)] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5 mt-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          className="h-7 text-[0.75rem] flex-1"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-[hsl(var(--border))] text-[0.7rem] hover:bg-[hsl(var(--accent))] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-3 h-3" />
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}

export function InlinePanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 pt-3 mt-1 border-t border-[hsl(var(--border))]">
      {children}
    </div>
  );
}

interface AdvancedProps {
  order: number;
  entry: StageManifestEntry;
  open: boolean;
  onToggle: () => void;
}

export function Advanced({ order, entry, open, onToggle }: AdvancedProps) {
  const { t } = useI18n();
  return (
    <section className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-[0.8125rem] font-semibold text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors text-left"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {t('envManagement.advancedTitle')}
        <span className="text-[0.6875rem] font-normal text-[hsl(var(--muted-foreground))]">
          {t('envManagement.advancedHintGeneric')}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-[hsl(var(--border))] pt-3">
          <StageGenericEditor order={order} entry={entry} />
        </div>
      )}
    </section>
  );
}

export interface CuratedSlotConfig {
  config: Record<string, unknown>;
  patch: (next: Record<string, unknown>) => void;
}

export function readSlotConfig(
  entry: StageManifestEntry,
  slot: string,
): Record<string, unknown> {
  return (entry.strategy_configs?.[slot] as Record<string, unknown> | undefined) ?? {};
}
