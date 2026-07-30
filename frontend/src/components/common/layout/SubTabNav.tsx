'use client';

/**
 * SubTabNav — horizontal sub-tab bar.
 *
 * The tab group itself IS a SegmentedControl instance — the exact same
 * component (and DOM structure) as inline toggles like the storage
 * tab's workspace/all switch. SubTabNav only adds the bar chrome
 * around it: bottom border, optional leading identity and trailing
 * controls.
 */

import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from './cn';
import { SegmentedControl } from './SegmentedControl';

export interface SubTabDef {
  id: string;
  label: string;
  icon?: LucideIcon;
  count?: number;
}

export interface SubTabNavProps {
  tabs: SubTabDef[];
  active: string;
  onSelect: (id: string) => void;
  /** Optional content pinned to the LEFT of the tabs (e.g. an entity name),
   *  separated by a divider. Lets a single bar carry an identity + the tabs. */
  leading?: ReactNode;
  /** Optional content pinned to the RIGHT (e.g. a mode toggle). */
  trailing?: ReactNode;
  /** Extra classes for the <nav> — e.g. `h-[49px]` to match a header band.
   *  Merged last (twMerge) so it can override the default h-9 / padding. */
  className?: string;
}

export function SubTabNav({ tabs, active, onSelect, leading, trailing, className }: SubTabNavProps) {
  return (
    <nav
      className={cn(
        'flex items-center gap-0.5 px-2 md:px-3 h-9 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] shrink-0 overflow-x-auto scrollbar-hide',
        className,
      )}
    >
      {leading != null && (
        <div className="flex items-center min-w-0 shrink-0 pr-2 mr-1 border-r border-[hsl(var(--border))]">
          {leading}
        </div>
      )}
      {tabs.length > 0 && (
        <SegmentedControl
          items={tabs}
          value={active}
          onChange={onSelect}
        />
      )}
      {trailing != null && (
        <div className="flex items-center ml-auto pl-2 shrink-0">{trailing}</div>
      )}
    </nav>
  );
}

export default SubTabNav;
