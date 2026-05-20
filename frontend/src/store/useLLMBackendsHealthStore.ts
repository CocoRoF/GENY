/**
 * useLLMBackendsHealthStore — singleton cache for the per-provider
 * health probe returned by ``GET /api/llm-backends/health``.
 *
 * Why a shared store: ``ModelConfigEditor`` is rendered up to three
 * times on the Environment editor page (global model panel + per-stage
 * overrides for stage 6 + stage 18). Each instance needs the same
 * health snapshot to decide which provider tabs to disable. A bare
 * ``useEffect(fetch)`` in the component triple-fetches the endpoint
 * every page open; a Zustand store dedupes the in-flight request and
 * fans the result out to every subscriber.
 *
 * Refresh hooks:
 *   - ``fetch()``    explicit refetch (modal save, "Refresh all" click)
 *   - The LLM Backends modals call ``markStale()`` on save so the next
 *     subscriber render reruns the fetch — keeps the editor's gate in
 *     sync with what the user just configured.
 */

import { create } from 'zustand';
import { llmBackendsApi, type ProviderHealth } from '@/lib/api';


interface State {
  providers: Record<string, ProviderHealth>;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Background refresh ticker — bumped whenever a provider config
   *  changes so subscribers can re-trigger ``fetch()``. */
  generation: number;

  fetch: (force?: boolean) => Promise<void>;
  markStale: () => void;
  isAvailable: (provider: string) => boolean;
}


let inflight: Promise<void> | null = null;


export const useLLMBackendsHealthStore = create<State>((set, get) => ({
  providers: {},
  loaded: false,
  loading: false,
  error: null,
  generation: 0,

  fetch: async (force = false) => {
    if (inflight) return inflight;
    if (!force && get().loaded) return;
    set({ loading: true, error: null });
    inflight = (async () => {
      try {
        const res = await llmBackendsApi.health();
        const map: Record<string, ProviderHealth> = {};
        for (const p of res.providers) map[p.provider] = p;
        set({ providers: map, loaded: true, loading: false });
      } catch (e) {
        set({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },

  markStale: () => set((s) => ({ loaded: false, generation: s.generation + 1 })),

  // ``available`` already encodes the executor-level usability:
  //   - API providers: api_key (or base_url for vLLM) set
  //   - CLI providers: binary on PATH + auth ok
  // The editor only ever needs the boolean, so wrap that here.
  isAvailable: (provider: string) => {
    const row = get().providers[provider];
    return row?.available === true;
  },
}));
