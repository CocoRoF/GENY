/**
 * Model catalog — curated list of model identifiers exposed as
 * dropdown suggestions in the Globals → Model config editor.
 *
 * The list is non-exhaustive on purpose: the manifest field is
 * free-form (a user can point `base_url` at a custom inference
 * endpoint and pass any model id), so the editor renders a
 * <datalist> behind the input rather than a strict <select>.
 *
 * Catalog source:
 *   - Anthropic Claude family — sourced from the public model
 *     identifiers as of the assistant's knowledge cutoff.
 *   - Pricing-keyed entries from geny-executor's CostAnalyzer
 *     (`history/cost.py::PRICING`) so users can pick any model
 *     the executor already knows how to bill.
 *
 * If a future executor release exposes a /models endpoint, swap
 * this static list for an API call without changing call sites.
 */

export interface ModelOption {
  /** Exact identifier sent to the inference API. */
  id: string;
  /** Human-readable label rendered in the dropdown. */
  label: string;
}

export const ANTHROPIC_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { id: 'claude-sonnet-4-7', label: 'Claude Sonnet 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4 (May 2025)' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (May 2025)' },
  { id: 'claude-haiku-35-20250620', label: 'Claude Haiku 3.5' },
];

/** Default catalog used by the model picker. */
export const MODEL_CATALOG: ModelOption[] = ANTHROPIC_MODELS;
