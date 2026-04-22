/**
 * useCreatureStateStore — central cache for per-session creature state
 * snapshots returned by `GET /api/agents/{id}` (the `creature_state`
 * field). Allows multiple consumers (InfoTab Status sub-tab, the
 * VTuberTab status badge hover panel, …) to share one fetch and
 * be re-hydrated together whenever a new chat turn lands.
 *
 * Refresh policy: callers invoke `fetch(sessionId)` whenever a
 * fresh snapshot is desired (e.g. after each chat message). The
 * store dedupes overlapping in-flight requests per session.
 */

import { create } from 'zustand';
import { agentApi } from '@/lib/api';
import type { CreatureStateSnapshot } from '@/types';

interface CreatureStateStore {
  states: Record<string, CreatureStateSnapshot | null>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  /** Force a refetch of the snapshot for the given session. */
  fetch: (sessionId: string) => Promise<void>;
  /** Push a snapshot already known to the caller (e.g. from a sibling fetch). */
  setSnapshot: (sessionId: string, snapshot: CreatureStateSnapshot | null) => void;
  /** Drop cache for a session. */
  clear: (sessionId: string) => void;
}

const inflight: Record<string, Promise<void> | undefined> = {};

export const useCreatureStateStore = create<CreatureStateStore>((set) => ({
  states: {},
  loading: {},
  error: {},

  fetch: async (sessionId: string) => {
    if (!sessionId) return;
    if (inflight[sessionId]) {
      return inflight[sessionId];
    }
    set((s) => ({
      loading: { ...s.loading, [sessionId]: true },
      error: { ...s.error, [sessionId]: null },
    }));
    const p = (async () => {
      try {
        let result: any;
        try {
          result = await agentApi.get(sessionId);
        } catch {
          result = await agentApi.getStore(sessionId);
        }
        const snapshot: CreatureStateSnapshot | null = result?.creature_state ?? null;
        set((s) => ({
          states: { ...s.states, [sessionId]: snapshot },
          loading: { ...s.loading, [sessionId]: false },
        }));
      } catch (e: any) {
        set((s) => ({
          loading: { ...s.loading, [sessionId]: false },
          error: { ...s.error, [sessionId]: e?.message ?? 'failed' },
        }));
      } finally {
        inflight[sessionId] = undefined;
      }
    })();
    inflight[sessionId] = p;
    return p;
  },

  setSnapshot: (sessionId, snapshot) =>
    set((s) => ({ states: { ...s.states, [sessionId]: snapshot } })),

  clear: (sessionId) =>
    set((s) => {
      const { [sessionId]: _omit, ...rest } = s.states;
      return { states: rest };
    }),
}));
