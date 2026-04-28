/**
 * Section-help registry. Each curated section in a stage editor uses
 * a dotted key (e.g., "stage01.validator") to look up its content.
 *
 * Add an entry here when introducing a new SectionHelpButton — the
 * button silently hides when its key isn't registered, so partial
 * coverage is safe but eventually every Curated section should have
 * a help blob.
 */

import type { SectionHelpFactory } from '../types';

import { stage01ValidatorHelp } from './Stage01Validator';
import { stage01NormalizerHelp } from './Stage01Normalizer';

import { stage02StatelessHelp } from './Stage02Stateless';
import { stage02StrategyHelp } from './Stage02Strategy';
import { stage02CompactorHelp } from './Stage02Compactor';
import { stage02RetrieverHelp } from './Stage02Retriever';

import { stage03BuilderHelp } from './Stage03Builder';
import { stage03SystemPromptHelp } from './Stage03SystemPrompt';

const REGISTRY: Record<string, SectionHelpFactory> = {
  // Stage 1 — Input
  'stage01.validator': stage01ValidatorHelp,
  'stage01.normalizer': stage01NormalizerHelp,

  // Stage 2 — Context
  'stage02.stateless': stage02StatelessHelp,
  'stage02.strategy': stage02StrategyHelp,
  'stage02.compactor': stage02CompactorHelp,
  'stage02.retriever': stage02RetrieverHelp,

  // Stage 3 — System
  'stage03.builder': stage03BuilderHelp,
  'stage03.systemPrompt': stage03SystemPromptHelp,
};

export function getSectionHelp(id: string): SectionHelpFactory | undefined {
  return REGISTRY[id];
}

export function hasSectionHelp(id: string): boolean {
  return id in REGISTRY;
}
