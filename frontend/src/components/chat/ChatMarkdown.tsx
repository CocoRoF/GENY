'use client';

import { memo, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { splitEmotionSegments, EMOTION_COLORS } from './chat-utils';
import { getToken } from '@/lib/authApi';

/**
 * Agent replies routinely embed gated API URLs (session storage files:
 * `/api/agents/<sid>/storage-raw/...`) as markdown images/links. Those
 * endpoints require auth, and a bare `<img src>`/`<a href>` can only carry
 * the same-origin cookie — absent in the desktop connector (URL-token →
 * localStorage, no cookie) and absent when the browser opens the URL
 * directly (→ {"detail":"Authentication required"}). So: detect same-origin
 * API URLs, fetch the bytes with the Bearer token, and serve them as blob:
 * URLs — for inline rendering AND for click-through viewing.
 */
export function apiPathOf(href?: string): string | null {
  if (!href) return null;
  if (href.startsWith('/api/')) return href;
  if (typeof window !== 'undefined' && (href.startsWith('http://') || href.startsWith('https://'))) {
    try {
      const u = new URL(href);
      if (u.origin === window.location.origin && u.pathname.startsWith('/api/')) {
        return u.pathname + u.search;
      }
    } catch { /* not a URL */ }
  }
  return null;
}

async function fetchApiBlobUrl(path: string): Promise<string> {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

export function AuthedChatImage({ path, alt }: { path: string; alt: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let obj: string | null = null;
    setBlobUrl(null);
    setFailed(false);
    fetchApiBlobUrl(path)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        obj = u;
        setBlobUrl(u);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [path]);

  if (failed) {
    return (
      <span className="inline-block px-2 py-1 my-1 text-[0.6875rem] text-[var(--text-muted)] border border-dashed border-[var(--border-color)] rounded">
        🖼️ {alt || 'image'} — 불러오지 못했습니다
      </span>
    );
  }
  if (!blobUrl) {
    return (
      <span className="inline-block px-2 py-1 my-1 text-[0.6875rem] text-[var(--text-muted)] animate-pulse">
        🖼️ {alt || 'image'} 로딩…
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={blobUrl}
      alt={alt}
      className="max-w-full max-h-[420px] rounded-md border border-[var(--border-color)] my-1.5 cursor-zoom-in"
      onClick={() => window.open(blobUrl, '_blank', 'noopener,noreferrer')}
    />
  );
}

/** Open a gated API link: fetch with Bearer → blob URL → new tab. */
export async function openAuthedLink(path: string) {
  try {
    const u = await fetchApiBlobUrl(path);
    const w = window.open(u, '_blank', 'noopener,noreferrer');
    if (!w) {
      // Popup blocked — fall back to a download.
      const a = document.createElement('a');
      a.href = u;
      a.download = path.split('/').pop() || 'file';
      a.click();
    }
    // Give the new tab time to load before revoking.
    setTimeout(() => URL.revokeObjectURL(u), 60_000);
  } catch {
    /* leave the default 401 page to explain */
  }
}

/**
 * Lightweight Markdown renderer for chat messages.
 *
 * Unlike the full-page MarkdownRenderer in file-viewer/,
 * this is styled for inline chat bubbles — compact spacing,
 * code blocks with copy button, and GFM support.
 */

// ── Copy button for code blocks ──
function CopyBtn({ text }: { text: string }) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* ignore */ }
  };
  return (
    <button
      onClick={handleCopy}
      className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded text-[0.5625rem] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all cursor-pointer border-none bg-transparent opacity-0 group-hover/codeblock:opacity-100"
      title="Copy"
    >
      Copy
    </button>
  );
}

