'use client';

/**
 * StageViewModeToggle — segmented control in the stage header that
 * flips the body between curated ("basic") and raw ("developer")
 * views. The header chrome (artifact picker, detail button, active
 * card) stays unchanged across modes; only the body swaps.
 *
 * Lifted into StageDetailView as a single state so the choice
 * persists when the user clicks across stages.
 */

import { Code2, Wand2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export type StageViewMode = 'basic' | 'developer';

interface Props {
  mode: StageViewMode;
  onChange: (mode: StageViewMode) => void;
}

export default function StageViewModeToggle({ mode, onChange }: Props) {
  const { t } = useI18n();

  return (
    <div
      role="group"
      className="inline-flex items-center rounded-md border border-[hsl(var(--border))] p-0.5 bg-[hsl(var(--background))] shrink-0"
    >
      <ModeButton
        active={mode === 'basic'}
        onClick={() => onChange('basic')}
        label={t('envManagement.viewMode.basic')}
        title={t('envManagement.viewMode.basicTip')}
        icon={<Wand2 className="w-3 h-3" />}
      />
      <ModeButton
        active={mode === 'developer'}
        onClick={() => onChange('developer')}
        label={t('envManagement.viewMode.developer')}
        title={t('envManagement.viewMode.developerTip')}
        icon={<Code2 className="w-3 h-3" />}
      />
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  title,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-[0.7rem] font-medium transition-colors ${
        active
          ? 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]'
          : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]'
      }`}
      aria-pressed={active}
    >
      {icon}
      {label}
    </button>
  );
}
