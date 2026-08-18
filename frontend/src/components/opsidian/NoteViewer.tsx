'use client';

import { useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useOpsidianStore } from '@/store/useOpsidianStore';
import { openNote } from '@/lib/vaultCatalog';
import { memoryApi } from '@/lib/api';
import {
  attachmentUrlTransform,
  makeAttachmentMarkdownComponents,
  preprocessAttachmentEmbeds,
} from '@/components/user-opsidian/AttachmentEmbed';
import {
  Tag,
  Link2,
  Clock,
  AlertCircle,
  FileText,
  ExternalLink,
} from 'lucide-react';
// Memory v2 — single source of truth at `@/lib/memoryCategories`.
import { CATEGORY_ICONS } from '@/lib/memoryCategories';

const IMPORTANCE_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  critical: { bg: 'rgba(239,68,68,0.15)', color: '#ef4444', label: 'Critical' },
  high: { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b', label: 'High' },
  medium: { bg: 'rgba(59,130,246,0.1)', color: '#3b82f6', label: 'Medium' },
  low: { bg: 'rgba(100,116,139,0.1)', color: '#64748b', label: 'Low' },
};

export default function NoteViewer() {
  const {
    selectedFile,
    fileDetail,
    files,
    selectedSessionId,
  } = useOpsidianStore();

  // Navigate to a file via wikilink
  const navigateToFile = useCallback(
    async (target: string) => {
      const targetLower = target.toLowerCase();
      const match = Object.values(files).find(
        (f) =>
          f.filename.toLowerCase().includes(targetLower) ||
          f.title.toLowerCase() === targetLower
      );
      if (match) {
        await openNote(selectedSessionId, match.filename);
      }
    },
    [files, selectedSessionId]
  );

  // Process markdown body: attachment embeds FIRST (consumes the leading
  // `!` of `![[img.jpg]]` — otherwise the wikilink pass below leaves a
  // broken markdown image), then wikilinks.
  const body = fileDetail?.body ?? '';
  const processedBody = useMemo(() => {
    if (!body) return '';
    return preprocessAttachmentEmbeds(body).replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_match, target, alias) => {
        const display = alias || target;
        return `[🔗 ${display}](wikilink://${encodeURIComponent(target)})`;
      }
    );
  }, [body]);

  // Session-scoped attachment resolution — observation frames live in the
  // agent session's storage, not the user-opsidian vault.
  const attachmentComponents = useMemo(
    () =>
      makeAttachmentMarkdownComponents(
        selectedSessionId
          ? (path) => memoryApi.attachmentUrl(selectedSessionId, path)
          : undefined,
      ),
    [selectedSessionId],
  );

  if (!selectedFile) {
    return (
      <div className="obs-note-empty">
        <div className="obs-note-empty-inner">
          <FileText size={48} strokeWidth={1} />
          <p>Select a note from the sidebar to view it</p>
          <p className="obs-note-hint">
            Or press <kbd>Ctrl+G</kbd> to open the Graph View
          </p>
        </div>
      </div>
    );
  }

  if (!fileDetail) {
    return (
      <div className="obs-note-empty">
        <div className="obs-note-loading">Loading note…</div>
      </div>
    );
  }

  // Note properties arrive as TOP-LEVEL fields of the read-file response
  // (`fileDetail.metadata` is the host-extension sidecar and is usually
  // empty — reading it here used to fall back to 'topics'/'Medium' for
  // every observation note).
  const fm = (fileDetail.frontmatter || {}) as Record<string, unknown>;
  const category = fileDetail.category || (fm.category as string) || 'topics';
  const importance =
    IMPORTANCE_STYLES[fileDetail.importance || 'medium'] || IMPORTANCE_STYLES.medium;
  const CatIcon = CATEGORY_ICONS[category] || FileText;
  const noteTitle = fileDetail.title || selectedFile;
  const noteSource = fm.source;
  const created = fileDetail.created || (fm.created as string) || '';
  const tags = Array.isArray(fileDetail.tags) ? fileDetail.tags : [];
  const linksTo = Array.isArray(fileDetail.links_to) ? fileDetail.links_to : [];
  const linkedFrom = Array.isArray(fileDetail.linked_from)
    ? fileDetail.linked_from
    : [];
  const fileInfo = files[selectedFile];

  return (
    <div className="obs-note">
      {/* Frontmatter header */}
      <div className="obs-note-header">
        <div className="obs-note-title-row">
          <CatIcon size={18} style={{ color: 'var(--primary-color)' }} />
          <h1 className="obs-note-title">{noteTitle}</h1>
        </div>

        <div className="obs-note-meta-row">
          <span className="obs-note-badge" style={{ background: importance.bg, color: importance.color }}>
            <AlertCircle size={11} />
            {importance.label}
          </span>
          <span className="obs-note-badge obs-note-badge-cat">
            <CatIcon size={11} />
            {category}
          </span>
          {noteSource ? (
            <span className="obs-note-badge obs-note-badge-source">
              {String(noteSource)}
            </span>
          ) : null}
          {created ? (
            <span className="obs-note-meta-item">
              <Clock size={11} />
              {new Date(String(created)).toLocaleDateString('ko-KR')}
            </span>
          ) : null}
          {fileInfo && (
            <span className="obs-note-meta-item">
              {fileInfo.char_count.toLocaleString()} chars
            </span>
          )}
        </div>

        {/* Tags */}
        {tags.length > 0 && (
          <div className="obs-note-tags">
            {tags.map((tag) => (
              <span key={String(tag)} className="obs-note-tag">
                <Tag size={10} />
                {String(tag)}
              </span>
            ))}
          </div>
        )}

        {/* Links */}
        {(linksTo.length > 0 || linkedFrom.length > 0) && (
          <div className="obs-note-links">
            {linksTo.length > 0 && (
              <div className="obs-note-link-group">
                <ExternalLink size={11} />
                <span className="obs-note-link-label">Links to:</span>
                {linksTo.map((l) => (
                  <button
                    key={String(l)}
                    className="obs-note-link"
                    onClick={() => navigateToFile(String(l))}
                  >
                    {String(l)}
                  </button>
                ))}
              </div>
            )}
            {linkedFrom.length > 0 && (
              <div className="obs-note-link-group">
                <Link2 size={11} />
                <span className="obs-note-link-label">Linked from:</span>
                {linkedFrom.map((l) => (
                  <button
                    key={String(l)}
                    className="obs-note-link"
                    onClick={() => navigateToFile(String(l))}
                  >
                    {String(l)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Markdown body */}
      <div className="obs-note-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={attachmentUrlTransform}
          components={{
            ...attachmentComponents,
            a: ({ href, children }) => {
              if (href?.startsWith('wikilink://')) {
                const target = decodeURIComponent(href.replace('wikilink://', ''));
                return (
                  <button
                    className="obs-wikilink"
                    onClick={() => navigateToFile(target)}
                  >
                    {children}
                  </button>
                );
              }
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
            code: ({ className, children, ...props }) => {
              const isInline = !className;
              if (isInline) {
                return <code className="obs-inline-code" {...props}>{children}</code>;
              }
              return (
                <pre className="obs-code-block">
                  <code className={className} {...props}>{children}</code>
                </pre>
              );
            },
          }}
        >
          {processedBody}
        </ReactMarkdown>
      </div>
    </div>
  );
}