// ── Custom components for react-markdown ──
const mdComponents: Components = {
  // Fenced code blocks
  pre({ children }) {
    return (
      <div className="relative group/codeblock my-1.5">
        {children}
      </div>
    );
  },
  code({ className, children }) {
    const match = /language-(\w+)/.exec(className || '');
    const content = String(children).replace(/\n$/, '');
    if (match) {
      return (
        <>
          <div className="flex items-center justify-between px-3 py-1 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] rounded-t-lg">
            <span className="text-[0.5625rem] text-[var(--text-muted)] uppercase tracking-wider">{match[1]}</span>
          </div>
          <pre className="overflow-x-auto px-3 py-2 bg-[var(--bg-primary)] border border-t-0 border-[var(--border-color)] rounded-b-lg text-[0.8125rem] leading-relaxed">
            <code className={className}>{content}</code>
          </pre>
          <CopyBtn text={content} />
        </>
      );
    }
    // Inline code
    return (
      <code className="px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[0.8125rem] font-mono text-[var(--text-primary)]">
        {children}
      </code>
    );
  },
  // Tables
  table({ children }) {
    return (
      <div className="overflow-x-auto my-1.5">
        <table className="min-w-full text-[0.8125rem] border-collapse border border-[var(--border-color)]">
          {children}
        </table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="px-2 py-1 text-left border border-[var(--border-color)] bg-[var(--bg-secondary)] font-semibold text-[0.75rem]">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="px-2 py-1 border border-[var(--border-color)] text-[0.8125rem]">
        {children}
      </td>
    );
  },
  // Images — gated API URLs render through an authed blob fetch; everything
  // else (public /static/uploads, external) stays a plain <img>.
  img({ src, alt }) {
    const url = typeof src === 'string' ? src : '';
    const apiPath = apiPathOf(url);
    if (apiPath) return <AuthedChatImage path={apiPath} alt={alt ?? ''} />;
    if (!url) return null;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={alt ?? ''}
        className="max-w-full max-h-[420px] rounded-md border border-[var(--border-color)] my-1.5"
      />
    );
  },
  // Links — gated API URLs open via authed fetch → blob (a bare href would
  // land on {"detail":"Authentication required"}).
  a({ href, children }) {
    const apiPath = apiPathOf(href);
    if (apiPath) {
      return (
        <a
          href={href}
          onClick={(e) => { e.preventDefault(); void openAuthedLink(apiPath); }}
          className="text-[var(--primary-color)] hover:underline cursor-pointer"
        >
          {children}
        </a>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--primary-color)] hover:underline"
      >
        {children}
      </a>
    );
  },
  // Blockquotes
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-[var(--border-color)] pl-3 my-1.5 text-[var(--text-secondary)] italic">
        {children}
      </blockquote>
    );
  },
  // Lists
  ul({ children }) {
    return <ul className="list-disc list-inside my-1 space-y-0.5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal list-inside my-1 space-y-0.5">{children}</ol>;
  },
  // Horizontal rule
  hr() {
    return <hr className="my-2 border-[var(--border-color)]" />;
  },
  // Paragraphs — minimal spacing for chat
  p({ children }) {
    return <p className="my-1 leading-relaxed">{children}</p>;
  },
  // Headings — smaller in chat context
  h1({ children }) {
    return <h1 className="text-base font-bold mt-2 mb-1">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-[0.9375rem] font-bold mt-2 mb-1">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-[0.875rem] font-semibold mt-1.5 mb-0.5">{children}</h3>;
  },
};

// ── Inline emotion badge ──
function InlineEmotionBadge({ emotion }: { emotion: string }) {
  const color = EMOTION_COLORS[emotion] ?? '#8b949e';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: '0.6875rem',
        color,
        opacity: 0.75,
        marginRight: 4,
        verticalAlign: 'baseline',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
      />
      {emotion}
    </span>
  );
}

export interface ChatMarkdownProps {
  content: string;
  className?: string;
}

function ChatMarkdownInner({ content, className }: ChatMarkdownProps) {
  const segments = splitEmotionSegments(content);
  const hasInlineEmotions = segments.length > 1 || (segments.length === 1 && segments[0].emotion !== null);

  // Fast path: no inline emotion tags
  if (!hasInlineEmotions) {
    return (
      <div className={`chat-markdown text-[0.8125rem] text-[var(--text-primary)] leading-relaxed break-keep ${className || ''}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  // Segmented render: each emotion tag becomes an inline badge
  return (
    <div className={`chat-markdown text-[0.8125rem] text-[var(--text-primary)] leading-relaxed break-keep ${className || ''}`}>
      {segments.map((seg, i) => (
        <div key={i}>
          {seg.emotion && <InlineEmotionBadge emotion={seg.emotion} />}
          {seg.content.trim() && (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {seg.content.trim()}
            </ReactMarkdown>
          )}
        </div>
      ))}
    </div>
  );
}

const ChatMarkdown = memo(ChatMarkdownInner);
export default ChatMarkdown;
