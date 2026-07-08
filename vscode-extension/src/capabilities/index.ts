// VSCode capability handlers — the agent's local operations on the user's real
// workspace. Each maps a `capability_call.data.tool` (a vscode.* string) + args
// to a VSCode API action and returns a {ok, result|error} payload.
//
// The advertised capability list MUST match the backend's VSCODE_CAPABILITIES
// (service/executor/vscode_bridge.py).

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as os from 'os';
import * as pathmod from 'path';

export const CAPABILITY_NAMES = [
  'vscode.workspace_info',
  'vscode.read_file',
  'vscode.list_dir',
  'vscode.find_files',
  'vscode.search_text',
  'vscode.active_editor',
  'vscode.diagnostics',
  'vscode.open',
  'vscode.write_file',
  'vscode.edit',
  'vscode.run_terminal',
];

/** Consent group for a destructive op → the extension's consent policy. */
export type ConsentGroup = 'fileWrite' | 'terminal';

export interface CapabilityContext {
  /** Ask the user to approve a destructive op; resolves true to proceed. */
  consent(group: ConsentGroup, title: string, detail: string): Promise<boolean>;
  log(msg: string): void;
  /** Echo agent-run commands into a visible terminal (config geny.terminal.show). */
  terminalEcho(command: string, cwd: string): void;
}

const ok = (result: unknown): Record<string, unknown> => ({ ok: true, result });
const fail = (error: string): Record<string, unknown> => ({ ok: false, error });
const denied = (error: string): Record<string, unknown> => ({ ok: false, denied: true, error });

// ── path resolution ──────────────────────────────────────────────────

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Resolve a workspace-relative or absolute/`~` path to a Uri. */
function resolvePath(p: string): vscode.Uri {
  let raw = (p || '').trim();
  if (raw.startsWith('~')) raw = pathmod.join(os.homedir(), raw.slice(1));
  if (pathmod.isAbsolute(raw)) return vscode.Uri.file(raw);
  const root = workspaceRoot();
  if (!root) return vscode.Uri.file(raw);
  return vscode.Uri.joinPath(root, raw);
}

/** A short display path relative to the workspace root when possible. */
function displayPath(uri: vscode.Uri): string {
  const root = workspaceRoot();
  if (root && uri.fsPath.startsWith(root.fsPath)) {
    return uri.fsPath.slice(root.fsPath.length).replace(/^[/\\]/, '') || '.';
  }
  return uri.fsPath;
}

async function readText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

// ── read-only handlers ───────────────────────────────────────────────

async function workspaceInfo(): Promise<Record<string, unknown>> {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => ({
    name: f.name,
    path: f.uri.fsPath,
  }));
  const openEditors = vscode.window.visibleTextEditors.map((e) => displayPath(e.document.uri));
  const active = vscode.window.activeTextEditor;
  return ok({
    folders,
    root: workspaceRoot()?.fsPath ?? null,
    open_editors: openEditors,
    active_file: active ? displayPath(active.document.uri) : null,
    platform: process.platform,
  });
}

async function readFile(a: { path: string; start_line?: number; end_line?: number }): Promise<Record<string, unknown>> {
  const uri = resolvePath(a.path);
  let text: string;
  try {
    text = await readText(uri);
  } catch (e) {
    return fail(`cannot read ${displayPath(uri)}: ${String((e as Error).message || e)}`);
  }
  const lines = text.split('\n');
  const start = Math.max(1, a.start_line || 1);
  const end = Math.min(lines.length, a.end_line || lines.length);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    out.push(`${String(i).padStart(width, ' ')}\t${lines[i - 1] ?? ''}`);
  }
  return ok({
    path: displayPath(uri),
    total_lines: lines.length,
    range: [start, end],
    content: out.join('\n'),
  });
}

async function listDir(a: { path?: string }): Promise<Record<string, unknown>> {
  const uri = a.path ? resolvePath(a.path) : workspaceRoot();
  if (!uri) return fail('no workspace open');
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const items = entries.map(([name, type]) => ({
      name,
      type:
        type === vscode.FileType.Directory
          ? 'dir'
          : type === vscode.FileType.SymbolicLink
            ? 'symlink'
            : 'file',
    }));
    items.sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'dir' ? -1 : 1));
    return ok({ path: displayPath(uri), entries: items });
  } catch (e) {
    return fail(`cannot list ${displayPath(uri)}: ${String((e as Error).message || e)}`);
  }
}

