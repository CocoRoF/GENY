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

const REGISTRY: Record<string, SectionHelpFactory> = {
  'stage01.validator': stage01ValidatorHelp,
  'stage01.normalizer': stage01NormalizerHelp,
};

export function getSectionHelp(id: string): SectionHelpFactory | undefined {
  return REGISTRY[id];
}

export function hasSectionHelp(id: string): boolean {
  return id in REGISTRY;
}
