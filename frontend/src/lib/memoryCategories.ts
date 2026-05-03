/**
 * Single source of truth for the LTM category set + their UI metadata.
 *
 * The backend (`service.memory.structured_writer.VALID_CATEGORIES` +
 * `geny-executor`'s `NOTE_CATEGORIES`) defines what categories exist
 * on disk; this module mirrors that set on the frontend so the
 * MemoryTab tree, the Opsidian sidebar, the QuickSwitcher, the
 * WikilinkPicker, and the NoteViewer all show every category the
 * backend can write.
 *
 * Plan §1.5 — semantic groups:
 *
 *   - LEAF (source of truth):   `conversations` (per-session-per-bucket rollups)
 *   - INDEX:                    `dms` (per-counterpart-per-day bundles)
 *   - DERIVED:                  `insights`
 *   - CURATED:                  `topics`, `projects`, `daily`, `critical`
 *   - ARTIFACT:                 `compactions`, `executions`
 *
 * The legacy `entities` category was retired in 1.12.0 and the
 * standalone `daily-journal` category was retired in cycle 20260503_6
 * (rollup files now carry every turn with date_first/date_last in
 * frontmatter, so the standalone headline index was redundant).
 *
 * Plus `root` for files directly under `memory/` (MEMORY.md and any
 * stragglers when the index manager couldn't infer a category).
 *
 * Adding a new category? Update both this file *and* the backend
 * `VALID_CATEGORIES` set in lockstep — they're meant to mirror.
 */

import type { LucideIcon } from 'lucide-react';
import {
  Bookmark,
  Calendar,
  File,
  FileText,
  FolderKanban,
  GitGraph,
  Lightbulb,
  MessageSquare,
} from 'lucide-react';

/** All categories the backend can write to. Order matters — the
 * MemoryTab tree renders folders in this sequence, so we group by
 * "what users look at most often" rather than alphabetic. */
export const MEMORY_CATEGORIES = [
  'conversations',
  'dms',
  'executions',
  'insights',
  'topics',
  'projects',
  'daily',
  'compactions',
  'root',
] as const;

export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

/** Categories the LTM Notes tree filter renders. `root` is special-
 * cased into "files directly under memory/" so it appears separately
 * in tree consumers that want it. */
export const VISIBLE_CATEGORIES = MEMORY_CATEGORIES;

/** Categories that legitimately accept human / agent-driven writes
 * via the MemoryTab "New note" modal. The auto-managed categories
 * (conversations, dms, executions, compactions) are filtered out
 * — they're written by record_message / s02 hooks / record_execution
 * only and the modal would otherwise let users create misshapen
 * stub notes that the auto-writers would later overwrite or
 * misindex.
 */
export const WRITABLE_CATEGORIES: readonly MemoryCategory[] = [
  'topics',
  'projects',
  'daily',
  'insights',
];

/** Lucide icon per category. Falls back to `File` when the
 * category is unknown (legacy notes from before the category
 * rename, or external imports). */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  conversations: MessageSquare,
  dms: MessageSquare,
  // Cycle 20260503_5 — execution-summary stream owns dated logs.
  // Cycle 20260503_6 — ``daily-journal`` retired; conversation
  // rollups carry every turn so the standalone headline index was
  // redundant.
  executions: GitGraph,
  insights: Lightbulb,
  topics: Bookmark,
  projects: FolderKanban,
  daily: Calendar,
  compactions: GitGraph,
  root: FileText,
  // Legacy: curated_knowledge uses a "reference" category.
  reference: FileText,
};

/** Hex color per category. Used by QuickSwitcher / WikilinkPicker
 * for the small category dot next to each filename. */
export const CATEGORY_COLORS: Record<string, string> = {
  conversations: '#60a5fa', // blue — the leaf source of truth
  dms: '#a78bfa',           // violet — counterpart channel
  executions: '#22c55e',    // green — execution-summary stream
  insights: '#ec4899',      // pink — distilled knowledge
  topics: '#3b82f6',        // blue — curated subject pages
  projects: '#8b5cf6',      // violet — curated initiative pages
  daily: '#f59e0b',         // amber — curated free-form day notes
  compactions: '#94a3b8',   // slate — system artifact
  root: '#64748b',          // grey — uncategorised
  reference: '#64748b',     // grey — legacy
};

/** Human-readable category labels (i18n key suffix under
 * ``memory.categoryLabels``). Components that want full
 * localisation use the i18n keys; components that just need a
 * sensible English fallback use this map.
 */
export const CATEGORY_FALLBACK_LABELS: Record<string, string> = {
  conversations: 'Conversations',
  dms: 'DMs',
  executions: 'Executions',
  insights: 'Insights',
  topics: 'Topics',
  projects: 'Projects',
  daily: 'Daily',
  compactions: 'Compactions',
  root: 'Root',
  reference: 'Reference',
};

/** True when a category is auto-managed and the New-note modal
 * should hide it. */
export function isAutoManagedCategory(cat: string): boolean {
  return cat === 'conversations'
    || cat === 'dms'
    || cat === 'executions'
    || cat === 'compactions';
}