async function findFiles(a: { glob: string; max?: number }): Promise<Record<string, unknown>> {
  const max = Math.min(a.max || 200, 1000);
  const uris = await vscode.workspace.findFiles(a.glob, '**/{node_modules,.git,dist,out,build}/**', max);
  return ok({ glob: a.glob, count: uris.length, files: uris.map((u) => displayPath(u)) });
}

async function searchText(a: {
  query: string;
  glob?: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  max?: number;
}): Promise<Record<string, unknown>> {
  const max = Math.min(a.max || 200, 1000);
  const flags = a.case_sensitive ? 'g' : 'gi';
  let re: RegExp;
  try {
    re = new RegExp(a.is_regex ? a.query : a.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch (e) {
    return fail(`invalid regex: ${String((e as Error).message || e)}`);
  }
  const files = await vscode.workspace.findFiles(
    a.glob || '**/*',
    '**/{node_modules,.git,dist,out,build,.next,coverage}/**',
    4000,
  );
  const matches: Array<{ file: string; line: number; text: string }> = [];
  for (const uri of files) {
    if (matches.length >= max) break;
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.length > 2_000_000) continue; // skip huge/binary
      text = Buffer.from(bytes).toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        matches.push({ file: displayPath(uri), line: i + 1, text: lines[i].slice(0, 400) });
        if (matches.length >= max) break;
      }
    }
  }
  return ok({ query: a.query, count: matches.length, matches });
}

async function activeEditor(): Promise<Record<string, unknown>> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return ok({ active: false });
  const sel = ed.selection;
  const selected = ed.document.getText(sel);
  return ok({
    active: true,
    path: displayPath(ed.document.uri),
    language: ed.document.languageId,
    line_count: ed.document.lineCount,
    selection: sel.isEmpty
      ? null
      : {
          start: { line: sel.start.line + 1, char: sel.start.character },
          end: { line: sel.end.line + 1, char: sel.end.character },
          text: selected.slice(0, 8000),
        },
    cursor: { line: sel.active.line + 1, char: sel.active.character },
    visible_range: ed.visibleRanges[0]
      ? [ed.visibleRanges[0].start.line + 1, ed.visibleRanges[0].end.line + 1]
      : null,
  });
}

function severityName(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hint';
  }
}

async function diagnostics(a: { path?: string; severity?: string }): Promise<Record<string, unknown>> {
  const want = a.severity && a.severity !== 'all' ? a.severity : null;
  const collect = (uri: vscode.Uri, diags: readonly vscode.Diagnostic[]) =>
    diags
      .filter((d) => !want || severityName(d.severity) === want)
      .map((d) => ({
        file: displayPath(uri),
        severity: severityName(d.severity),
        line: d.range.start.line + 1,
        char: d.range.start.character,
        message: d.message,
        source: d.source || null,
      }));
  let out: Array<Record<string, unknown>> = [];
  if (a.path) {
    const uri = resolvePath(a.path);
    out = collect(uri, vscode.languages.getDiagnostics(uri));
  } else {
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      out = out.concat(collect(uri, diags));
      if (out.length > 500) break;
    }
  }
  return ok({ count: out.length, diagnostics: out.slice(0, 500) });
}

async function openFile(a: { path: string; line?: number }): Promise<Record<string, unknown>> {
  const uri = resolvePath(a.path);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (a.line && a.line > 0) {
      const pos = new vscode.Position(Math.min(a.line - 1, doc.lineCount - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
    return ok({ opened: displayPath(uri), line: a.line || 1 });
  } catch (e) {
    return fail(`cannot open ${displayPath(uri)}: ${String((e as Error).message || e)}`);
  }
}

// ── destructive handlers (consent-gated) ─────────────────────────────

async function writeFile(a: { path: string; content: string }, ctx: CapabilityContext): Promise<Record<string, unknown>> {
  const uri = resolvePath(a.path);
  let existed = true;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    existed = false;
  }
  const okConsent = await ctx.consent(
    'fileWrite',
    existed ? `Overwrite ${displayPath(uri)}?` : `Create ${displayPath(uri)}?`,
    `The agent wants to ${existed ? 'overwrite' : 'create'} ${displayPath(uri)} (${a.content.length} chars).`,
  );
  if (!okConsent) return denied('user declined the file write');
  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(a.content, 'utf8'));
    return ok({ written: displayPath(uri), created: !existed, bytes: Buffer.byteLength(a.content, 'utf8') });
  } catch (e) {
    return fail(`write failed: ${String((e as Error).message || e)}`);
  }
}

