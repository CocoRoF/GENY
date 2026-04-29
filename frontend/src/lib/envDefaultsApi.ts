/**
 * envDefaultsApi — id derivation helpers for the env-defaults
 * categories (Phase 1, PR #552).
 *
 * The HTTP client + types live in `lib/api.ts` to match Geny's
 * "all *Api consts in one file, apiCall stays private" convention.
 * This file owns the canonical id-derivation rules per category —
 * keeping them here (not inline in each *Tab.tsx) guarantees the
 * toggle endpoint and the seeder agree on what id a given row
 * has. Diverging would mean the user toggles "audit" on the
 * picker but the seeder records something different and never
 * re-applies.
 *
 * The four categories:
 *
 *   hooks:        `${event}::${command_joined_by_space}`
 *   skills:       skill.id (stable string from SKILL.md frontmatter)
 *   permissions:  `${tool_name}::${pattern || '*'}::${behavior}`
 *                 — index-free so re-ordering rules in
 *                 settings.json doesn't break the default set
 *   mcp_servers:  server name (custom-MCP filename without .json)
 */

// Re-export the API surface from api.ts so existing import sites
// (`import { envDefaultsApi, EnvDefaultsCategory } from
// '@/lib/envDefaultsApi'`) keep compiling — the canonical home is
// `lib/api.ts` but the move was internal.
export {
  envDefaultsApi,
  type EnvDefaultsCategory,
  type EnvDefaultsResponse,
  type EnvDefaultsCategoryResponse,
} from '@/lib/api';

// ── Per-category id derivation ────────────────────────────────

export interface HookEntryShape {
  event: string;
  command: string[];
}

/**
 * Canonical hook id used by the env-defaults backend.
 *
 * The two hook surfaces ship slightly different shapes:
 *
 *   - `/api/hooks/list` (admin viewer): `command: string[]`
 *     where args are already pre-joined into one array.
 *   - `/api/hooks/entries` (editable CRUD): `command: string`
 *     + `args: string[]` stored separately so the editor can
 *     show them in different fields.
 *
 * Both must produce the same id so the picker (using the admin
 * shape) and the toggle (using the editable shape) toggle the
 * same row. `hookIdFromEditable` does the conversion.
 */
export function hookId(entry: HookEntryShape): string {
  return `${entry.event}::${(entry.command ?? []).join(' ')}`;
}

export interface HookEditableShape {
  event: string;
  command: string;
  args?: string[] | null;
}

export function hookIdFromEditable(row: HookEditableShape): string {
  const parts = [row.command, ...(row.args ?? [])].filter((s) => s != null);
  return `${row.event}::${parts.join(' ')}`;
}

export interface SkillIdShape {
  id?: string | null;
  name?: string | null;
}

/** Skills sometimes have a null id (malformed SKILL.md frontmatter)
 *  — fall back to name so the row stays addressable from the
 *  picker. The host editor should surface the underlying issue
 *  separately; we just don't want a click target with no id. */
export function skillId(skill: SkillIdShape): string | null {
  if (skill.id) return skill.id;
  if (skill.name) return skill.name;
  return null;
}

export interface PermissionRuleShape {
  tool_name: string;
  pattern?: string | null;
  behavior: string;
}

export function permissionId(rule: PermissionRuleShape): string {
  return `${rule.tool_name}::${rule.pattern ?? '*'}::${rule.behavior}`;
}

export function mcpServerId(server: { name: string }): string {
  return server.name;
}
