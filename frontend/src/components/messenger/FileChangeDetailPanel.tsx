'use client';

import { useState, useCallback } from 'react';
import { useMessengerStore } from '@/store/useMessengerStore';
import { useI18n } from '@/lib/i18n';
import DiffViewer from '@/components/execution/DiffViewer';
import { X } from 'lucide-react';

export default function FileChangeDetailPanel() {
  const { fileChangeDetail, setFileChangeDetail } = useMessengerStore();
  const { t } = useI18n();
  const [panelWidth, setPanelWidth] = useState(480);
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = panelWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const newWidth = Math.max(320, Math.min(900, startWidth + delta));
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [panelWidth]);

  if (!fileChangeDetail || fileChangeDetail.length === 0) return null;

  return (
    <div className="h-full shrink-0 flex" style={{ width: panelWidth, transition: isResizing ? 'none' : 'width 0.2s ease' }}>
      {/* Resize handle */}
      <div
        className="shrink-0 w-[4px] cursor-col-resize hover:bg-[var(--primary-color)] active:bg-[var(--primary-color)] transition-colors z-10"
        style={{ backgroundColor: isResizing ? 'var(--primary-color)' : 'transparent' }}
        onMouseDown={handleResizeStart}
      />

      {/* Panel content */}
      <div className="flex-1 min-w-0 border-l border-[var(--border-color)] bg-[var(--bg-primary)] flex flex-col overflow-hidden">
        {/* Header — h-14 matches RoomHeader */}
        <div className="h-14 flex items-center justify-between px-4 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0">
          <span className="text-[0.8125rem] font-semibold text-[var(--text-primary)]">
            {t('messenger.fileChanges.title')} ({fileChangeDetail.length})
          </span>
          <button
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors border-none bg-transparent cursor-pointer"
            onClick={() => setFileChangeDetail(null)}
          >
            <X size={14} />
          </button>
        </div>

        {/* Diff list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {fileChangeDetail.map((fc, i) => (
            <DiffViewer key={i} fileChanges={fc} />
          ))}
        </div>
      </div>
    </div>
  );
}
