'use client';

/**
 * SelectionActionMenu — select text in a chat, right-click, act on it.
 *
 * Attach to any scrollable message container via `containerRef`. When the
 * user right-clicks with a non-empty selection inside that container, the
 * native context menu is replaced by a compact action popup:
 *
 *   · Ask Geny        — sends the selection to the agent (onAskGeny)
 *   · Search in browser — opens the system default browser's search
 *     (window.open; the desktop connector routes it through
 *     shell.openExternal via setWindowOpenHandler, so it lands in the
 *     user's real browser as a new tab)
 *   · Copy            — clipboard
 *
 * Right-click WITHOUT a selection falls through to the native menu.
 * Renders via portal; theme-aware through the app CSS variables; closes on
 * outside click / Escape / scroll / resize.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';

const QUERY_MAX = 500; // sanity cap for search queries / agent asks
const QUOTE_MAX = 48; // header preview length

interface Props {
  /** The chat message container to arm (listener attaches to it). */
  containerRef: RefObject<HTMLElement | null>;
  /** Send the selection to the agent. Omit to hide the "Ask Geny" item. */
  onAskGeny?: (text: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  text: string;
}

const MENU_W = 232; // used for viewport clamping
const MENU_H_EST = 148;

export default function SelectionActionMenu({ containerRef, onAskGeny }: Props) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const onAskGenyRef = useRef(onAskGeny);
  onAskGenyRef.current = onAskGeny;

  // Arm the container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onContextMenu = (e: MouseEvent) => {
      const sel = window.getSelection();
      const text = (sel?.toString() ?? '').trim();
      if (!text) return; // no selection → native menu
      // Only when the selection actually lives inside this container.
      const anchor = sel?.anchorNode;
      if (!anchor || !el.contains(anchor)) return;
      e.preventDefault();
      e.stopPropagation();
      const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
      const y = Math.min(e.clientY, window.innerHeight - MENU_H_EST - 8);
      setCopied(false);
      setMenu({ x: Math.max(8, x), y: Math.max(8, y), text: text.slice(0, QUERY_MAX) });
    };
    el.addEventListener('contextmenu', onContextMenu);
    return () => el.removeEventListener('contextmenu', onContextMenu);
  }, [containerRef]);

  const close = useCallback(() => setMenu(null), []);

  // Dismissal: outside click, Escape, scroll, resize.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu, close]);

  if (!menu) return null;

  const askGeny = () => {
    close();
    onAskGenyRef.current?.(menu.text);
  };
  const searchBrowser = () => {
    close();
    // Default browser search; the connector's window-open handler forwards
    // this to shell.openExternal, so it opens a real browser tab there too.
    window.open(
      `https://www.google.com/search?q=${encodeURIComponent(menu.text)}`,
      '_blank',
      'noopener,noreferrer',
    );
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(menu.text);
      setCopied(true);
      setTimeout(close, 550);
    } catch {
      close();
    }
  };

  const quote = menu.text.length > QUOTE_MAX ? `${menu.text.slice(0, QUOTE_MAX)}…` : menu.text;

  const item =
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-left ' +
    'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer ' +
    'bg-transparent border-none';

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-1.5 shadow-2xl backdrop-blur-sm animate-[selmenu-in_120ms_ease-out]"
      style={{ left: menu.x, top: menu.y, width: MENU_W }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <style>{`@keyframes selmenu-in { from { opacity: 0; transform: scale(.96) translateY(-2px); } to { opacity: 1; transform: none; } }`}</style>
      <div
        className="px-3 pt-1.5 pb-2 text-[11px] leading-snug text-[var(--text-muted)] border-b border-[var(--border-color)] mb-1 break-all"
        title={menu.text}
      >
        “{quote}”
      </div>
      {onAskGeny && (
        <button role="menuitem" className={item} onClick={askGeny}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--primary-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
            <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
          </svg>
          {t('selectionMenu.askGeny')}
        </button>
      )}
      <button role="menuitem" className={item} onClick={searchBrowser}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        {t('selectionMenu.searchBrowser')}
      </button>
      <button role="menuitem" className={item} onClick={copy}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
        {copied ? t('selectionMenu.copied') : t('selectionMenu.copy')}
      </button>
    </div>,
    document.body,
  );
}
