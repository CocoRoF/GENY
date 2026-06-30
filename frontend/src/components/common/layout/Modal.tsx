'use client';

/**
 * Modal — the reusable, design-system modal package.
 *
 * A composable, general-purpose dialog built on the themed shadcn Dialog
 * primitive (so it inherits Geny's tokens: card bg, border, foreground). Use
 * this for ANY modal that isn't a CRUD form (those keep `EditorModal`).
 *
 *   <Modal open={open} onClose={close} title="…" description="…" icon={<X/>}
 *          size="lg" headerActions={<button…/>} footer={<>…</>}>
 *     …body…
 *   </Modal>
 *
 * Features: 7 sizes, optional icon + truncating title/description, header-action
 * slot, sticky header/footer with a scrollable body, dismiss control (backdrop /
 * Esc / X), and a `ConfirmModal` for destructive/confirm flows.
 */

import { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogCloseButton,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from './cn';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'full';

const SIZE: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  '2xl': 'max-w-3xl',
  '3xl': 'max-w-5xl',
  full: 'max-w-[95vw]',
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Small leading glyph in the header (e.g. a lucide icon). */
  icon?: ReactNode;
  size?: ModalSize;
  /** Buttons rendered in the header, left of the close (X). */
  headerActions?: ReactNode;
  footer?: ReactNode;
  /** Extra classes on the scrollable body wrapper. */
  bodyClassName?: string;
  /** Backdrop click / Esc closes the modal (default true). */
  dismissable?: boolean;
  /** Show the header X (default true). */
  showClose?: boolean;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  icon,
  size = 'lg',
  headerActions,
  footer,
  bodyClassName,
  dismissable = true,
  showClose = true,
  children,
}: ModalProps) {
  const hasHeader = Boolean(title || description || icon || headerActions || showClose);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissable) onClose();
      }}
    >
      <DialogContent
        className={cn(SIZE[size], 'p-0 max-h-[88vh] flex flex-col gap-0')}
        onPointerDownOutside={(e) => {
          if (!dismissable) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (!dismissable) e.preventDefault();
        }}
      >
        {hasHeader && (
          <DialogHeader>
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {icon && (
                <span className="shrink-0 text-[hsl(var(--muted-foreground))]">{icon}</span>
              )}
              <div className="min-w-0">
                {title && <DialogTitle className="truncate">{title}</DialogTitle>}
                {description && (
                  <DialogDescription className="truncate mt-0.5">
                    {description}
                  </DialogDescription>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {headerActions}
              {showClose && <DialogCloseButton />}
            </div>
          </DialogHeader>
        )}
        <div className={cn('overflow-y-auto p-4 flex-1 min-h-0', bodyClassName)}>{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

export interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title?: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
  /** Disable buttons + block dismiss while an action runs. */
  busy?: boolean;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title = '확인',
  message,
  confirmLabel = '확인',
  cancelLabel = '취소',
  danger = false,
  busy = false,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      dismissable={!busy}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'destructive' : 'default'}
            size="sm"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? '…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-[hsl(var(--foreground))] leading-relaxed">{message}</div>
    </Modal>
  );
}

export default Modal;
