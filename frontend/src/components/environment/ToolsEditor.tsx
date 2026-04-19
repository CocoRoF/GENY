'use client';

/**
 * ToolsEditor — edits the four `manifest.tools` snapshot fields:
 * `global_allowlist`, `global_blocklist` (pattern arrays) and
 * `adhoc`, `mcp_servers` (opaque object arrays).
 *
 * Pattern arrays are edited as one pattern per line — empty lines
 * are stripped on save. The object arrays are edited as pretty-
 * printed JSON; if the user pastes a non-array / invalid JSON we
 * surface the error inline so they can fix it before the parent
 * enables Save.
 */

import { useMemo } from 'react';

import type { ToolsSnapshot } from '@/types/environment';

export interface ToolsDraft {
  adhocText: string;
  mcpServersText: string;
  allowlistText: string;
  blocklistText: string;
}

export function toolsDraftFromSnapshot(tools: ToolsSnapshot | undefined): ToolsDraft {
  const t = tools ?? emptyTools();
  return {
    adhocText: JSON.stringify(t.adhoc ?? [], null, 2),
    mcpServersText: JSON.stringify(t.mcp_servers ?? [], null, 2),
    allowlistText: (t.global_allowlist ?? []).join('\n'),
    blocklistText: (t.global_blocklist ?? []).join('\n'),
  };
}

export function emptyTools(): ToolsSnapshot {
  return {
    adhoc: [],
    mcp_servers: [],
    global_allowlist: [],
    global_blocklist: [],
  };
}

function parseJsonArray(
  text: string,
): { ok: true; value: Array<Record<string, unknown>> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: [] };
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: 'Must be a JSON array' };
    }
    for (const item of parsed) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, error: 'Each entry must be a JSON object' };
      }
    }
    return { ok: true, value: parsed as Array<Record<string, unknown>> };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
}

function parsePatternList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

export interface ToolsValidation {
  adhocError: string | null;
  mcpServersError: string | null;
  hasErrors: boolean;
  snapshot: ToolsSnapshot | null;
}

export function validateToolsDraft(draft: ToolsDraft): ToolsValidation {
  const adhoc = parseJsonArray(draft.adhocText);
  const mcp = parseJsonArray(draft.mcpServersText);
  const adhocError = adhoc.ok ? null : adhoc.error;
  const mcpError = mcp.ok ? null : mcp.error;
  const hasErrors = !!adhocError || !!mcpError;
  const snapshot: ToolsSnapshot | null = hasErrors
    ? null
    : {
        adhoc: adhoc.ok ? adhoc.value : [],
        mcp_servers: mcp.ok ? mcp.value : [],
        global_allowlist: parsePatternList(draft.allowlistText),
        global_blocklist: parsePatternList(draft.blocklistText),
      };
  return {
    adhocError,
    mcpServersError: mcpError,
    hasErrors,
    snapshot,
  };
}

export function toolsSnapshotsEqual(a: ToolsSnapshot, b: ToolsSnapshot): boolean {
  return (
    JSON.stringify(a.adhoc ?? []) === JSON.stringify(b.adhoc ?? []) &&
    JSON.stringify(a.mcp_servers ?? []) === JSON.stringify(b.mcp_servers ?? []) &&
    JSON.stringify(a.global_allowlist ?? []) === JSON.stringify(b.global_allowlist ?? []) &&
    JSON.stringify(a.global_blocklist ?? []) === JSON.stringify(b.global_blocklist ?? [])
  );
}

interface Props {
  draft: ToolsDraft;
  onChange: (next: ToolsDraft) => void;
  labels: {
    allowlist: string;
    allowlistHint: string;
    blocklist: string;
    blocklistHint: string;
    adhocTools: string;
    adhocToolsHint: string;
    mcpServers: string;
    mcpServersHint: string;
    patternsPlaceholder: string;
    jsonArrayPlaceholder: string;
    entriesCount: string;
  };
}

function PatternField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      rows={5}
      spellCheck={false}
      placeholder={placeholder}
      className="py-2 px-3 rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] text-[0.8125rem] leading-[1.5] text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--primary-color)] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] resize-y"
    />
  );
}

function JsonArrayField({
  value,
  onChange,
  placeholder,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  error: string | null;
}) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      rows={8}
      spellCheck={false}
      placeholder={placeholder}
      className={`py-2 px-3 rounded-md bg-[var(--bg-primary)] border font-mono text-[0.75rem] leading-[1.5] text-[var(--text-primary)] focus:outline-none focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] resize-y ${
        error
          ? 'border-[var(--danger-color)] focus:border-[var(--danger-color)]'
          : 'border-[var(--border-color)] focus:border-[var(--primary-color)]'
      }`}
    />
  );
}

export default function ToolsEditor({ draft, onChange, labels }: Props) {
  const validation = useMemo(() => validateToolsDraft(draft), [draft]);
  const allowlistCount = useMemo(
    () => parsePatternList(draft.allowlistText).length,
    [draft.allowlistText],
  );
  const blocklistCount = useMemo(
    () => parsePatternList(draft.blocklistText).length,
    [draft.blocklistText],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label className="text-[0.6875rem] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
            {labels.allowlist}
          </label>
          <span className="text-[0.625rem] text-[var(--text-muted)]">
            {labels.entriesCount.replace('{count}', String(allowlistCount))}
          </span>
        </div>
        <PatternField
          value={draft.allowlistText}
          onChange={next => onChange({ ...draft, allowlistText: next })}
          placeholder={labels.patternsPlaceholder}
        />
        <small className="text-[0.6875rem] text-[var(--text-muted)]">{labels.allowlistHint}</small>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label className="text-[0.6875rem] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
            {labels.blocklist}
          </label>
          <span className="text-[0.625rem] text-[var(--text-muted)]">
            {labels.entriesCount.replace('{count}', String(blocklistCount))}
          </span>
        </div>
        <PatternField
          value={draft.blocklistText}
          onChange={next => onChange({ ...draft, blocklistText: next })}
          placeholder={labels.patternsPlaceholder}
        />
        <small className="text-[0.6875rem] text-[var(--text-muted)]">{labels.blocklistHint}</small>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[0.6875rem] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
          {labels.adhocTools}
        </label>
        <JsonArrayField
          value={draft.adhocText}
          onChange={next => onChange({ ...draft, adhocText: next })}
          placeholder={labels.jsonArrayPlaceholder}
          error={validation.adhocError}
        />
        {validation.adhocError ? (
          <small className="text-[0.6875rem] text-[var(--danger-color)]">
            {validation.adhocError}
          </small>
        ) : (
          <small className="text-[0.6875rem] text-[var(--text-muted)]">{labels.adhocToolsHint}</small>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[0.6875rem] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
          {labels.mcpServers}
        </label>
        <JsonArrayField
          value={draft.mcpServersText}
          onChange={next => onChange({ ...draft, mcpServersText: next })}
          placeholder={labels.jsonArrayPlaceholder}
          error={validation.mcpServersError}
        />
        {validation.mcpServersError ? (
          <small className="text-[0.6875rem] text-[var(--danger-color)]">
            {validation.mcpServersError}
          </small>
        ) : (
          <small className="text-[0.6875rem] text-[var(--text-muted)]">{labels.mcpServersHint}</small>
        )}
      </div>
    </div>
  );
}
