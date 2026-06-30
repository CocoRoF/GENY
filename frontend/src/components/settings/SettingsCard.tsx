'use client';

/**
 * SettingsCard — Settings-surface card. Now a thin adapter over the canonical
 * {@link EntityCard} (so every card shares one tone & manner). Public props are
 * unchanged: a neutral icon tile, a single status dot, muted meta, footer
 * actions. Use it wherever a settings panel needs a card.
 */

import type { ReactNode } from 'react';
import { EntityCard, type EntityTone } from '@/components/common/layout/EntityCard';

export type CardStatusTone = 'good' | 'warn' | 'bad' | 'neutral';

export interface SettingsCardProps {
  title: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  status?: { tone: CardStatusTone; label: ReactNode };
  children?: ReactNode;
  footer?: ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
  className?: string;
}

export function SettingsCard({
  title,
  icon,
  meta,
  status,
  children,
  footer,
  onClick,
  ariaLabel,
  className = '',
}: SettingsCardProps) {
  return (
    <EntityCard
      layout="split"
      icon={icon}
      iconTone="neutral"
      title={title}
      meta={meta}
      status={status ? { tone: status.tone as EntityTone, label: status.label, as: 'dot' } : undefined}
      footer={footer}
      onClick={onClick}
      ariaLabel={ariaLabel}
      className={className}
    >
      {children}
    </EntityCard>
  );
}

export default SettingsCard;
