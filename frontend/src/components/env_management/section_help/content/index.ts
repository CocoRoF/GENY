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

import { stage04ConfigHelp } from './Stage04Config';
import { stage04ChainHelp } from './Stage04Chain';

import { stage05StrategyHelp } from './Stage05Strategy';

import { stage06ModelOverrideHelp } from './Stage06ModelOverride';

import { stage07TrackerHelp } from './Stage07Tracker';
import { stage07CalculatorHelp } from './Stage07Calculator';

import { stage08ProcessorHelp } from './Stage08Processor';
import { stage08BudgetPlannerHelp } from './Stage08BudgetPlanner';

import { stage09ParserHelp } from './Stage09Parser';
import { stage09SignalHelp } from './Stage09Signal';

import { stage10BuiltInHelp } from './Stage10BuiltIn';
import { stage10MCPHelp } from './Stage10MCP';

import { stage11ChainHelp } from './Stage11Chain';

import { stage12OrchestratorHelp } from './Stage12Orchestrator';

import { stage13RegistryHelp } from './Stage13Registry';
import { stage13PolicyHelp } from './Stage13Policy';

import { stage14BudgetsHelp } from './Stage14Budgets';
import { stage14StrategiesHelp } from './Stage14Strategies';

import { stage15RequesterHelp } from './Stage15Requester';
import { stage15TimeoutHelp } from './Stage15Timeout';

import { stage16ControllerHelp } from './Stage16Controller';

import { stage17EmittersHelp } from './Stage17Emitters';

import { stage18StrategyHelp } from './Stage18Strategy';
import { stage18PersistHelp } from './Stage18Persist';
import { stage18ModelHelp } from './Stage18Model';

import { stage19SummarizerHelp } from './Stage19Summarizer';
import { stage19ImportanceHelp } from './Stage19Importance';

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

  // Stage 4 — Guard
  'stage04.config': stage04ConfigHelp,
  'stage04.chain': stage04ChainHelp,

  // Stage 5 — Cache
  'stage05.strategy': stage05StrategyHelp,

  // Stage 6 — API
  'stage06.modelOverride': stage06ModelOverrideHelp,

  // Stage 7 — Token
  'stage07.tracker': stage07TrackerHelp,
  'stage07.calculator': stage07CalculatorHelp,

  // Stage 8 — Think
  'stage08.processor': stage08ProcessorHelp,
  'stage08.budgetPlanner': stage08BudgetPlannerHelp,

  // Stage 9 — Parse
  'stage09.parser': stage09ParserHelp,
  'stage09.signal': stage09SignalHelp,

  // Stage 10 — Tools
  'stage10.builtIn': stage10BuiltInHelp,
  'stage10.mcp': stage10MCPHelp,

  // Stage 11 — Tool review
  'stage11.chain': stage11ChainHelp,

  // Stage 12 — Agent
  'stage12.orchestrator': stage12OrchestratorHelp,

  // Stage 13 — Task registry
  'stage13.registry': stage13RegistryHelp,
  'stage13.policy': stage13PolicyHelp,

  // Stage 14 — Evaluate
  'stage14.budgets': stage14BudgetsHelp,
  'stage14.strategies': stage14StrategiesHelp,

  // Stage 15 — HITL
  'stage15.requester': stage15RequesterHelp,
  'stage15.timeout': stage15TimeoutHelp,

  // Stage 16 — Loop
  'stage16.controller': stage16ControllerHelp,

  // Stage 17 — Emit
  'stage17.emitters': stage17EmittersHelp,

  // Stage 18 — Memory
  'stage18.strategy': stage18StrategyHelp,
  'stage18.persist': stage18PersistHelp,
  'stage18.model': stage18ModelHelp,

  // Stage 19 — Summarize
  'stage19.summarizer': stage19SummarizerHelp,
  'stage19.importance': stage19ImportanceHelp,
};

export function getSectionHelp(id: string): SectionHelpFactory | undefined {
  return REGISTRY[id];
}

export function hasSectionHelp(id: string): boolean {
  return id in REGISTRY;
}
