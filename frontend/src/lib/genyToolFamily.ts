/**
 * Shared family classification for Geny tools.
 *
 * Both `GenyToolsExplorer` (the env-level picker) and the
 * `newDraft()` seeder need the same answer to "what family does this
 * tool belong to?", so the rules live here. Adding a tool to a
 * family in one place must not skew the other — that's how a tool
 * could be selectable in the picker but skipped at seed time, or
 * vice versa.
 */

interface SubFamily {
  id: string;
  prefix: string;
}

const SUB_FAMILY_PREFIXES: SubFamily[] = [
  { id: 'memory', prefix: 'memory_' },
  { id: 'knowledge', prefix: 'knowledge_' },
  { id: 'opsidian', prefix: 'opsidian_' },
  { id: 'session', prefix: 'session_' },
  { id: 'room', prefix: 'room_' },
  { id: 'browser', prefix: 'browser_' },
  { id: 'web', prefix: 'web_' },
];

/** Exact-name overrides for tools whose names don't fit a clean prefix. */
const EXPLICIT_FAMILY_MAP: Record<string, string> = {
  send_room_message: 'room',
  send_direct_message_external: 'messaging',
  send_direct_message_internal: 'messaging',
  read_room_messages: 'room',
  read_inbox: 'messaging',
  news_search: 'web',
  feed: 'game',
  gift: 'game',
  play: 'game',
  talk: 'game',
};

/** Family ids surfaced as quick-pick presets in GenyToolsExplorer. */
export const GENY_FAMILY_ORDER: readonly string[] = [
  'memory',
  'knowledge',
  'opsidian',
  'session',
  'room',
  'messaging',
  'game',
  'browser',
  'web',
  'other',
];

/**
 * Families excluded from the "all checked except…" default applied
 * when the env management UI seeds a new draft.
 *
 * Adding a family here means new envs won't ship those tools enabled
 * by default — the user can still toggle them on via the picker.
 *
 * Today's only exclusion: `game` (creature/companion tools like
 * feed/gift/play/talk). Most envs are not vtuber-style companion
 * agents, so shipping with those on tends to confuse the LLM —
 * "Why am I being told I have a `feed` tool?"
 *
 * The list is intentionally a `const` array (not a Set) so adding
 * new exclusions is a single-line diff — exactly the change the
 * user has signalled is coming.
 */
export const GENY_FAMILIES_EXCLUDED_FROM_SEED_DEFAULT: readonly string[] = [
  'game',
];

export function genyToolFamily(toolName: string): string {
  if (toolName in EXPLICIT_FAMILY_MAP) return EXPLICIT_FAMILY_MAP[toolName];
  for (const fam of SUB_FAMILY_PREFIXES) {
    if (toolName.startsWith(fam.prefix)) return fam.id;
  }
  return 'other';
}

/** True if the tool's family is in the exclusion list — i.e. it
 *  should NOT be auto-checked when seeding a new env. */
export function isExcludedFromSeedDefault(toolName: string): boolean {
  return GENY_FAMILIES_EXCLUDED_FROM_SEED_DEFAULT.includes(
    genyToolFamily(toolName),
  );
}
