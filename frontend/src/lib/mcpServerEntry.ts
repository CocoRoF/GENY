/**
 * MCP server entry — env-side type + custom-host conversion.
 *
 * Lives in `lib/` (not the component) so the new-draft seeder
 * (Zustand store) can import the converter without dragging in
 * the `MCPServerEditor` React tree. Store ← component is a
 * one-way coupling we deliberately avoid.
 *
 * Cycle 20260429 Phase 7 — schema expanded from stdio-only to all
 * three MCP transports so env-defaults' ★ on a custom HTTP/SSE
 * server seeds those fields directly. `transport` is optional and
 * defaults to `'stdio'` for back-compat with pre-7 manifests.
 *
 * Wire shape consumed by geny-executor:
 * `ToolsSnapshot.mcp_servers: List[Dict[str, Any]]` — additional
 * fields pass through, so it's safe to ship more keys than the
 * runtime currently reads.
 */

export type MCPTransport = 'stdio' | 'http' | 'sse';

export interface MCPServerEntry {
  name: string;
  transport?: MCPTransport;
  // ── stdio ──
  command?: string;
  args?: string[];
  // ── http / sse ──
  url?: string;
  headers?: Record<string, string>;
  // ── shared ──
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

const TRANSPORTS: readonly MCPTransport[] = ['stdio', 'http', 'sse'];

function recordOfStrings(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([k, v]) => [
      k,
      String(v),
    ]),
  );
}

function arrayOfStrings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((v) => String(v));
}

/**
 * Map a custom-MCP catalog config (from `/api/mcp/custom/{name}`)
 * to the env-side MCPServerEntry shape. The seeder + the
 * "Add from host registry" picker share this so they snapshot
 * identical structures into the manifest.
 */
export function customMcpToEnvEntry(
  name: string,
  config: Record<string, unknown>,
): MCPServerEntry {
  const out: MCPServerEntry = { name };
  if (
    typeof config.transport === 'string' &&
    (TRANSPORTS as readonly string[]).includes(config.transport)
  ) {
    out.transport = config.transport as MCPTransport;
  }
  if (typeof config.command === 'string') out.command = config.command;
  const args = arrayOfStrings(config.args);
  if (args) out.args = args;
  if (typeof config.url === 'string') out.url = config.url;
  const env = recordOfStrings(config.env);
  if (env) out.env = env;
  const headers = recordOfStrings(config.headers);
  if (headers) out.headers = headers;
  const autoApprove = arrayOfStrings(config.autoApprove);
  if (autoApprove) out.autoApprove = autoApprove;
  if (typeof config.disabled === 'boolean') out.disabled = config.disabled;
  return out;
}
