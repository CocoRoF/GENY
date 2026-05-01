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
 * Plan §1.5 — five semantic groups:
 *
 *   - LEAF (source of truth):   `conversations`
 *   - INDEX:                    `dms`, `daily-journal`
 *   - DERIVED:                  `insights`
 *   - CURATED:                  `topics`, `projects`, `daily`
 *   - ARTIFACT:                 `compactions`
 *
 * The legacy `entities` category was retired in 1.12.0: counterpart
 * stats already live under `dms/<cp>/<date>.md` and the StreamTab UI,
 * and `memory_distill` writes its summaries to `insights/counterpart-
 * <id>.md` instead.
 *
 * Plus `root` for files directly under `memory/` (MEMORY.md and
 * the daily-journal `<YYYY-MM-DD>.md` files when the index manager
 * couldn't infer a category).
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
  'daily-journal',
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
 * (conversations, dms, daily-journal, compactions) are filtered out
 * — they're written by record_message / s02 hooks only and the
 * modal would otherwise let users create misshapen stub notes that
 * the auto-writers would later overwrite or misindex.
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
  'daily-journal': Calendar,
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
  'daily-journal': '#f97316', // orange — chronological index
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
  'daily-journal': 'Daily Journal',
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
    || cat === 'daily-journal'
    || cat === 'compactions';
}
