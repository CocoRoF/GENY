'use client';

/**
 * Tiny markdown-lite renderer for section-help content.
 *
 * Why not pull in a full markdown library? The content surface is
 * narrow: paragraphs, simple bullet lists, inline code, and bold.
 * That's it. A 60-line custom parser keeps the bundle small and
 * gives us total control over typography (line length, leading,
 * code-pill styling) without fighting library defaults.
 *
 * Supported syntax:
 *   - Blank line             → paragraph break
 *   - Lines starting with    → bullet list (consecutive lines fold
 *     "- "                     into one <ul>)
 *   - Inline `code`          → mono pill with subtle background
 *   - Inline **bold**        → semibold text
 *
 * Unsupported (intentional): headings, links, tables, images, code
 * blocks, blockquotes, italics. If we ever need those, we'll add
 * them — but right now keeping the surface tight forces content
 * authors to keep prose scannable instead of reaching for
 * structural escape hatches.
 */

import React from 'react';

interface InlineProps {
  text: string;
  className?: string;
}

/**
 * Render a single line of inline markup. Handles `code` and **bold**.
 * Plain text passes through unchanged.
 */
export function InlineMarkup({ text, className }: InlineProps) {
  const tokens = parseInline(text);
  return <span className={className}>{tokens}</span>;
}

interface ProseProps {
  text: string;
  /** Extra Tailwind on the outer flex column. */
  className?: string;
  /**
   * Optional max-width cap on `<p>` and `<ul>` blocks. Default is
   * empty — long-form prose fills its container's width so the
   * surrounding modal/panel padding sets the natural line length.
   * Pass e.g. `'max-w-[68ch]'` for sub-content where shorter lines
   * help scanability.
   */
  maxWidthClass?: string;
}

/**
 * Render a multi-paragraph block. Splits on blank lines, renders
 * paragraphs as <p> and consecutive `- ` lines as a single <ul>.
 */
export function Prose({
  text,
  className,
  maxWidthClass = '',
}: ProseProps) {
  const blocks = splitIntoBlocks(text);
  return (
    <div className={`flex flex-col gap-4 ${className ?? ''}`}>
      {blocks.map((b, i) => {
        if (b.type === 'list') {
          return (
            <ul
              key={i}
              className={`flex flex-col gap-1.5 ${maxWidthClass}`}
            >
              {b.items.map((item, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2.5 text-[0.9375rem] leading-7 text-[hsl(var(--foreground))]"
                >
                  <span className="text-[hsl(var(--muted-foreground))] mt-[0.25rem] shrink-0">
                    •
                  </span>
                  <InlineMarkup text={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p
            key={i}
            className={`text-[0.9375rem] leading-7 text-[hsl(var(--foreground))] ${maxWidthClass}`}
          >
            <InlineMarkup text={b.text} />
          </p>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] };

function splitIntoBlocks(text: string): Block[] {
  const out: Block[] = [];
  // Split on blank lines (one or more).
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+$/, ''))
    .filter((p) => p.trim().length > 0);

  for (const p of paragraphs) {
    const lines = p.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 0 && lines.every((l) => l.startsWith('- '))) {
      out.push({ type: 'list', items: lines.map((l) => l.slice(2).trim()) });
    } else {
      // Collapse single newlines inside a paragraph to spaces (markdown
      // convention). Authors get blank lines for paragraph breaks.
      out.push({ type: 'paragraph', text: lines.join(' ') });
    }
  }
  return out;
}

/**
 * Tokenize a single line on `code` and **bold** spans. Plain text
 * goes through as a string node; matched spans become <code> or
 * <strong> elements. Order-preserving.
 */
function parseInline(text: string): React.ReactNode[] {
  // Match either `code` or **bold**. Greedy within delimiters; a
  // single regex handles both. Both must be on the same line —
  // multi-line code spans aren't supported and shouldn't appear in
  // the kind of content we're rendering.
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    const token = m[0];
    if (token.startsWith('**')) {
      out.push(
        <strong
          key={`b-${key++}`}
          className="font-semibold text-[hsl(var(--foreground))]"
        >
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(
        <code
          key={`c-${key++}`}
          className="font-mono text-[0.875em] text-[hsl(var(--foreground))] bg-[hsl(var(--accent))] border border-[hsl(var(--border))] px-1.5 py-[0.0625rem] rounded"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}
