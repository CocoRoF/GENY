/**
 * Provider + model catalog for the global model config editor.
 *
 * Provider taxonomy mirrors geny-executor 2.0.0's
 * `geny_executor.llm_client.registry.ClientRegistry` — six providers:
 *
 *   - anthropic         Claude family (default; hard dependency)
 *   - openai            GPT-4.1 + reasoning models (o3 / o4-mini)
 *   - google            Gemini 3.x / 2.5
 *   - vllm              any model on a local vLLM endpoint; free-form
 *   - claude_code_cli   subprocess driving the local `claude` CLI
 *                       (Anthropic-subscription or API-key auth)
 *   - copilot_cli       subprocess driving `gh copilot`; plain text
 *                       only — no streaming, no tools, no structured
 *                       output. Honest capability flags surface this
 *                       in the StageEditor / Settings UI.
 *
 * If a future executor release exposes an HTTP `/models` endpoint, swap
 * the static lists for an API call without changing the call sites —
 * the `MODEL_CATALOG` shape is the public contract here.
 */

export type ProviderKind = 'api' | 'cli';

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'vllm'
  | 'claude_code_cli'
  | 'copilot_cli';

export interface ProviderInfo {
  id: ProviderId;
  /** Display label rendered in the provider selector. */
  label: string;
  /** When true, the model field is a free-form input rather than a
   *  strict dropdown — used for vLLM (user-controlled) and the CLI
   *  backends (model aliases vary by binary version). */
  freeForm: boolean;
  /** Whether this provider is an HTTP API or a local subprocess CLI. */
  kind: ProviderKind;
  /** When kind === 'cli', a short hint the UI surfaces if the binary
   *  / login isn't ready yet. */
  installHelp?: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', label: 'Anthropic', freeForm: false, kind: 'api' },
  { id: 'openai', label: 'OpenAI', freeForm: false, kind: 'api' },
  { id: 'google', label: 'Google', freeForm: false, kind: 'api' },
  { id: 'vllm', label: 'vLLM (self-host)', freeForm: true, kind: 'api' },
  {
    id: 'claude_code_cli',
    label: 'Claude Code (CLI)',
    freeForm: true,
    kind: 'cli',
    installHelp:
      'Install Claude Code (docs.anthropic.com/claude/code) and run `claude auth login`, or paste ANTHROPIC_API_KEY through Settings → LLM Backends.',
  },
  {
    id: 'copilot_cli',
    label: 'GitHub Copilot (CLI)',
    freeForm: true,
    kind: 'cli',
    installHelp:
      'Install `gh` (cli.github.com), then `gh auth login` + `gh extension install github/gh-copilot`.',
  },
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
  claude_code_cli: [
    { id: 'sonnet', label: 'Claude Sonnet (alias)' },
    { id: 'opus', label: 'Claude Opus (alias)' },
    { id: 'haiku', label: 'Claude Haiku (alias)' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (pinned)' },
    { id: 'claude-opus-4-7', label: 'Opus 4.7 (pinned)' },
  ],
  copilot_cli: [
    { id: 'default', label: 'Copilot default (server-chosen)' },
  ],
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
  claude_code_cli: 'sonnet',
  copilot_cli: 'default',
};

/** Look up provider metadata by id. Returns the canonical Anthropic
 *  entry if the id is unknown so callers don't have to null-check. */
export function getProviderInfo(id: string | null | undefined): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Capability hints rendered as badges next to the selected provider.
 *  The frontend shows these for the CLI backends so users know up-front
 *  that, e.g., Copilot CLI doesn't stream. */
export const PROVIDER_CAPABILITY_HINTS: Record<ProviderId, string[]> = {
  anthropic: ['thinking', 'tools', 'streaming', 'top_k'],
  openai: ['tools', 'streaming', 'json_schema'],
  google: ['tools', 'streaming', 'top_k', 'json_schema'],
  vllm: ['streaming'],
  claude_code_cli: ['thinking', 'tools', 'streaming', 'mcp', 'session_resume', 'budget'],
  copilot_cli: ['no streaming', 'no tools'],
};

/** Mirrors executor's `_infer_api_artifact` so the UI can fall back to
 *  prefix-based provider detection when the s06_api stage hasn't yet
 *  pinned an explicit provider via ``config.provider``.
 *
 *  Order:
 *   1. CLI-only catalogs first — claude_code_cli ships short aliases
 *      ("sonnet", "opus", "haiku") that the API anthropic catalog
 *      doesn't have. Without this check, "sonnet" falls through to
 *      the claude-* prefix rule and gets misclassified as anthropic.
 *   2. copilot_cli catalog ("default").
 *   3. Prefix detection for the API providers.
 *   4. Default: anthropic — same fallback the executor uses.
 *
 *  Note: this is only a *fallback* for manifests that don't carry an
 *  explicit ``config.provider``. Editors should always read the
 *  explicit field first and only call ``inferProvider`` when it's
 *  missing — see ``Stage06ApiEditor`` / ``Stage18MemoryEditor``.
 */
export function inferProvider(model: string | null | undefined): ProviderId {
  const m = (model ?? '').toLowerCase();
  if (!m) return 'anthropic';

  // CLI catalog match — only for *CLI-exclusive* ids, i.e. ids that
  // appear in a CLI catalog but in no API catalog. Otherwise a legacy
  // manifest pinned to "claude-sonnet-4-6" (which is in both the
  // anthropic and claude_code_cli catalogs) would silently re-infer
  // as claude_code_cli after this rule landed.
  const inAnyApi =
    MODEL_CATALOG.anthropic.some((o) => o.id === m) ||
    MODEL_CATALOG.openai.some((o) => o.id === m) ||
    MODEL_CATALOG.google.some((o) => o.id === m);
  if (!inAnyApi) {
    if (MODEL_CATALOG.claude_code_cli.some((o) => o.id === m)) {
      return 'claude_code_cli';
    }
    if (MODEL_CATALOG.copilot_cli.some((o) => o.id === m)) {
      return 'copilot_cli';
    }
  }

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


/** Validate an arbitrary string against the ProviderId union. Returns
 *  ``null`` if the value isn't a known provider, otherwise the
 *  narrowed type. Used by editors that read an explicit provider from
 *  manifest config and need to fall back to ``inferProvider`` when
 *  the field is missing or malformed. */
export function parseProviderId(value: unknown): ProviderId | null {
  if (typeof value !== 'string') return null;
  return (PROVIDERS.some((p) => p.id === value) ? (value as ProviderId) : null);
}
