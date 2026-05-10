'use client';

import { useEffect, useRef } from 'react';
// pixi-spine-v7 ships its own Application + Spine bindings, but we import
// from the bare runtime; this app uses the pixi-live2d-display setup so
// pixi.js is already loaded as the v7 runtime alongside.
import { Application, Assets } from 'pixi.js';
import { Spine } from '@esotericsoftware/spine-pixi-v7';

// Per-mount alias counter so the same puppet can be loaded twice
// without colliding in the global Assets cache (e.g. user navigates
// session → switches model → comes back).
let _spineAliasSeq = 0;

const MIN_USER_ZOOM = 0.3;
const MAX_USER_ZOOM = 4;
const WHEEL_ZOOM_SPEED = 0.0015;
const DRAG_CLICK_THRESHOLD_PX = 4;

interface SpineCanvasProps {
  /** URL to the .skel (preferred) or .json skeleton file. */
  url: string;
  /** URL to the sibling .atlas file. Required by Spine — atlas defines
   *  the page texture mapping. */
  atlas: string;
  /** Display scale multiplier on top of the fit-to-canvas base scale.
   *  Mirrors Live2DCanvas's `kScale`. */
  kScale?: number;
  /** Animation name to play on load. When omitted, falls back to the
   *  first animation whose name matches /idle/i, then to animation 0. */
  animation?: string;
  className?: string;
  interactive?: boolean;
  background?: number;
  backgroundAlpha?: number;
}

/**
 * SpineCanvas — read-only Pixi v7 viewer for a baked Spine puppet.
 *
 * Phase D.2 of the geny-avatar integration. Mirrors the structural
 * shape of Live2DCanvas (mount Pixi app, fit-to-canvas, drag/zoom) but
 * stays deliberately small: load the skeleton, auto-play an idle, and
 * expose pan/zoom. Lipsync, expression blends, beat sync, and motion
 * pipelines are intentionally out of scope — those would need their
 * own Spine-side abstractions and are not blocking V1.
 */
