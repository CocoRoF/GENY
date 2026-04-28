/**
 * Section-level help content shape. Each curated stage editor has
 * one or more sections (Validator, Normalizer, Strategy, etc.) and
 * each section can register a help blob keyed by `<stageNN>.<section>`
 * (e.g., "stage01.validator").
 *
 * Content lives in TS files under section_help/content/. Each file
 * exports both an `en` and a `ko` SectionHelpContent and selects via
 * a SectionHelpFactory.
 */
import type { Locale } from '@/lib/i18n';

export interface ConfigField {
  /** Manifest key path, e.g. "blocked_patterns" or "config.cache_prefix". */
  name: string;
  /** Human label in this locale. */
  label: string;
  /** "string" | "integer" | "list[string]" | etc. — short type hint. */
  type: string;
  /** Default value as a display string. Optional. */
  default?: string;
  /** Whether the executor requires this field to be set. */
  required?: boolean;
  /** Sentence-or-two explanation. */
  description: string;
}

export interface OptionContent {
  /** The impl key as registered in the executor (e.g., "default", "strict"). */
  id: string;
  /** Localized title. */
  label: string;
  /** Multi-paragraph deep description. Plain text; no markdown. */
  description: string;
  /** When this option is the right pick. Bullet list. */
  bestFor: string[];
  /** When NOT to pick this. Bullet list. Optional. */
  avoidWhen?: string[];
  /** Per-impl runtime config knobs. */
  config?: ConfigField[];
  /** Subtle behaviours that surprise people. Optional. */
  gotchas?: string[];
  /** Where in the executor to find the implementation. Optional. */
  codeRef?: string;
}

export interface RelatedSection {
  label: string;
  body: string;
}

export interface SectionHelpContent {
  /** Modal title — e.g., "Validator (검증기)". */
  title: string;
  /** One-paragraph high-level summary. Shown right under the title. */
  summary: string;
  /**
   * Longer "what this section actually does" paragraph. Where it
   * sits in the pipeline, what state it reads / writes, when it's
   * required.
   */
  whatItDoes: string;
  /** The list of available impls with deep per-option content. */
  options: OptionContent[];
  /**
   * Stage-level config fields belonging to this section. e.g., for
   * Stage 4 guard, `fail_fast` + `max_chain_length` live in
   * stage.config, not in any specific impl.
   */
  configFields?: ConfigField[];
  /** Pointers to other sections / stages this concept relates to. */
  relatedSections?: RelatedSection[];
  /** Repo-relative code path that owns this section. Optional. */
  codeRef?: string;
}

export type SectionHelpFactory = (locale: Locale) => SectionHelpContent;
