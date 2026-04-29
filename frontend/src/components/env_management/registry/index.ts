/**
 * Registry primitives — shared layout building blocks for the four
 * host-registry tabs (MCP / SKILLS / HOOK / 권한).
 *
 *   RegistryPageShell       — outer chrome (header, banner, body)
 *   RegistryCard            — individual entry card
 *   RegistryGrid            — responsive grid wrapper for cards
 *   RegistrySection         — group header + grid (e.g. BUNDLED/USER)
 *   RegistryEmptyState      — centered empty state with CTA
 *   RegistryActionButton    — 24×24 icon button for card-row actions
 *
 * Cycle 20260429 Phase 8 — extracted so the four tabs share visual
 * vocabulary instead of each reinventing the same patterns. See
 * the individual files for slot model + tone variants.
 */

export { default as RegistryPageShell } from './RegistryPageShell';
export type { RegistryPageShellProps } from './RegistryPageShell';

export { default as RegistryCard } from './RegistryCard';
export type {
  RegistryCardProps,
  RegistryCardBadge,
} from './RegistryCard';

export { default as RegistryGrid } from './RegistryGrid';
export type { RegistryGridProps } from './RegistryGrid';

export { default as RegistrySection } from './RegistrySection';
export type { RegistrySectionProps } from './RegistrySection';

export { default as RegistryEmptyState } from './RegistryEmptyState';
export type { RegistryEmptyStateProps } from './RegistryEmptyState';

export { default as RegistryActionButton } from './RegistryActionButton';
export type { RegistryActionButtonProps } from './RegistryActionButton';
