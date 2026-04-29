'use client';

/**
 * useEnvDefaults — Zustand store + hook for /api/env-defaults state.
 *
 * Keeps a single in-memory copy of all four category lists. Each
 * registry tab + Phase 5's seedDefaultToolLists pull from the same
 * cache; one POST returns the new list for a category and patches
 * the cache so every <EnvDefaultStarToggle /> on the page
 * re-renders without a manual GET.
 *
 * Failure semantics:
 *
 * - DB down (503) → `error` populated, lists stay at the last
 *   known state (or empty on first load). Toggles short-circuit
 *   without a network call so the UI doesn't appear to "succeed
 *   then revert" when the next reload pulls empty data again.
 *
 * - Network error (other 5xx, timeout) → same handling. Banner
 *   surfaces the message so the operator knows star toggles
 *   aren't being persisted.
 *
 * The store lives outside React's Suspense boundary intentionally
 * — tab switches are common and re-mounting the picker shouldn't
 * trigger a refetch every time. `loadOnce()` guards initial fetch.
 */

import { create } from 'zustand';
import {
  envDefaultsApi,
  type EnvDefaultsCategory,
  type EnvDefaultsResponse,
} from '@/lib/envDefaultsApi';

interface EnvDefaultsState {
  /** Per-category id lists. Empty list = uncurated (seeder uses wildcard). */
  data: EnvDefaultsResponse;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Item id currently being toggled — used for per-row pending UI. */
  pendingId: string | null;

  loadOnce: () => Promise<void>;
  reload: () => Promise<void>;
  isDefault: (category: EnvDefaultsCategory, itemId: string) => boolean;
  toggle: (
    category: EnvDefaultsCategory,
    itemId: string,
  ) => Promise<void>;
}

const EMPTY: EnvDefaultsResponse = {
  hooks: [],
  skills: [],
  permissions: [],
  mcp_servers: [],
};

export const useEnvDefaults = create<EnvDefaultsState>((set, get) => ({
  data: EMPTY,
  loaded: false,
  loading: false,
  error: null,
  pendingId: null,

  loadOnce: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true, error: null });
    try {
      const res = await envDefaultsApi.getAll();
      set({
        data: {
          hooks: res.hooks ?? [],
          skills: res.skills ?? [],
          permissions: res.permissions ?? [],
          mcp_servers: res.mcp_servers ?? [],
        },
        loaded: true,
        loading: false,
        error: null,
      });
    } catch (e) {
      set({
        loading: false,
        loaded: true, // mark loaded so subsequent loadOnce() doesn't loop
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  reload: async () => {
    set({ loading: true, error: null });
    try {
      const res = await envDefaultsApi.getAll();
      set({
        data: {
          hooks: res.hooks ?? [],
          skills: res.skills ?? [],
          permissions: res.permissions ?? [],
          mcp_servers: res.mcp_servers ?? [],
        },
        loaded: true,
        loading: false,
        error: null,
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  isDefault: (category, itemId) => {
    const list = get().data[category] ?? [];
    return list.includes(itemId);
  },

  toggle: async (category, itemId) => {
    if (get().error) return; // short-circuit if persistence is offline
    set({ pendingId: itemId });
    try {
      const res = await envDefaultsApi.toggle(category, itemId);
      set((state) => ({
        data: { ...state.data, [category]: res.ids },
        pendingId: null,
        error: null,
      }));
    } catch (e) {
      set({
        pendingId: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));