export default function SpineCanvas({
  url,
  atlas,
  kScale = 0.7,
  animation,
  className = '',
  interactive = true,
  background = 0x000000,
  backgroundAlpha = 0,
}: SpineCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pixiAppRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spineRef = useRef<any>(null);
  const genRef = useRef(0);

  const baseScaleRef = useRef(1);
  const userZoomRef = useRef(1);
  const userPanRef = useRef({ x: 0, y: 0 });
  const applyTransformRef = useRef<() => void>(() => {});
  const dragRef = useRef({
    active: false,
    moved: false,
    pointerId: -1,
    startClientX: 0,
    startClientY: 0,
    startPanX: 0,
    startPanY: 0,
  });

  // ── Mount + load ─────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const myGen = ++genRef.current;
    let cancelled = false;

    (async () => {
      const app = new Application({
        width: container.clientWidth,
        height: container.clientHeight,
        backgroundColor: background,
        backgroundAlpha,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        antialias: true,
      });
      if (cancelled || myGen !== genRef.current) {
        app.destroy(true, { children: true });
        return;
      }
      container.appendChild(app.view as HTMLCanvasElement);
      pixiAppRef.current = app;

      // Spine.from() works on aliases registered with Pixi's Assets
      // cache, not raw URLs. Register the skeleton + atlas under unique
      // aliases (mount-scoped, so re-mounts don't trip cache hits with
      // stale parsed data) then await the load before constructing.
      const seq = ++_spineAliasSeq;
      const skelAlias = `spine-canvas:${seq}:skel`;
      const atlasAlias = `spine-canvas:${seq}:atlas`;
      try {
        Assets.add({ alias: skelAlias, src: url });
        Assets.add({ alias: atlasAlias, src: atlas });
        await Assets.load([skelAlias, atlasAlias]);
      } catch (e) {
        console.error('[SpineCanvas] Assets.load failed', e);
        return;
      }
      if (cancelled || myGen !== genRef.current) return;

      let spine: Spine;
      try {
        spine = Spine.from({ skeleton: skelAlias, atlas: atlasAlias });
      } catch (e) {
        console.error('[SpineCanvas] Spine.from threw', e);
        return;
      }
      if (cancelled || myGen !== genRef.current) {
        spine.destroy({ children: true });
        return;
      }
      spineRef.current = spine;
      app.stage.addChild(spine);

      // Fit-to-canvas baseline on top of the user-supplied kScale. The
      // spine display object exposes its own intrinsic bounds via the
      // skeleton.data; use them to compute a comfortable fill scale.
      const skelData = spine.skeleton.data;
      const bw = Math.max(1, Math.abs(skelData.width || 600));
      const bh = Math.max(1, Math.abs(skelData.height || 800));
      const scaleX = app.screen.width / bw;
      const scaleY = app.screen.height / bh;
      baseScaleRef.current = Math.min(scaleX, scaleY) * kScale;
      userZoomRef.current = 1;
      userPanRef.current = { x: 0, y: 0 };

      const applyTransform = () => {
        if (!spineRef.current || !pixiAppRef.current) return;
        const s = spineRef.current;
        const a = pixiAppRef.current;
        s.scale.set(baseScaleRef.current * userZoomRef.current);
        s.x = a.screen.width / 2 + userPanRef.current.x;
        s.y = a.screen.height / 2 + userPanRef.current.y;
      };
      applyTransform();
      applyTransformRef.current = applyTransform;

      // Pick + start an animation. Spine uses tracks (0 = main); set
      // with loop=true for an idle. The fallback chain matters because
      // not every puppet has a literal "idle" animation name.
      const animations = skelData.animations;
      let pick: { name: string } | undefined;
      if (animation) {
        pick = animations.find((a) => a.name === animation);
      }
      if (!pick) {
        pick = animations.find((a) => /idle/i.test(a.name));
      }
      if (!pick && animations.length > 0) {
        pick = animations[0];
      }
      if (pick) {
        spine.state.setAnimation(0, pick.name, true);
      } else {
        console.warn('[SpineCanvas] no animations found in skeleton');
      }
    })();

    // ── Cleanup ────────────────────────────────────────────────────
    return () => {
      cancelled = true;
      genRef.current++;
      const s = spineRef.current;
      const app = pixiAppRef.current;
      spineRef.current = null;
      pixiAppRef.current = null;
      try {
        if (s && !s.destroyed) s.destroy({ children: true });
      } catch (e) {
        console.warn('[SpineCanvas] spine destroy failed', e);
      }
      try {
        if (app) app.destroy(true, { children: true });
      } catch (e) {
        console.warn('[SpineCanvas] app destroy failed', e);
      }
    };
  }, [url, atlas, kScale, animation, background, backgroundAlpha]);

  // ── Resize handling — keep the puppet centered + refit base scale.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      const app = pixiAppRef.current;
      const spine = spineRef.current;
      if (!app || !spine) return;
      app.renderer.resize(container.clientWidth, container.clientHeight);
      const skelData = spine.skeleton.data;
      const bw = Math.max(1, Math.abs(skelData.width || 600));
      const bh = Math.max(1, Math.abs(skelData.height || 800));
      const scaleX = app.screen.width / bw;
      const scaleY = app.screen.height / bh;
      baseScaleRef.current = Math.min(scaleX, scaleY) * kScale;
      applyTransformRef.current();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [kScale]);

  // ── Pan / zoom — ported from Live2DCanvas, minus model offsets ────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !interactive) return;

    const toScreenCoords = (clientX: number, clientY: number) => {
      const rect = container.getBoundingClientRect();
      const app = pixiAppRef.current;
      if (!app || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
      const sx = app.screen.width / rect.width;
      const sy = app.screen.height / rect.height;
      return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
    };

    const onWheel = (e: WheelEvent) => {
      if (!spineRef.current || !pixiAppRef.current) return;
      e.preventDefault();
      const app = pixiAppRef.current;
      const oldZoom = userZoomRef.current;
      const newZoom = Math.max(
        MIN_USER_ZOOM,
        Math.min(MAX_USER_ZOOM, oldZoom * Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED)),
      );
      if (newZoom === oldZoom) return;
      const ratio = newZoom / oldZoom;
      const cursor = toScreenCoords(e.clientX, e.clientY);
      const baselineX = app.screen.width / 2;
      const baselineY = app.screen.height / 2;
      userPanRef.current = {
        x: userPanRef.current.x * ratio + (cursor.x - baselineX) * (1 - ratio),
        y: userPanRef.current.y * ratio + (cursor.y - baselineY) * (1 - ratio),
      };
      userZoomRef.current = newZoom;
      applyTransformRef.current();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (!spineRef.current) return;
      dragRef.current = {
        active: true,
        moved: false,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: userPanRef.current.x,
        startPanY: userPanRef.current.y,
      };
      try {
        container.setPointerCapture(e.pointerId);
      } catch {
        /* capture optional */
      }
      container.style.cursor = 'grabbing';
    };

    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d.active || e.pointerId !== d.pointerId) return;
      const dx = e.clientX - d.startClientX;
      const dy = e.clientY - d.startClientY;
      if (!d.moved && Math.hypot(dx, dy) > DRAG_CLICK_THRESHOLD_PX) d.moved = true;
      if (!d.moved) return;
      // Map client-space delta to screen-space (DPR / scale aware).
      const rect = container.getBoundingClientRect();
      const app = pixiAppRef.current;
      if (!app || rect.width === 0 || rect.height === 0) return;
      const sx = app.screen.width / rect.width;
      const sy = app.screen.height / rect.height;
      userPanRef.current = {
        x: d.startPanX + dx * sx,
        y: d.startPanY + dy * sy,
      };
      applyTransformRef.current();
    };

    const onPointerEnd = (e: PointerEvent) => {
      const d = dragRef.current;
      if (e.pointerId !== d.pointerId) return;
      d.active = false;
      try {
        container.releasePointerCapture(e.pointerId);
      } catch {
        /* release optional */
      }
      container.style.cursor = 'grab';
    };

    container.style.cursor = 'grab';
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerEnd);
    container.addEventListener('pointercancel', onPointerEnd);

    return () => {
      container.style.cursor = '';
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerEnd);
      container.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [interactive]);

  return <div ref={containerRef} className={`relative h-full w-full ${className}`} />;
}
