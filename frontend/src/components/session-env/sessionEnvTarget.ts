'use client';

/**
 * sessionEnvTarget — which session's environment the session-scoped tabs
 * (Manifest / Tools / Workspace) should render.
 *
 * Defaults to the app's globally-selected session. For a VTuber session the
 * Environment view's [VTuber / Sub-Agent] toggle overrides this with the
 * linked Sub-Worker's id, so the same three sub-tabs can show either side of
 * the pair without disturbing the app-wide selection (sidebar / chat stay on
 * the VTuber).
 */

import { createContext, useContext } from 'react';
import { useAppStore } from '@/store/useAppStore';

/** Override session id for the session-env sub-tabs, or null = use the
 * globally-selected session. */
export const SessionEnvTargetContext = createContext<string | null>(null);

/** The session id whose environment the session-env sub-tabs should show:
 * the context override when present, else the app's selected session. */
export function useSessionEnvTargetId(): string | null {
  const override = useContext(SessionEnvTargetContext);
  const selected = useAppStore((s) => s.selectedSessionId);
  return override ?? selected;
}
