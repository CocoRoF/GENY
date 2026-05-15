/**
 * useMultiSelection — keyboard-aware multi-select for list/grid UIs.
 *
 * Supports the standard Finder / Explorer / Obsidian conventions:
 *
 *   • Plain click            → replace selection with the clicked item.
 *   • Ctrl/Cmd + click       → toggle the clicked item in/out of the set.
 *   • Shift + click          → range-select from the anchor to the
 *                              clicked item (anchor = last plain or
 *                              ctrl-click). Replaces selection.
 *   • Ctrl/Cmd + Shift + click → range-select but ADD to existing
 *                              selection instead of replacing.
 *   • Escape                 → clear selection (when listenForEscape).
 *   • Ctrl/Cmd + A           → select every visible id (when
 *                              listenForSelectAll).
 *
 * The hook is item-list aware (the order matters for range select)
 * but doesn't render anything — caller wires ``handleItemClick`` to
 * each row's onClick and reads ``isSelected(id)`` / ``selectedIds``
 * for styling.
 *
 * Stale-id pruning is automatic via a render-time memo: if an id
 * disappears from the source list (note deleted from another tab,
 * filter narrowed the visible set) the exposed ``selectedIds`` no
 * longer contains it. The internal "raw" set is kept as-is so a
 * subsequent re-add of the id (filter widened) restores it.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface UseMultiSelectionOptions {
  /** Ordered ids — needed to compute Shift+click ranges. */
  ids: readonly string[];
  /** Clear selection when Escape is pressed anywhere in the document.
   *  Default true. */
  listenForEscape?: boolean;
  /** Capture Ctrl/Cmd+A to select every id (when the target isn't
   *  an editable element). Default true. */
  listenForSelectAll?: boolean;
  /** Called whenever the user-driven selection changes — useful for
   *  keeping the rest of the UI (header counter / bulk-delete button)
   *  in sync. Not fired on auto-prune. */
  onChange?: (selected: ReadonlySet<string>) => void;
}

export interface UseMultiSelectionResult {
  selectedIds: ReadonlySet<string>;
  isSelected: (id: string) => boolean;
  /** Use as ``onClick={e => handleItemClick(e, id)}`` on each row. */
  handleItemClick: (event: React.MouseEvent, id: string) => void;
  /** Programmatic helpers. */
  toggle: (id: string) => void;
  select: (ids: Iterable<string>) => void;
  add: (ids: Iterable<string>) => void;
  remove: (ids: Iterable<string>) => void;
  clear: () => void;
  selectAll: () => void;
  setAnchor: (id: string | null) => void;
  /** True iff the most recent click event signalled "open this row"
   *  intent (plain click, no modifier). The caller can use this in
   *  the click handler to decide whether to also open the item. */
  isOpenIntent: (event: React.MouseEvent) => boolean;
  /** Snapshot of all known ids (the ``ids`` prop), exposed for the
   *  bulk-action UI ("Delete 12 of 47"). */
  totalCount: number;
}

function _modKey(event: React.MouseEvent | KeyboardEvent): boolean {
  // ``metaKey`` covers macOS Cmd; ``ctrlKey`` covers Linux/Windows
  // and the Windows-keyboard-on-mac case.
  return event.ctrlKey || event.metaKey;
}


