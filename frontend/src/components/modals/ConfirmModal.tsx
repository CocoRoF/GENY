'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n } from '@/lib/i18n';
import { X } from 'lucide-react';

interface ConfirmModalProps {
  title: string;
  message: string | React.ReactNode;
  note?: string;
  confirmLabel?: string;
  confirmingLabel?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export default function ConfirmModal({
  title,
  message,
  note,
  confirmLabel,
  confirmingLabel,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const handleConfirm = useCallback(async () => {
    setLoading(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      setLoading(false);
    }
  }, [onConfirm, onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && !loading) {
        e.preventDefault();
        handleConfirm();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, handleConfirm, loading]);

  // Focus confirm button on mount for accessibility
  useEffect(() => {
    confirmBtnRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-full max-w-[400px] max-h-[85vh] flex flex-col shadow-[var(--shadow-lg)]"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center py-4 px-6 border-b border-[var(--border-color)]">
          <h3 className="text-[1rem] font-semibold text-[var(--text-primary)]">{title}</h3>
          <button
            className="flex items-center justify-center w-8 h-8 rounded-[var(--border-radius)] bg-transparent border-none text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
          <div className="text-[0.8125rem] text-[var(--text-secondary)]">{message}</div>
          {note && <p className="text-[0.75rem] text-[var(--text-muted)] mt-3">{note}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end items-center gap-3 py-4 px-6 border-t border-[var(--border-color)]">
          <button
            className="py-2 px-4 bg-transparent hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] text-[0.8125rem] font-medium rounded-[var(--border-radius)] cursor-pointer transition-all duration-150 border border-[var(--border-color)]"
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            ref={confirmBtnRef}
            className="py-2 px-4 bg-[var(--danger-color)] hover:brightness-110 text-white text-[0.8125rem] font-medium rounded-[var(--border-radius)] cursor-pointer transition-all duration-150 border-none disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? (confirmingLabel || t('deleteSessionModal.deleting')) : (confirmLabel || t('common.delete'))}
          </button>
        </div>
      </div>
    </div>
  );
}
