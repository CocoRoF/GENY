// Geny REST + WS contract (see backend controller/auth_controller.py,
// agent_controller.py, ws/execute_stream.py, ws/connector_stream.py).

export interface LoginResult {
  access_token: string;
  token_type: string;
  username: string;
  display_name: string;
}

export interface SessionInfo {
  session_id: string;
  session_name?: string | null;
  status: 'starting' | 'running' | 'idle' | 'stopped' | 'error' | string;
  created_at?: string;
  role?: string | null;
  model?: string | null;
  error_message?: string | null;
  session_type?: string | null;
  env_id?: string | null;
}

export interface AuthStatus {
  has_users: boolean;
  is_authenticated: boolean;
  username?: string | null;
  display_name?: string | null;
}

/** The dedicated VSCode-extension environment (backend templates.py). A session
 *  MUST be created under this env for the vscode_* tools to be exposed. */
export const VSCODE_ENV_ID = 'template-vscode-env';

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function httpBase(serverUrl: string): string {
  return normalizeBase(serverUrl);
}

/** HTTP base → WS base (http→ws, https→wss). */
export function wsBase(serverUrl: string): string {
  const base = normalizeBase(serverUrl);
  if (base.startsWith('https://')) return 'wss://' + base.slice('https://'.length);
  if (base.startsWith('http://')) return 'ws://' + base.slice('http://'.length);
  return base; // already ws/wss
}

export class GenyApi {
  constructor(private serverUrl: string, private token?: string) {}

  setToken(token: string | undefined) {
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(httpBase(this.serverUrl) + path, { ...init, headers });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { detail?: string };
        if (body?.detail) detail = body.detail;
      } catch {
        /* non-JSON error body */
      }
      const err = new Error(detail) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return undefined as unknown as T;
    return (await res.json()) as T;
  }

  authStatus(): Promise<AuthStatus> {
    return this.request<AuthStatus>('/api/auth/status');
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const r = await this.request<LoginResult>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    this.token = r.access_token;
    return r;
  }

  /** Extend the current token; returns a fresh one (or throws 401 if expired). */
  async refresh(): Promise<LoginResult> {
    const r = await this.request<LoginResult>('/api/auth/refresh', { method: 'POST' });
    this.token = r.access_token;
    return r;
  }

  me(): Promise<{ username: string; display_name: string }> {
    return this.request('/api/auth/me');
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>('/api/agents');
  }

  getSession(id: string): Promise<SessionInfo> {
    return this.request<SessionInfo>(`/api/agents/${encodeURIComponent(id)}`);
  }

  /** Create a session bound to the VSCode environment so vscode_* tools are on. */
  createVscodeSession(name?: string): Promise<SessionInfo> {
    return this.request<SessionInfo>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        session_name: name || 'VSCode',
        env_id: VSCODE_ENV_ID,
      }),
    });
  }

  resumeSession(id: string): Promise<SessionInfo> {
    return this.request<SessionInfo>(
      `/api/agents/${encodeURIComponent(id)}/resume`,
      { method: 'POST' },
    );
  }
}
