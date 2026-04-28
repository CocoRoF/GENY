/**
 * Per-tool detail content — the deep walkthrough rendered in
 * `ToolDetailModal`. One factory per tool, keyed by the canonical
 * tool name (matches `BUILT_IN_TOOL_CLASSES` for executor tools and
 * `GenyToolProvider.list_names()` for Geny tools).
 *
 * The catalog API already provides a short description, parameter
 * schema, and capabilities — those render unconditionally. The
 * detail content here is layered on top: longer walkthrough body,
 * "best for / avoid when" guidance, subtle gotchas, example
 * invocations, cross-references. All optional — a tool with no
 * registered content still shows the catalog basics.
 */

import type { Locale } from '@/lib/i18n';

export interface ToolExample {
  /** Free-form one-line caption — what this example demonstrates. */
  caption: string;
  /** Pretty-printed JSON (mock arguments, mock results, etc.). */
  body: string;
  /** Optional follow-up note explaining the result. */
  note?: string;
}

export interface ToolDetailContent {
  /** Multi-paragraph deep walkthrough. Plain text; no markdown. */
  body: string;
  /** When this tool is the right pick. */
  bestFor?: string[];
  /** When NOT to use it. */
  avoidWhen?: string[];
  /** Subtle behaviours / common pitfalls / version-specific quirks. */
  gotchas?: string[];
  /** Example invocations — the agent's perspective. */
  examples?: ToolExample[];
  /** Other tools that pair well with this one. */
  relatedTools?: string[];
  /** Stages whose behaviour this tool feeds into. */
  relatedStages?: string[];
  /** Repo-relative source pointer (e.g. "geny-executor / src/.../read_tool.py"). */
  codeRef?: string;
}

export type ToolDetailFactory = (locale: Locale) => ToolDetailContent;
