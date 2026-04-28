'use client';

/**
 * MCPServerEditor — env-scoped curated CRUD over `manifest.tools.mcp_servers`.
 *
 * Each entry describes how to spawn an MCP server subprocess at session
 * start. Fields mirror the canonical entry shape from
 * `geny_executor.mcp.manager.MCPManager`:
 *
 *   {
 *     name: string,                 // required, prefix for tool names
 *     command: string,              // required, executable
 *     args?: string[],              // command-line args
 *     env?: Record<string, string>, // per-server env vars
 *     disabled?: boolean,           // skip at boot without removing entry
 *     autoApprove?: string[],       // tool names that bypass HITL
 *   }
 *
 * Edit happens through a modal so the panel stays compact in list mode.
 */

import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Pencil,
  Plus,
  Power,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

export interface MCPServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

export interface MCPServerEditorProps {
  value: MCPServerEntry[];
  onChange: (next: MCPServerEntry[]) => void;
}

export default function MCPServerEditor({
  value,
  onChange,
}: MCPServerEditorProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{
    index: number;
    draft: MCPServerEntry;
  } | null>(null);

  const startAdd = () => {
    setEditing({
      index: -1,
      draft: { name: '', command: '', args: [], env: {}, disabled: false },
    });
  };

  const startEdit = (idx: number) => {
    setEditing({ index: idx, draft: { ...value[idx] } });
  };

  const cancelEdit = () => setEditing(null);

  const saveEdit = (next: MCPServerEntry) => {
    if (!next.name.trim() || !next.command.trim()) return;
    if (editing!.index < 0) {
      onChange([...value, next]);
    } else {
      const copy = [...value];
      copy[editing!.index] = next;
      onChange(copy);
    }
    setEditing(null);
  };

  const removeAt = (idx: number) => {
    if (!confirm(t('envManagement.mcpEditor.confirmRemove'))) return;
    onChange(value.filter((_, i) => i !== idx));
  };

  const toggleDisabled = (idx: number) => {
    const copy = [...value];
    copy[idx] = { ...copy[idx], disabled: !copy[idx].disabled };
    onChange(copy);
  };

  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-[hsl(var(--muted-foreground))]">
          <Server className="w-6 h-6 opacity-50" />
          <span className="text-[0.8125rem] italic">
            {t('envManagement.mcpEditor.empty')}
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {value.map((entry, idx) => (
            <li
              key={`${entry.name}-${idx}`}
              className="flex items-start gap-3 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))]"
            >
              <Server
                className={`w-4 h-4 mt-1 shrink-0 ${
                  entry.disabled
                    ? 'text-[hsl(var(--muted-foreground))]'
                    : 'text-[hsl(var(--primary))]'
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))] truncate">
                    {entry.name || '(unnamed)'}
                  </span>
                  {entry.disabled && (
                    <span className="text-[0.625rem] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                      {t('envManagement.mcpEditor.disabledBadge')}
                    </span>
                  )}
                </div>
                <code className="text-[0.6875rem] font-mono text-[hsl(var(--muted-foreground))] break-all">
                  {entry.command}
                  {entry.args && entry.args.length > 0
                    ? ' ' + entry.args.join(' ')
                    : ''}
                </code>
                <div className="flex items-center gap-3 mt-1 text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                  <span>
                    env:{' '}
                    <span className="tabular-nums">
                      {Object.keys(entry.env ?? {}).length}
                    </span>
                  </span>
                  <span>
                    autoApprove:{' '}
                    <span className="tabular-nums">
                      {(entry.autoApprove ?? []).length}
                    </span>
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => toggleDisabled(idx)}
                  title={
                    entry.disabled
                      ? t('envManagement.mcpEditor.enableTip')
                      : t('envManagement.mcpEditor.disableTip')
                  }
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
                >
                  <Power className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(idx)}
                  title={t('envManagement.mcpEditor.editTip')}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))] transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  title={t('envManagement.mcpEditor.removeTip')}
                  className="w-7 h-7 inline-flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)] transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={startAdd}
        className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:border-[hsl(var(--primary)/0.4)] hover:bg-[hsl(var(--accent))] transition-colors"
      >
        <Plus className="w-4 h-4" />
        {t('envManagement.mcpEditor.addServer')}
      </button>

      {editing && (
        <ServerEditModal
          isNew={editing.index < 0}
          initial={editing.draft}
          onCancel={cancelEdit}
          onSave={saveEdit}
        />
      )}
    </div>
  );
}

function ServerEditModal({
  isNew,
  initial,
  onCancel,
  onSave,
}: {
  isNew: boolean;
  initial: MCPServerEntry;
  onCancel: () => void;
  onSave: (next: MCPServerEntry) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial.name);
  const [command, setCommand] = useState(initial.command);
  const [argsText, setArgsText] = useState(
    (initial.args ?? []).join('\n'),
  );
  const [envText, setEnvText] = useState(
    Object.entries(initial.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  const [autoApproveText, setAutoApproveText] = useState(
    (initial.autoApprove ?? []).join('\n'),
  );
  const [disabled, setDisabled] = useState(!!initial.disabled);
  const [error, setError] = useState<string | null>(null);

  const handleSave = () => {
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (!trimmedName) {
      setError(t('envManagement.mcpEditor.errorNoName'));
      return;
    }
    if (!trimmedCommand) {
      setError(t('envManagement.mcpEditor.errorNoCommand'));
      return;
    }
    const args = argsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const env: Record<string, string> = {};
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) {
        setError(t('envManagement.mcpEditor.errorBadEnv', { line: trimmed }));
        return;
      }
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
    const autoApprove = autoApproveText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const out: MCPServerEntry = {
      name: trimmedName,
      command: trimmedCommand,
    };
    if (args.length > 0) out.args = args;
    if (Object.keys(env).length > 0) out.env = env;
    if (autoApprove.length > 0) out.autoApprove = autoApprove;
    if (disabled) out.disabled = true;
    onSave(out);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px] p-4"
      onClick={onCancel}
    >
      <div
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[hsl(var(--border))] sticky top-0 bg-[hsl(var(--card))] z-10">
          <h3 className="text-[0.9375rem] font-semibold text-[hsl(var(--foreground))]">
            {isNew
              ? t('envManagement.mcpEditor.addTitle')
              : t('envManagement.mcpEditor.editTitle')}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="w-7 h-7 inline-flex items-center justify-center rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-4 flex flex-col gap-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] text-[0.75rem] text-[var(--danger-color)]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-name">
                {t('envManagement.mcpEditor.name')}
              </Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="filesystem"
                className="font-mono text-[0.8125rem]"
              />
              <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.mcpEditor.nameHint')}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-command">
                {t('envManagement.mcpEditor.command')}
              </Label>
              <Input
                id="mcp-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                className="font-mono text-[0.8125rem]"
              />
              <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.mcpEditor.commandHint')}
              </p>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="mcp-args">
              {t('envManagement.mcpEditor.args')}{' '}
              <span className="opacity-60">
                ({t('envManagement.mcpEditor.onePerLine')})
              </span>
            </Label>
            <Textarea
              id="mcp-args"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              rows={3}
              className="font-mono text-[0.75rem]"
              placeholder="-y\n@modelcontextprotocol/server-filesystem\n/path/to/root"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="mcp-env">
              {t('envManagement.mcpEditor.env')}{' '}
              <span className="opacity-60">
                (KEY=VALUE, {t('envManagement.mcpEditor.onePerLine').toLowerCase()})
              </span>
            </Label>
            <Textarea
              id="mcp-env"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              rows={3}
              className="font-mono text-[0.75rem]"
              placeholder="GITHUB_TOKEN=ghp_xxx\nDEBUG=1"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="mcp-auto">
              {t('envManagement.mcpEditor.autoApprove')}{' '}
              <span className="opacity-60">
                ({t('envManagement.mcpEditor.onePerLine')})
              </span>
            </Label>
            <Textarea
              id="mcp-auto"
              value={autoApproveText}
              onChange={(e) => setAutoApproveText(e.target.value)}
              rows={2}
              className="font-mono text-[0.75rem]"
              placeholder="read_file\nlist_directory"
            />
            <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
              {t('envManagement.mcpEditor.autoApproveHint')}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))]">
            <div className="flex flex-col gap-0.5">
              <span className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
                {t('envManagement.mcpEditor.disabledLabel')}
              </span>
              <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.mcpEditor.disabledHint')}
              </span>
            </div>
            <Switch checked={disabled} onCheckedChange={setDisabled} />
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[hsl(var(--border))] sticky bottom-0 bg-[hsl(var(--card))] z-10">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 px-3.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-[0.8125rem] font-medium hover:opacity-90 transition-opacity"
          >
            <Check className="w-3.5 h-3.5" />
            {isNew
              ? t('envManagement.mcpEditor.add')
              : t('envManagement.mcpEditor.save')}
          </button>
        </footer>
      </div>
    </div>
  );
}
