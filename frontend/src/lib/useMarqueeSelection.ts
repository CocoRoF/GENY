/**
 * useMarqueeSelection — rubber-band selection for a scrollable grid.
 *
 * Returns props to spread on the *container* (the scrolling area
 * around the items) and a per-item ``register(id, element)`` callback
 * so the hook knows where each item lives on screen.
 *
 * Interaction model:
 *
 *   • Mousedown on empty container area → start tracking; record the
 *     anchor point and (if Ctrl/Cmd is not held) clear the existing
 *     selection.
 *   • Mousemove → repaint the rectangle and recompute
 *     ``itemsInRectangle`` from each registered element's
 *     ``getBoundingClientRect``.
 *   • Mouseup → either ADD (mod held) or REPLACE (no mod) the
 *     working set into the parent's selection via ``onCommit``.
 *
 * Why not snapshot the rects upfront? They depend on scroll position
 * and dynamic content (transcripts streaming in mid-drag would shift
 * cards). Reading rects on every mousemove is O(N) but cheap — a
 * thousand cards on a modern laptop is well under one frame.
 */

'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface UseMarqueeSelectionOptions {
  /** Commit a rectangle selection. ``mode`` reflects whether the
   *  drag started with Ctrl/Cmd held. */
  onCommit: (ids: Set<string>, mode: 'replace' | 'add') => void;
  /** Optional: called once when the drag starts. The parent can
   *  clear an existing selection on plain-drag here, or do nothing
   *  if it wants the marquee to extend instead of replace. */
  onStart?: (mode: 'replace' | 'add') => void;
  /** Minimum drag distance (px) before we treat a gesture as a
   *  marquee instead of a click. Default 4 px. */
  minDistance?: number;
  /** Only start a marquee when the mousedown landed on an element
   *  matching this CSS selector. Defaults to the container itself
   *  + any descendant with ``data-marquee-empty``. */
  emptyArea?: (target: EventTarget | null, container: HTMLElement) => boolean;
}

export interface UseMarqueeSelectionResult {
  /** Spread on the container element. */
  containerProps: {
    ref: (el: HTMLElement | null) => void;
    onMouseDown: (event: React.MouseEvent) => void;
    style: CSSProperties;
  };
  /** Per-item registrar — pass a function-ref:
   *  ``<div ref={el => register(item.id, el)}>`` */
  register: (id: string, element: HTMLElement | null) => void;
  /** Current rectangle in container-local coordinates (for an
   *  overlay div). null when not dragging. */
  rect: MarqueeRect | null;
  /** Ids the rectangle currently intersects. Empty when not
   *  dragging. */
  draftIds: ReadonlySet<string>;
  /** True while the user is actively dragging. */
  isDragging: boolean;
}


function _defaultEmptyArea(
  target: EventTarget | null, container: HTMLElement,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target === container) return true;
  // Honour explicit opt-in: anything tagged ``data-marquee-empty``
  // counts as empty space (the grid wrapper between cards, etc.).
  if (target.closest('[data-marquee-empty]')) return true;
  // Anything inside a card / button / interactive control is NOT
  // empty space.
  if (target.closest('[data-marquee-item], button, a, input, textarea')) {
    return false;
  }
  return false;
}


function _intersects(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top
  );
}


export function useMarqueeSelection(
  options: UseMarqueeSelectionOptions,
): UseMarqueeSelectionResult {
  const { onCommit, onStart, minDistance = 4, emptyArea } = options;

  const containerRef = useRef<HTMLElement | null>(null);
  const itemsRef = useRef<Map<string, HTMLElement>>(new Map());

  const [rect, setRect] = useState<MarqueeRect | null>(null);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);

  // Drag state held in a ref so the global mousemove/up handlers
  // see the freshest values without re-binding on every move.
  const dragStateRef = useRef<{
    anchorX: number;
    anchorY: number;
    mode: 'replace' | 'add';
    started: boolean;
  } | null>(null);

  const setRef = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
  }, []);

  const register = useCallback(
    (id: string, element: HTMLElement | null) => {
      if (element) {
        itemsRef.current.set(id, element);
      } else {
        itemsRef.current.delete(id);
      }
    },
    [],
  );

  const computeDraft = useCallback(
    (clientRect: DOMRect): Set<string> => {
      const next = new Set<string>();
      for (const [id, el] of itemsRef.current.entries()) {
        if (!el.isConnected) {
          itemsRef.current.delete(id);
          continue;
        }
        if (_intersects(el.getBoundingClientRect(), clientRect)) {
          next.add(id);
        }
      }
      return next;
    },
    [],
  );

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      const tester = emptyArea ?? _defaultEmptyArea;
      if (!tester(event.target, container)) return;

      const mode: 'replace' | 'add' =
        event.ctrlKey || event.metaKey ? 'add' : 'replace';
      dragStateRef.current = {
        anchorX: event.clientX,
        anchorY: event.clientY,
        mode,
        started: false,
      };
      // Don't fire ``onStart`` yet — wait until we cross the
      // minDistance threshold so a plain click on empty area doesn't
      // also blow away the selection.
      event.preventDefault();
    },
    [emptyArea],
  );

  // ── Global listeners (mousemove / mouseup) ───────────────────────
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const state = dragStateRef.current;
      const container = containerRef.current;
      if (!state || !container) return;
      const dx = e.clientX - state.anchorX;
      const dy = e.clientY - state.anchorY;
      if (!state.started) {
        if (Math.abs(dx) < minDistance && Math.abs(dy) < minDistance) {
          return;
        }
        state.started = true;
        setIsDragging(true);
        onStart?.(state.mode);
      }

      // Build a client-space rectangle from anchor → current.
      const clientLeft = Math.min(state.anchorX, e.clientX);
      const clientTop = Math.min(state.anchorY, e.clientY);
      const clientRight = Math.max(state.anchorX, e.clientX);
      const clientBottom = Math.max(state.anchorY, e.clientY);
      const clientRect = new DOMRect(
        clientLeft,
        clientTop,
        clientRight - clientLeft,
        clientBottom - clientTop,
      );

      // Translate into container-local coordinates so the overlay
      // div can position itself with simple top/left.
      const containerRect = container.getBoundingClientRect();
      setRect({
        left: clientLeft - containerRect.left,
        top: clientTop - containerRect.top,
        width: clientRight - clientLeft,
        height: clientBottom - clientTop,
      });

      setDraftIds(computeDraft(clientRect));
    };

    const handleUp = () => {
      const state = dragStateRef.current;
      dragStateRef.current = null;
      if (!state) return;
      if (state.started) {
        // Commit the draft. computeDraft has already populated it on
        // the latest mousemove; snapshot via setDraftIds(current) is
        // racy under React 18 strict mode, so re-read via the
        // closure variable.
        setDraftIds((current) => {
          onCommit(new Set(current), state.mode);
          return new Set();
        });
      }
      setIsDragging(false);
      setRect(null);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [computeDraft, minDistance, onCommit, onStart]);

  const containerProps = useMemo(
    () => ({
      ref: setRef,
      onMouseDown,
      // ``position: relative`` so the overlay div positioned with
      // absolute top/left snaps to the container, not the page.
      style: {
        position: 'relative' as const,
        // ``user-select: none`` while dragging so the browser doesn't
        // try to select text under the rectangle.
        userSelect: isDragging ? ('none' as const) : ('auto' as const),
      },
    }),
    [setRef, onMouseDown, isDragging],
  );

  return {
    containerProps,
    register,
    rect,
    draftIds,
    isDragging,
  };
}
