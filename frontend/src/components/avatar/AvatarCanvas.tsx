'use client';

import dynamic from 'next/dynamic';
import { useVTuberStore } from '@/store/useVTuberStore';
import Live2DCanvas from '@/components/live2d/Live2DCanvas';
import SpineCanvas from '@/components/avatar/SpineCanvas';
import type { Live2DEnhancedConfig } from '@/lib/live2d';

// babylon-mmd + @babylonjs/core weigh ~4MB — load them only when a
// session actually assigns an MMD model. ssr:false because the module
// touches WebGL/canvas at import-evaluation depth.
const MmdCanvas = dynamic(() => import('@/components/avatar/MmdCanvas'), { ssr: false });

interface AvatarCanvasProps {
  sessionId: string;
  className?: string;
  interactive?: boolean;
  background?: number;
  backgroundAlpha?: number;
  /** Live2D-only — passed straight through to Live2DCanvas. Spine
   *  ignores it (its enhancement system is structurally different
   *  and not in V1 scope). */
  enhancedConfig?: Partial<Live2DEnhancedConfig>;
  /** Live2D-only — persist/restore user pan+zoom under this key (per session). */
  viewStorageKey?: string;
}

/**
 * AvatarCanvas — runtime-aware dispatcher between Live2D and Spine
 * viewers. The session's currently-assigned model carries a `runtime`
 * tag (`'live2d' | 'spine'` since Phase C.1); we look it up via
 * useVTuberStore and route to the appropriate canvas component.
 *
 * Falls back to Live2DCanvas when:
 *   - no model is assigned yet (initial load, before user picks one)
 *   - model.runtime is undefined (pre-v2 registry, treat as Live2D)
 *
 * Spine entries that lack `atlas_url` render a small inline error —
 * Geny's import flow (Phase C.3) requires the atlas to be present in
 * the zip, so a missing one means manual registry tampering.
 */
export default function AvatarCanvas(props: AvatarCanvasProps) {
  const model = useVTuberStore((s) => s.getModelForSession(props.sessionId));
  const runtime = model?.runtime ?? 'live2d';

  if (runtime === 'mmd') {
    if (!model) {
      return (
        <div
          className={`flex h-full w-full items-center justify-center text-xs text-zinc-500 ${
            props.className ?? ''
          }`}
        >
          loading model…
        </div>
      );
    }
    return (
      <MmdCanvas
        sessionId={props.sessionId}
        model={model}
        className={props.className}
        interactive={props.interactive}
        background={props.background}
        backgroundAlpha={props.backgroundAlpha}
      />
    );
  }

  if (runtime === 'spine') {
    if (!model) {
      // Defensive — Live2DCanvas handles "no assigned model" gracefully
      // by showing a blank canvas, but for Spine we'd hit the loader
      // before the store hydrates. Surface a clear placeholder.
      return (
        <div
          className={`flex h-full w-full items-center justify-center text-xs text-zinc-500 ${
            props.className ?? ''
          }`}
        >
          loading model…
        </div>
      );
    }
    if (!model.atlas_url) {
      return (
        <div
          className={`flex h-full w-full items-center justify-center text-xs text-red-500 ${
            props.className ?? ''
          }`}
        >
          Spine model missing atlas_url — registry entry incomplete
        </div>
      );
    }
    return (
      <SpineCanvas
        url={model.url}
        atlas={model.atlas_url}
        kScale={model.kScale}
        className={props.className}
        interactive={props.interactive}
        background={props.background}
        backgroundAlpha={props.backgroundAlpha}
      />
    );
  }

  // runtime === 'live2d' — original codepath, untouched.
  return (
    <Live2DCanvas
      sessionId={props.sessionId}
      className={props.className}
      interactive={props.interactive}
      background={props.background}
      backgroundAlpha={props.backgroundAlpha}
      enhancedConfig={props.enhancedConfig}
      viewStorageKey={props.viewStorageKey}
    />
  );
}
