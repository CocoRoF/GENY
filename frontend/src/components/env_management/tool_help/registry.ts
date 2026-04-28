/**
 * Tool-detail registry. Phase B ships the infrastructure with an
 * empty registry — Phase C (per-family PRs) will populate it
 * tool by tool. Tools without an entry still render the basics
 * (description, parameters, capabilities) from the catalog API
 * — only the deep walkthrough sections are gated behind a
 * registered factory.
 */

import type { ToolDetailFactory } from './types';

const REGISTRY: Record<string, ToolDetailFactory> = {};

/** Register a tool's deep content. Called from per-tool content files. */
export function registerToolDetail(
  name: string,
  factory: ToolDetailFactory,
): void {
  REGISTRY[name] = factory;
}

export function getToolDetail(name: string): ToolDetailFactory | undefined {
  return REGISTRY[name];
}

export function hasToolDetail(name: string): boolean {
  return name in REGISTRY;
}