export function useMultiSelection(
  options: UseMultiSelectionOptions,
): UseMultiSelectionResult {
  const {
    ids,
    listenForEscape = true,
    listenForSelectAll = true,
    onChange,
  } = options;

  // Raw selection — what the user has asked for. Some of these ids
  // may no longer exist in the source list (a sibling tab deleted a
  // note, a filter shrunk the visible set); the exposed set drops
  // those via the memo below.
  const [raw, setRaw] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);

  // Stable ``onChange`` reference so user-action callbacks don't
  // capture a stale closure.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const select = useCallback((newIds: Iterable<string>) => {
    const next = new Set<string>();
    for (const id of newIds) next.add(id);
    setRaw(next);
    onChangeRef.current?.(next);
  }, []);

  const add = useCallback((newIds: Iterable<string>) => {
    setRaw((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      onChangeRef.current?.(next);
      return next;
    });
  }, []);

  const remove = useCallback((rmIds: Iterable<string>) => {
    setRaw((prev) => {
      const next = new Set(prev);
      for (const id of rmIds) next.delete(id);
      onChangeRef.current?.(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setRaw((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      onChangeRef.current?.(next);
      return next;
    });
    anchorRef.current = null;
  }, []);

  const toggle = useCallback((id: string) => {
    setRaw((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChangeRef.current?.(next);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    const next = new Set<string>(ids);
    setRaw(next);
    onChangeRef.current?.(next);
    anchorRef.current = ids[0] ?? null;
  }, [ids]);

  const setAnchor = useCallback((id: string | null) => {
    anchorRef.current = id;
  }, []);

  const handleItemClick = useCallback(
    (event: React.MouseEvent, id: string) => {
      const mod = _modKey(event);
      const shift = event.shiftKey;

      if (shift && anchorRef.current) {
        // Range select from anchor to id.
        const start = ids.indexOf(anchorRef.current);
        const end = ids.indexOf(id);
        if (start === -1 || end === -1) {
          // Anchor disappeared (e.g. previous item was deleted) — fall
          // through to plain selection of the clicked id.
          const next = new Set([id]);
          setRaw(next);
          onChangeRef.current?.(next);
          anchorRef.current = id;
          return;
        }
        const [lo, hi] = start < end ? [start, end] : [end, start];
        const range = ids.slice(lo, hi + 1);
        if (mod) {
          setRaw((prev) => {
            const next = new Set(prev);
            for (const r of range) next.add(r);
            onChangeRef.current?.(next);
            return next;
          });
        } else {
          const next = new Set(range);
          setRaw(next);
          onChangeRef.current?.(next);
        }
        // Anchor stays put — successive Shift+clicks should keep
        // pivoting around the same anchor (Finder/Explorer convention).
        return;
      }

      if (mod) {
        toggle(id);
        anchorRef.current = id;
        return;
      }

      // Plain click → replace selection. The caller can still
      // detect this with ``isOpenIntent`` to decide whether to also
      // open the row.
      const next = new Set([id]);
      setRaw(next);
      onChangeRef.current?.(next);
      anchorRef.current = id;
    },
    [ids, toggle],
  );

  const isOpenIntent = useCallback((event: React.MouseEvent) => {
    return !event.shiftKey && !event.ctrlKey && !event.metaKey;
  }, []);

  // ── Visible selection — auto-prune via render-time memo ─────────
  // Anything in ``raw`` that isn't in the current ``ids`` is hidden
  // from the consumer. We don't mutate ``raw`` here on purpose: if
  // an id reappears (filter widened, tab refresh) the consumer
  // immediately sees it selected again.
  const selectedIds = useMemo<ReadonlySet<string>>(() => {
    if (raw.size === 0) return raw;
    const valid = new Set(ids);
    const next = new Set<string>();
    for (const id of raw) if (valid.has(id)) next.add(id);
    return next.size === raw.size ? raw : next;
  }, [raw, ids]);

  // ── Global key listeners ─────────────────────────────────────────
  useEffect(() => {
    if (!listenForEscape && !listenForSelectAll) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't steal keys from inputs / textareas / contenteditable.
      const tag = target?.tagName?.toLowerCase();
      const editing =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (target as HTMLElement | null)?.isContentEditable;
      if (editing) return;

      if (listenForEscape && e.key === 'Escape') {
        clear();
      } else if (
        listenForSelectAll &&
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'a' &&
        !e.shiftKey
      ) {
        if (ids.length === 0) return;
        e.preventDefault();
        selectAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listenForEscape, listenForSelectAll, clear, selectAll, ids.length]);

  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  return useMemo<UseMultiSelectionResult>(
    () => ({
      selectedIds,
      isSelected,
      handleItemClick,
      toggle,
      select,
      add,
      remove,
      clear,
      selectAll,
      setAnchor,
      isOpenIntent,
      totalCount: ids.length,
    }),
    [
      selectedIds, isSelected, handleItemClick, toggle, select, add, remove,
      clear, selectAll, setAnchor, isOpenIntent, ids.length,
    ],
  );
}
