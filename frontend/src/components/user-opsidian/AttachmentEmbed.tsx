/**
 * AttachmentEmbed — render `![[file.ext]]` style wikilinks to actual
 * media (image / video / audio / file download).
 *
 * The component itself is a small dispatch table keyed off the file
 * extension. New types (e.g. `.excalidraw.json` in a future drawing
 * phase) slot in by adding one entry to ATTACHMENT_RENDERERS — the
 * surrounding pipeline does not change.  This is the extension hook
 * promised in docs §11.2.
 */

'use client';

import React, { useMemo } from 'react';
import {
  defaultUrlTransform,
  type Components,
  type UrlTransform,
} from 'react-markdown';
import { whiteboardApi } from '@/lib/api';
import { getToken } from '@/lib/authApi';

/** Authenticated download: sends the Bearer token (a plain <a download>
 *  can only send the cookie, which expires before the token), streams to
 *  a blob, and saves under ``filename``. */
async function authedDownload(url: string, filename: string): Promise<void> {
  const token = getToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export type AttachmentRenderer = (props: {
  url: string;
  filename: string;
  alt?: string | null;
}) => React.ReactNode;

const renderImage: AttachmentRenderer = ({ url, alt, filename }) => (
  <img
    src={url}
    alt={alt ?? filename}
    style={{
      maxWidth: '100%',
      maxHeight: 480,
      borderRadius: 8,
      border: '1px solid var(--obs-border, #2c2c2e)',
      display: 'block',
      margin: '8px 0',
    }}
    loading="lazy"
  />
);

const renderAudio: AttachmentRenderer = ({ url }) => (
  <audio src={url} controls style={{ width: '100%', margin: '8px 0' }} />
);

const renderVideo: AttachmentRenderer = ({ url }) => (
  <video
    src={url}
    controls
    style={{ maxWidth: '100%', maxHeight: 480, borderRadius: 8, margin: '8px 0' }}
  />
);

const renderDownload: AttachmentRenderer = ({ url, filename }) => (
  <button
    type="button"
    onClick={() => {
      void authedDownload(url, filename).catch(() => {
        /* download failed — surfaced by the browser's own error */
      });
    }}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px',
      borderRadius: 6,
      background: 'var(--obs-bg-secondary, rgba(255,255,255,0.04))',
      border: '1px solid var(--obs-border, #2c2c2e)',
      color: 'var(--obs-text, #d1d1d6)',
      cursor: 'pointer',
      fontSize: 13,
    }}
  >
    📎 {filename}
  </button>
);

/**
 * Renderer registry — extension hook (docs §11.2).
 *
 * Keys are lowercased extensions (no leading dot). The first matching
 * renderer is used; falls back to {@link renderDownload} for unknown
 * extensions so attachments are never silently dropped.
 */
export const ATTACHMENT_RENDERERS: Record<string, AttachmentRenderer> = {
  png: renderImage,
  jpg: renderImage,
  jpeg: renderImage,
  webp: renderImage,
  gif: renderImage,
  svg: renderImage,
  mp4: renderVideo,
  webm: renderAudio, // most browser-recorded audio lands as .webm
  mp3: renderAudio,
  ogg: renderAudio,
  m4a: renderAudio,
  // Future P3+ slots — add here without touching pipeline:
  //   'excalidraw.json': renderDrawing,
};

export function registerAttachmentRenderer(extension: string, renderer: AttachmentRenderer): void {
  ATTACHMENT_RENDERERS[extension.toLowerCase().replace(/^\./, '')] = renderer;
}

function pickRenderer(filename: string): AttachmentRenderer {
  const lower = filename.toLowerCase();
  // Multi-segment extensions like ".excalidraw.json" — try longest first.
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('.');
    if (ATTACHMENT_RENDERERS[candidate]) return ATTACHMENT_RENDERERS[candidate];
  }
  return renderDownload;
}

export interface AttachmentEmbedProps {
  /** Path relative to vault root (e.g. ``_attachments/foo.png``) or just leaf name. */
  path: string;
  alt?: string | null;
  /**
   * Vault-specific URL resolver. Defaults to the user-opsidian
   * (whiteboard) attachments endpoint; session-scoped views pass their
   * own resolver (e.g. ``memoryApi.attachmentUrl(sessionId, path)``)
   * because observation frames live in the agent session's storage.
   */
  resolveUrl?: (path: string) => string;
}

export default function AttachmentEmbed({ path, alt, resolveUrl }: AttachmentEmbedProps) {
  const url = useMemo(
    () => (resolveUrl ?? whiteboardApi.attachmentUrl)(path),
    [path, resolveUrl],
  );
  const filename = path.replace(/^.*\//, '');
  const renderer = pickRenderer(filename);
  return <>{renderer({ url, filename, alt })}</>;
}

/**
 * Pre-process a markdown body: rewrite Obsidian-style `![[file.ext]]`
 * embeds into a magic image syntax that ReactMarkdown can pass to a
 * custom `img` component.
 *
 * The encoded marker `attachment://<path>` is recognised by
 * `attachmentMarkdownComponents` below and turned back into an
 * `AttachmentEmbed`.
 */
export function preprocessAttachmentEmbeds(body: string): string {
  return body.replace(
    /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, alias?: string) => {
      const cleaned = target.trim();
      const display = (alias ?? cleaned).trim();
      const encoded = encodeURIComponent(cleaned);
      return `![${display}](attachment://${encoded})`;
    },
  );
}

/**
 * `urlTransform` for ReactMarkdown that lets our `attachment://`
 * scheme survive the default sanitiser.
 *
 * react-markdown's default rejects any unknown protocol (replacing
 * the URL with `""`), which is why a plain `<ReactMarkdown>` would
 * render `<img src="">` for our attachment embeds. Whitelist the
 * one protocol we own and delegate everything else to the default.
 */
export const attachmentUrlTransform: UrlTransform = (url) => {
  if (typeof url === 'string' && url.startsWith('attachment://')) return url;
  return defaultUrlTransform(url);
};

/**
 * Convenience: a `components` partial for ReactMarkdown that detects
 * the `attachment://` marker emitted by {@link preprocessAttachmentEmbeds}
 * and renders an {@link AttachmentEmbed}.  Spread alongside any other
 * custom components.
 *
 * Typed with the exact `Components['img']` callback shape from
 * react-markdown so the host's `<ReactMarkdown components={...}>`
 * accepts it without an unsafe cast. Note that ReactMarkdown widens
 * `src` to `string | Blob | undefined`, so we narrow defensively
 * before using it.
 */
export function makeAttachmentMarkdownComponents(
  resolveUrl?: (path: string) => string,
): Pick<Components, 'img'> {
  return {
    img: ({ src, alt }) => {
      const safeSrc =
        typeof src === 'string' && src.length > 0 ? src : undefined;
      const safeAlt = typeof alt === 'string' ? alt : undefined;
      if (safeSrc && safeSrc.startsWith('attachment://')) {
        const path = decodeURIComponent(safeSrc.replace('attachment://', ''));
        return (
          <AttachmentEmbed path={path} alt={safeAlt ?? null} resolveUrl={resolveUrl} />
        );
      }
      // Plain markdown image — fall through to a sane default.
      return (
        <img
          src={safeSrc}
          alt={safeAlt}
          style={{ maxWidth: '100%', borderRadius: 6 }}
        />
      );
    },
  };
}

export const attachmentMarkdownComponents: Pick<Components, 'img'> =
  makeAttachmentMarkdownComponents();
