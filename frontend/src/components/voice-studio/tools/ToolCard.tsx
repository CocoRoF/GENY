'use client';

import { ReactNode, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface ToolCardProps {
  icon: ReactNode;
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Collapsible container shared by all 4 Tools page entries. Keeps each
 * tool out of the way until the user actually wants it.
 */
export default function ToolCard({ icon, title, hint, defaultOpen = false, children }: ToolCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-4 py-3 text-left bg-transparent border-none cursor-pointer"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        <span className="text-[0.9375rem] font-semibold text-[var(--text-primary)]">{title}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          {hint && <p className="text-[0.6875rem] text-[var(--text-muted)]">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}
