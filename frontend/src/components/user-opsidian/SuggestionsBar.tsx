/**
 * SuggestionsBar — slot at the top of {@link InboxPanel} for the
 * Phase 5 organiser ("Group these 5 captures? / Promote to Library? /
 * Looks like a duplicate?").
 *
 * Phase 1 ships only the empty container so the layout is stable
 * when P5 fills it.  See docs §11.5 / §11.7.
 */

'use client';

import type { ReactNode } from 'react';

export interface SuggestionsBarProps {
  /** Phase 5 will inject suggestion cards here. */
  children?: ReactNode;
  className?: string;
}

export default function SuggestionsBar({ children, className }: SuggestionsBarProps) {
  if (!children) {
    // Render an unstyled stub so DOM tests can still find the slot,
    // but the user sees nothing until P5 adds content.
    return <div data-whiteboard-slot="suggestions-bar" hidden />;
  }
  return (
    <div
      className={className}
      data-whiteboard-slot="suggestions-bar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '8px 12px',
        margin: '0 0 8px',
        borderRadius: 8,
        background: 'var(--obs-bg-secondary, rgba(16,185,129,0.06))',
        border: '1px dashed rgba(16,185,129,0.4)',
      }}
    >
      {children}
    </div>
  );
}
