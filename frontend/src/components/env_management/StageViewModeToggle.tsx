'use client';

/**
 * StageViewModeToggle — segmented control in the stage header.
 *
 * Total height matches h-8 (the canonical control height across the
 * stage header chrome): outer p-0.5 + inner buttons h-7. Same
 * border / radius / background as the artifact dropdown and detail
 * button so the three controls read as a unified bar.
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
      aria-label="View mode"
      className="inline-flex items-center h-8 p-0.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] shrink-0"
    >
      <ModeButton
        active={mode === 'basic'}
        onClick={() => onChange('basic')}
        label={t('envManagement.viewMode.basic')}
        title={t('envManagement.viewMode.basicTip')}
        icon={<Wand2 className="w-3.5 h-3.5" />}
      />
      <ModeButton
        active={mode === 'developer'}
        onClick={() => onChange('developer')}
        label={t('envManagement.viewMode.developer')}
        title={t('envManagement.viewMode.developerTip')}
        icon={<Code2 className="w-3.5 h-3.5" />}
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
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-[0.75rem] font-medium transition-colors ${
        active
          ? 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]'
          : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