async function editFile(
  a: { path: string; edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> },
  ctx: CapabilityContext,
): Promise<Record<string, unknown>> {
  const uri = resolvePath(a.path);
  let text: string;
  try {
    text = await readText(uri);
  } catch (e) {
    return fail(`cannot read ${displayPath(uri)} for editing: ${String((e as Error).message || e)}`);
  }
  // Validate every edit against the current content before applying any.
  let next = text;
  for (const [i, ed] of a.edits.entries()) {
    if (!ed.old_string) return fail(`edit #${i + 1}: old_string is empty`);
    const count = next.split(ed.old_string).length - 1;
    if (count === 0) return fail(`edit #${i + 1}: old_string not found (must match exactly)`);
    if (count > 1 && !ed.replace_all)
      return fail(`edit #${i + 1}: old_string matches ${count} times — add context to make it unique, or set replace_all`);
    next = ed.replace_all ? next.split(ed.old_string).join(ed.new_string) : next.replace(ed.old_string, ed.new_string);
  }
  const okConsent = await ctx.consent(
    'fileWrite',
    `Apply ${a.edits.length} edit(s) to ${displayPath(uri)}?`,
    `The agent wants to modify ${displayPath(uri)}.`,
  );
  if (!okConsent) return denied('user declined the edit');
  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(next, 'utf8'));
    return ok({ edited: displayPath(uri), edits_applied: a.edits.length });
  } catch (e) {
    return fail(`edit write failed: ${String((e as Error).message || e)}`);
  }
}

async function runTerminal(
  a: { command: string; cwd?: string; timeout_sec?: number },
  ctx: CapabilityContext,
): Promise<Record<string, unknown>> {
  const cwd = a.cwd ? resolvePath(a.cwd).fsPath : workspaceRoot()?.fsPath || os.homedir();
  const timeoutMs = Math.min((a.timeout_sec || 120) * 1000, 600000);
  const okConsent = await ctx.consent('terminal', `Run in ${displayPath(vscode.Uri.file(cwd))}?`, `$ ${a.command}`);
  if (!okConsent) return denied('user declined the terminal command');
  ctx.terminalEcho(a.command, cwd);

  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
  const shellArgs = process.platform === 'win32' ? ['/c', a.command] : ['-lc', a.command];
  return await new Promise<Record<string, unknown>>((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const child = spawn(shell, shellArgs, { cwd, env: process.env });
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve(
          ok({
            command: a.command,
            cwd,
            timed_out: true,
            exit_code: null,
            stdout: stdout.slice(-20000),
            stderr: stderr.slice(-20000),
          }),
        );
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(fail(`spawn failed: ${String(e.message)}`));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(
        ok({
          command: a.command,
          cwd,
          exit_code: code,
          stdout: stdout.slice(-40000),
          stderr: stderr.slice(-40000),
        }),
      );
    });
  });
}

// ── dispatch ─────────────────────────────────────────────────────────

export async function dispatchCapability(
  tool: string,
  args: any,
  ctx: CapabilityContext,
  _reason?: string,
): Promise<Record<string, unknown>> {
  switch (tool) {
    case 'vscode.workspace_info':
      return workspaceInfo();
    case 'vscode.read_file':
      return readFile(args);
    case 'vscode.list_dir':
      return listDir(args);
    case 'vscode.find_files':
      return findFiles(args);
    case 'vscode.search_text':
      return searchText(args);
    case 'vscode.active_editor':
      return activeEditor();
    case 'vscode.diagnostics':
      return diagnostics(args);
    case 'vscode.open':
      return openFile(args);
    case 'vscode.write_file':
      return writeFile(args, ctx);
    case 'vscode.edit':
      return editFile(args, ctx);
    case 'vscode.run_terminal':
      return runTerminal(args, ctx);
    default:
      return fail(`unknown capability: ${tool}`);
  }
}
