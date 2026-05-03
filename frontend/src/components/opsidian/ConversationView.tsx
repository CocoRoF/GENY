'use client';

/**
 * Memory v2 PR 5 — Opsidian Conversation view.
 *
 * Plan §4.5: Opsidian was missing the conversation surface
 * entirely (review.md P1, P2). Notes-side category tree + the
 * existing Stream timeline now both live inside the same
 * Opsidian "sessions" scope so an operator can:
 *
 *   * browse ``memory/conversations/`` and ``memory/dms/`` as
 *     real markdown vault notes, OR
 *   * watch the InteractionEvent stream live with the existing
 *     stream-tab UX (counterpart sidebar, kind filter, direction
 *     toggle, click-through modal),
 *
 * and switch between the two angles on the same data without
 * leaving Opsidian.
 *
 * The component is a thin shell:
 *   - sub-view toggle ("Notes" ↔ "Stream")
 *   - Notes mode embeds the existing NoteViewer, scoped to the
 *     conversations/ + dms/ subset of the vault tree.
 *   - Stream mode embeds the existing tabs/memory/StreamTab so
 *     the two surfaces share the same backend API and rendering
 *     code (no duplicated logic).
 */

import { useMemo, useState, useCallback } from 'react';
import { useOpsidianStore } from '@/store/useOpsidianStore';
import { memoryApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { MessageSquare, FileText, ExternalLink } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import StreamTab from '../tabs/memory/StreamTab';
import NoteViewer from './NoteViewer';

function cn(...c: (string | boolean | undefined | null)[]) {
  return twMerge(c.filter(Boolean).join(' '));
}

type SubView = 'notes' | 'stream';

const CONVERSATION_CATEGORIES = ['conversations', 'dms'] as const;

export default function ConversationView() {
  const {
    selectedSessionId,
    files,
    selectedFile,
    openFile,
    setFileDetail,
  } = useOpsidianStore();
  const { t } = useI18n();
  const [sub, setSub] = useState<SubView>('stream');

  // Filter the existing vault tree down to the conversation-related
  // categories so the Notes sub-view stays focused. The full tree
  // remains accessible via the editor view.
  // Cycle 20260503_6 — ``daily-journal`` retired; conversations
  // rollup files (one per session-bucket) are the chronological
  // surface now via their date_first/date_last frontmatter.
  const conversationFiles = useMemo(() => {
    const out: Record<string, typeof files[string]> = {};
    for (const [k, v] of Object.entries(files)) {
      if (CONVERSATION_CATEGORIES.includes(v?.category as never)) {
        out[k] = v;
      }
    }
    return out;
  }, [files]);

  const conversationsTree = useMemo(() => {
    const tree: Record<string, typeof files[string][]> = {};
    for (const info of Object.values(conversationFiles)) {
      const key = info.category || 'root';
      if (!tree[key]) tree[key] = [];
      tree[key].push(info);
    }
    for (const list of Object.values(tree)) {
      list.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    }
    return tree;
  }, [conversationFiles]);

  const handleSelectFile = useCallback(async (filename: string) => {
    if (!selectedSessionId) return;
    openFile(filename);
    try {
      const detail = await memoryApi.readFile(selectedSessionId, filename);
      setFileDetail(detail);
    } catch (err) {
      console.error('ConversationView: file read failed', err);
    }
  }, [selectedSessionId, openFile, setFileDetail]);

  if (!selectedSessionId) {
    return (
      <div className="flex items-center justify-center w-full h-full text-[12px] text-[var(--text-muted)]">
        {t('opsidian.conversationSelectSession')}
      </div>
    );
  }

  return (
    // ``h-full`` keeps the toggle bar pinned at the top and the
    // body cell taking the remaining viewport height — flex chain
    // continues into <NotesBrowser> / <StreamTab>. Cycle 20260503_8.
    <div className="flex flex-col flex-1 min-h-0 h-full gap-2 p-3">
      {/* Sub-view toggle */}
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex items-center rounded border border-[var(--border-color)] overflow-hidden">
          <button
            onClick={() => setSub('stream')}
            className={cn(
              'px-3 py-1 text-[11px] font-medium transition-colors flex items-center gap-1.5',
              sub === 'stream'
                ? 'bg-[var(--primary-color)] text-white'
                : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
            )}
          >
            <MessageSquare size={11} /> {t('opsidian.conversationStream')}
          </button>
          <button
            onClick={() => setSub('notes')}
            className={cn(
              'px-3 py-1 text-[11px] font-medium transition-colors border-l border-[var(--border-color)] flex items-center gap-1.5',
              sub === 'notes'
                ? 'bg-[var(--primary-color)] text-white'
                : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
            )}
          >
            <FileText size={11} /> {t('opsidian.conversationNotes')}
          </button>
        </div>
        <span className="text-[10.5px] text-[var(--text-muted)] ml-1">
          {sub === 'stream'
            ? t('opsidian.conversationStreamHint')
            : t('opsidian.conversationNotesHint', {
                count: Object.keys(conversationFiles).length,
              })}
        </span>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {sub === 'stream' ? (
          <StreamTab sessionId={selectedSessionId} />
        ) : (
          <NotesBrowser
            tree={conversationsTree}
            selectedFile={selectedFile}
            onSelect={handleSelectFile}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────


function NotesBrowser({
  tree,
  selectedFile,
  onSelect,
}: {
  tree: Record<string, Array<{ filename: string; title: string; category: string; modified: string }>>;
  selectedFile: string | null;
  onSelect: (filename: string) => void;
}) {
  const { t } = useI18n();
  const categories = Object.keys(tree).sort();
  const total = Object.values(tree).reduce((acc, list) => acc + list.length, 0);

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full gap-2 text-[12px] text-[var(--text-muted)]">
        <FileText size={28} className="opacity-40" />
        <span>{t('opsidian.conversationEmpty')}</span>
      </div>
    );
  }

  return (
    // ``h-full`` ensures the row reaches viewport height; both
    // panels then independently scroll without their parent
    // collapsing to content size. Cycle 20260503_8.
    <div className="flex flex-1 min-h-0 h-full gap-3">
      {/* Left: per-category file list — fixed-width column,
          self-scrolls. Sticky category headers keep the section
          label visible while the operator scrolls a long list. */}
      <div className="w-[300px] shrink-0 h-full min-h-0 overflow-y-auto bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded p-2">
        {categories.map((cat) => (
          <div key={cat} className="mb-3">
            <div className="sticky top-0 z-10 -mx-2 -mt-2 px-3 py-1.5 mb-1 text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wide bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
              {cat} ({tree[cat].length})
            </div>
            {tree[cat].map((info) => {
              const isActive = info.filename === selectedFile;
              return (
                <button
                  key={info.filename}
                  onClick={() => onSelect(info.filename)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded text-[12px] transition-colors mb-0.5',
                    isActive
                      ? 'bg-[rgba(59,130,246,0.12)] text-[var(--primary-color)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                  )}
                  title={`${info.filename}\n${info.modified}`}
                >
                  <div className="truncate">{info.title || info.filename}</div>
                  <div className="text-[10px] text-[var(--text-muted)] truncate">
                    {info.filename}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Right: NoteViewer — flexible-width column, self-scrolls. */}
      <div className="flex-1 min-w-0 h-full min-h-0 overflow-y-auto">
        {selectedFile ? (
          <NoteViewer />
        ) : (
          <div className="flex items-center justify-center w-full h-full text-[12px] text-[var(--text-muted)]">
            {t('opsidian.conversationSelectNote')}
            <ExternalLink size={12} className="ml-2 opacity-60" />
          </div>
        )}
      </div>
    </div>
  );
}
