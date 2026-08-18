'use client';

import { useOpsidianStore } from '@/store/useOpsidianStore';
import { openNote } from '@/lib/vaultCatalog';
import { X, FileText } from 'lucide-react';

export default function OpsidianTabs() {
  const {
    openFiles,
    selectedFile,
    selectedSessionId,
    files,
    closeFile,
  } = useOpsidianStore();

  const handleTabClick = (fn: string) => openNote(selectedSessionId, fn);


  if (openFiles.length === 0) return null;

  return (
    // A tab strip that only a mouse can reach is not a tab strip. These
    // were plain <div onClick>: no keyboard focus, no way to activate
    // without a pointer, and nothing announced about which one is open.
    <div className="obs-tabs-bar" role="tablist" aria-label="열린 노트">
      {openFiles.map((fn) => {
        const info = files[fn];
        const isActive = fn === selectedFile;
        const label = info?.title || fn;
        return (
          <div
            key={fn}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            title={fn}
            className={`obs-tab ${isActive ? 'active' : ''}`}
            onClick={() => handleTabClick(fn)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleTabClick(fn);
              } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                closeFile(fn);
              }
            }}
          >
            <FileText size={12} />
            <span className="obs-tab-name">{label}</span>
            <button
              className="obs-tab-close"
              aria-label={`${label} 탭 닫기`}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                closeFile(fn);
              }}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
