'use client';

/**
 * TriggerSectionBar — horizontal navigator for the trigger preset
 * editor.
 *
 * Inspired by :mod:`StageProgressBar` but stripped of the
 * infinite-rotation + drag wheel: there are only five sections, so
 * a static row reads better. The visual vocabulary stays consistent:
 *
 *   - Numbered circles connected by a horizontal rail
 *   - Active section: blue ring + label weight
 *   - Validation badge (red dot) when the section has open issues
 *   - Hover: subtle lift / colour shift
 *
 * A small "saved/dirty" indicator below the active section header
 * lets operators glance the dirty state without having to look at
 * the footer.
 */

import type { LucideIcon } from 'lucide-react';
import { useTheme } from '@/lib/theme';

const PALETTE = {
  light: {
    selectedBg: 'rgb(219 234 254)', // blue-100
    selectedFg: 'rgb(29 78 216)', // blue-700
    selectedBorder: 'rgb(59 130 246)', // blue-500
    selectedRing:
      '0 0 0 3px hsl(var(--card)), 0 0 0 4.5px rgb(59 130 246 / 0.55), 0 3px 10px -3px rgb(59 130 246 / 0.3)',
    idleBg: 'rgb(244 244 245)', // zinc-100
    idleFg: 'rgb(82 82 91)', // zinc-600
    idleBorder: 'rgb(212 212 216)', // zinc-300
    rail: 'rgb(228 228 231)', // zinc-200
  },
  dark: {
    selectedBg: 'rgb(30 58 138 / 0.5)', // blue-900 @ 50%
    selectedFg: 'rgb(147 197 253)', // blue-300
    selectedBorder: 'rgb(96 165 250)', // blue-400
    selectedRing:
      '0 0 0 3px hsl(var(--card)), 0 0 0 4.5px rgb(96 165 250 / 0.55), 0 3px 12px -2px rgb(96 165 250 / 0.4)',
    idleBg: 'rgb(39 39 42 / 0.5)', // zinc-800 @ 50%
    idleFg: 'rgb(161 161 170)', // zinc-400
    idleBorder: 'rgb(63 63 70)', // zinc-700
    rail: 'rgb(63 63 70)', // zinc-700
  },
} as const;

export interface TriggerSectionDef<Id extends string = string> {
  id: Id;
  label: string;
  icon: LucideIcon;
  /** Short hint shown below the active section card. */
  hint?: string;
  /** When true, the section header shows a red validation dot. */
  hasIssue?: boolean;
  /** Optional badge text rendered next to the label (e.g. "3 phases"). */
  badge?: string;
}

export interface TriggerSectionBarProps<Id extends string> {
  sections: TriggerSectionDef<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
}

const ROW_HEIGHT = 56;
const RAIL_TOP = ROW_HEIGHT / 2;

export default function TriggerSectionBar<Id extends string>({
  sections,
  selected,
  onSelect,
}: TriggerSectionBarProps<Id>) {
  const { theme } = useTheme();
  const palette = PALETTE[theme === 'dark' ? 'dark' : 'light'];

  return (
    <div className="relative bg-[hsl(var(--card))] border-b border-[hsl(var(--border))] px-6 py-4">
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background:
            'radial-gradient(ellipse 70% 100% at 50% 50%, hsl(var(--primary) / 0.08) 0%, transparent 70%)',
        }}
      />

      <div className="relative flex items-start justify-center gap-0">
        {sections.map((section, idx) => {
          const Icon = section.icon;
          const isSelected = section.id === selected;
          const isLast = idx === sections.length - 1;

          const circleStyle: React.CSSProperties = isSelected
            ? {
                background: palette.selectedBg,
                color: palette.selectedFg,
                border: `2px solid ${palette.selectedBorder}`,
                boxShadow: palette.selectedRing,
              }
            : {
                background: palette.idleBg,
                color: palette.idleFg,
                border: `2px solid ${palette.idleBorder}`,
              };

          const labelColor = isSelected
            ? palette.selectedFg
            : 'hsl(var(--muted-foreground))';

          return (
            <div key={section.id} className="flex items-start shrink-0">
              <div className="flex flex-col items-center min-w-[110px]">
                <div
                  style={{ height: ROW_HEIGHT }}
                  className="flex items-center justify-center"
                >
                  <button
                    type="button"
                    onClick={() => onSelect(section.id)}
                    className="group relative outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] rounded-full"
                    title={section.label}
                    aria-current={isSelected ? 'page' : undefined}
                  >
                    <span
                      className="relative flex items-center justify-center rounded-full font-semibold transition-all duration-200 w-[44px] h-[44px] text-[0.875rem] group-hover:scale-105"
                      style={circleStyle}
                    >
                      <Icon className="w-[18px] h-[18px]" strokeWidth={2.25} />
                      {section.hasIssue && (
                        <span
                          aria-label="needs attention"
                          className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-red-500"
                          style={{
                            boxShadow: '0 0 0 2.5px hsl(var(--card))',
                          }}
                        />
                      )}
                    </span>
                  </button>
                </div>

                <span
                  className={`mt-1 text-[0.75rem] tracking-tight truncate max-w-[110px] leading-tight transition-colors ${
                    isSelected ? 'font-semibold' : 'font-medium'
                  }`}
                  style={{ color: labelColor }}
                >
                  {section.label}
                </span>
                {section.badge && (
                  <span
                    className="mt-0.5 text-[0.625rem] tabular-nums px-1.5 py-px rounded bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]"
                  >
                    {section.badge}
                  </span>
                )}
              </div>

              {!isLast && (
                <div
                  style={{ height: ROW_HEIGHT }}
                  className="flex items-center"
                >
                  <span
                    aria-hidden
                    className="block h-[2px] rounded-full"
                    style={{
                      width: 36,
                      background: palette.rail,
                      opacity: 0.7,
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
