/**
 * Provider + model catalog for the global model config editor.
 *
 * Provider taxonomy mirrors geny-executor's
 * `geny_executor.llm_client.registry.ClientRegistry` — the four
 * adapters that ship with the executor:
 *
 *   - anthropic  Claude family (default, hard dependency)
 *   - openai     GPT-4.1 family + reasoning models (o3 / o4-mini)
 *   - google     Gemini 3.x / 2.5
 *   - vllm       any model identifier served by a local vLLM endpoint;
 *                free-form because the deployed model is opaque to us.
 *
 * Catalog entries are sourced from the executor's own pricing table
 * (`stages/s07_token/artifact/default/pricing.py::ALL_PRICING`) so
 * every listed identifier is one the executor can both call and price.
 *
 * If a future executor release exposes an HTTP `/models` endpoint, swap
 * the static lists for an API call without changing the call sites —
 * the `MODEL_CATALOG` shape is the public contract here.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'vllm';

export interface ProviderInfo {
  id: ProviderId;
  /** Display label rendered in the provider selector. */
  label: string;
  /** When true, the model field is a free-form input rather than a
   *  strict dropdown — used for vLLM where the served model is
   *  user-controlled and arbitrary. */
  freeForm: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic', freeForm: false },
  { id: 'openai', label: 'OpenAI', freeForm: false },
  { id: 'google', label: 'Google', freeForm: false },
  { id: 'vllm', label: 'vLLM', freeForm: true },
];

export interface ModelOption {
  /** Exact identifier sent to the inference API. */
  id: string;
  /** Human-readable label rendered in the dropdown row. */
  label: string;
}

export const MODEL_CATALOG: Record<ProviderId, ModelOption[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
    { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1' },
    { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (May 2025)' },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4 (May 2025)' },
    { id: 'claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5' },
  ],
  openai: [
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
    { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
    { id: 'o3', label: 'o3' },
    { id: 'o4-mini', label: 'o4 Mini' },
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  ],
  google: [
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  ],
  vllm: [],
};

export const DEFAULT_PROVIDER: ProviderId = 'anthropic';
/** Recommended starting model — Anthropic Sonnet 4.6. */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Default model id for each provider — the catalog's first entry,
 *  or empty string for vLLM (user must enter it). */
export const PROVIDER_DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: DEFAULT_MODEL,
  openai: 'gpt-4.1',
  google: 'gemini-3.1-pro',
  vllm: '',
};

/** Look up provider metadata by id. Returns the canonical Anthropic
 *  entry if the id is unknown so callers don't have to null-check. */
export function getProviderInfo(id: string | null | undefined): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Mirrors executor's `_infer_api_artifact` so the UI can fall back to
 *  prefix-based provider detection when the s06_api stage hasn't yet
 *  pinned an explicit provider. */
export function inferProvider(model: string | null | undefined): ProviderId {
  const m = (model ?? '').toLowerCase();
  if (
    m.startsWith('gpt-') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4') ||
    m.startsWith('chatgpt')
  ) {
    return 'openai';
  }
  if (m.startsWith('gemini-')) return 'google';
  // claude-* and unknowns default to anthropic — same fallback the
  // executor uses for the legacy default APIStage.
  return 'anthropic';
}
