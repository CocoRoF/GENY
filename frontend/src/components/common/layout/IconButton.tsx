'use client';

/**
 * IconButton — the ONE icon-only button for toolbars and headers.
 *
 * Design contract (2026-07-30 unification):
 *  - Fixed 32×32 box (h-8 w-8) so every toolbar row lines up with
 *    ActionButton's h-8. Never override the size.
 *  - `title` is REQUIRED: icon-only buttons must self-describe. It feeds
 *    both the native tooltip and aria-label.
 *  - Canonical action icons — use exactly these everywhere:
 *      refresh → RefreshCw · download → Download · upload → Upload
 *      new folder → FolderPlus · create/new → Plus
 */

import { ButtonHTMLAttributes } from 'react';
import { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from './cn';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

const VARIANT_TO_SHADCN: Record<Variant, 'outline' | 'default' | 'destructive' | 'ghost'> = {
  default: 'outline',
  primary: 'outline',
  danger: 'destructive',
  ghost: 'ghost',
};

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> {
  icon: LucideIcon;
  /** Tooltip + aria-label. Required — an icon-only button must name itself. */
  title: string;
  variant?: Variant;
  /** Animate the icon (e.g. an in-flight refresh). */
  spin?: boolean;
}

export function IconButton({
  icon: Icon,
  title,
  variant = 'default',
  spin = false,
  className,
  ...rest
}: IconButtonProps) {
  const isDanger = variant === 'danger';
  return (
    <Button
      variant={VARIANT_TO_SHADCN[variant]}
      size="icon"
      title={title}
      aria-label={title}
      className={cn(
        'shrink-0',
        // "primary" is a SUBTLE emphasis, not a solid fill — same outline
        // box as default, tinted with the accent so it reads as the
        // suggested action without looking like a different-sized button.
        variant === 'primary' &&
          'text-[hsl(var(--primary))] border-[hsl(var(--primary)/0.35)] bg-[hsl(var(--primary)/0.08)] hover:bg-[hsl(var(--primary)/0.16)] hover:text-[hsl(var(--primary))]',
        // outline+danger keeps the pre-shadcn red-outline look.
        isDanger && 'bg-transparent text-red-600 border border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-500/40 dark:hover:bg-red-500/10',
        className,
      )}
      {...rest}
    >
      <Icon className={cn(spin && 'animate-spin')} />
    </Button>
  );
}

export default IconButton;
