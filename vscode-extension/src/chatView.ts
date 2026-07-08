// Geny sidebar view — owns the login → session → chat lifecycle and bridges the
// webview UI to the REST/WS clients + the local capability connector.

import * as vscode from 'vscode';

import { GenyApi, SessionInfo, VSCODE_ENV_ID } from './api';
import { ExecuteClient } from './executeClient';
import { ConnectorClient, ConnectorState } from './connectorClient';
import { ConsentManager } from './consent';
import type { CapabilityContext } from './capabilities';

const TOKEN_KEY = 'geny.accessToken';
const SERVER_KEY = 'geny.serverUrl';

type WebMsg =
  | { type: 'ready' }
  | { type: 'login'; serverUrl: string; username: string; password: string }
  | { type: 'logout' }
  | { type: 'refreshSessions' }
  | { type: 'newSession'; name?: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'backToSessions' }
  | { type: 'send'; text: string }
  | { type: 'stop' };

export class GenyViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'geny.chat';

  private view?: vscode.WebviewView;
  private api?: GenyApi;
  private token?: string;
  private serverUrl = '';
  private session?: SessionInfo;
  private exec?: ExecuteClient;
  private connector?: ConnectorClient;
  private readonly consent: ConsentManager;
  private readonly output: vscode.OutputChannel;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Geny');
    this.consent = new ConsentManager((m) => this.log(m));
  }

  private log(m: string) {
    this.output.appendLine(`[${new Date().toISOString()}] ${m}`);
  }

  private post(msg: unknown) {
    void this.view?.webview.postMessage(msg);
  }

  // ── VSCode wiring ──────────────────────────────────────────────────

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: WebMsg) => this.onMessage(m));
  }

  private async onMessage(m: WebMsg) {
    try {
      switch (m.type) {
        case 'ready':
          await this.restore();
          break;
        case 'login':
          await this.doLogin(m.serverUrl, m.username, m.password);
          break;
        case 'logout':
          await this.doLogout();
          break;
        case 'refreshSessions':
          await this.showSessions();
          break;
        case 'newSession':
          await this.newSession(m.name);
          break;
        case 'selectSession':
          await this.selectSession(m.sessionId);
          break;
        case 'backToSessions':
          this.teardownSession();
          await this.showSessions();
          break;
        case 'send':
          this.sendPrompt(m.text);
          break;
        case 'stop':
          this.exec?.stop();
          break;
      }
    } catch (e) {
      this.post({ type: 'error', message: String((e as Error)?.message || e) });
    }
  }

  // ── auth ───────────────────────────────────────────────────────────

  private async restore() {
    const token = await this.ctx.secrets.get(TOKEN_KEY);
    const server = this.ctx.globalState.get<string>(SERVER_KEY) || vscode.workspace.getConfiguration('geny').get<string>('serverUrl', '');
    if (!token || !server) {
      this.post({ type: 'view', view: 'login', serverUrl: server || '' });
      return;
    }
    this.token = token;
    this.serverUrl = server;
    this.api = new GenyApi(server, token);
    // Extend the token on launch; on 401 fall back to login.
    try {
      const r = await this.api.refresh();
      this.token = r.access_token;
      await this.ctx.secrets.store(TOKEN_KEY, r.access_token);
      this.post({ type: 'account', username: r.display_name || r.username });
      await this.showSessions();
    } catch (e) {
      this.log(`token refresh failed: ${String((e as Error)?.message || e)}`);
      await this.doLogout();
    }
  }

  private async doLogin(serverUrl: string, username: string, password: string) {
    const server = (serverUrl || '').trim();
    if (!server || !username || !password) {
      this.post({ type: 'error', message: 'server, username and password are required' });
      return;
    }
    const api = new GenyApi(server);
    const r = await api.login(username, password);
    this.token = r.access_token;
    this.serverUrl = server;
    this.api = new GenyApi(server, r.access_token);
    await this.ctx.secrets.store(TOKEN_KEY, r.access_token);
    await this.ctx.globalState.update(SERVER_KEY, server);
    this.post({ type: 'account', username: r.display_name || r.username });
    await this.showSessions();
  }

  private async doLogout() {
    this.teardownSession();
    this.consent.reset();
    this.token = undefined;
    this.api = undefined;
    await this.ctx.secrets.delete(TOKEN_KEY);
    this.post({ type: 'view', view: 'login', serverUrl: this.serverUrl });
  }

  // ── sessions ───────────────────────────────────────────────────────

  private async showSessions() {
    if (!this.api) return;
    const all = await this.api.listSessions();
    // Surface VSCode-env sessions first (they expose the vscode_* tools), but
    // keep the rest available so a user can still chat with any agent.
    const vscodeSessions = all.filter((s) => s.env_id === VSCODE_ENV_ID);
    const others = all.filter((s) => s.env_id !== VSCODE_ENV_ID);
    this.post({ type: 'view', view: 'sessions', vscodeSessions, others });
  }

  private async newSession(name?: string) {
    if (!this.api) return;
    const s = await this.api.createVscodeSession(name);
    await this.selectSession(s.session_id, s);
  }

  private async selectSession(sessionId: string, known?: SessionInfo) {
    if (!this.api || !this.token) return;
    let s = known;
    if (!s) {
      s = await this.api.getSession(sessionId).catch(() => undefined);
    }
    if (s && s.status === 'stopped') {
      s = await this.api.resumeSession(sessionId).catch(() => s);
    }
    this.teardownSession();
    this.session = s || ({ session_id: sessionId, status: 'idle' } as SessionInfo);

    const isVscodeEnv = this.session.env_id === VSCODE_ENV_ID;
    this.post({
      type: 'view',
      view: 'chat',
      session: this.session,
      isVscodeEnv,
    });

    // Chat stream.
    this.exec = new ExecuteClient(
      this.serverUrl,
      this.token,
      sessionId,
      {
        onOpen: () => this.post({ type: 'chatOpen' }),
        onClose: () => this.post({ type: 'chatClose' }),
        onStatus: (status, message) => this.post({ type: 'status', status, message }),
        onLog: (level, message, metadata) => this.post({ type: 'log', level, message, metadata }),
        onResult: (result) => this.post({ type: 'result', result }),
        onError: (error) => this.post({ type: 'error', message: error }),
        onDone: () => this.post({ type: 'done' }),
      },
      (m) => this.log(m),
    );
    this.exec.connect();

    // Local capability connector — only for VSCode-env sessions (only those
    // expose the vscode_* tools). For other sessions we still chat, but the
    // agent has no local operations here.
    if (isVscodeEnv) {
      const capCtx: CapabilityContext = {
        ...this.consent.makeContext(),
        log: (m) => this.log(m),
      };
      this.connector = new ConnectorClient(
        this.serverUrl,
        this.token,
        sessionId,
        capCtx,
        (state: ConnectorState) => this.post({ type: 'connector', state }),
        (m) => this.log(m),
      );
      this.connector.start();
    } else {
      this.post({ type: 'connector', state: 'offline' });
    }
  }

  private sendPrompt(text: string) {
    const t = (text || '').trim();
    if (!t || !this.exec) return;
    this.exec.send(t);
  }

  private teardownSession() {
    this.exec?.dispose();
    this.connector?.dispose();
    this.exec = undefined;
    this.connector = undefined;
    this.session = undefined;
  }

  dispose() {
    this.teardownSession();
    this.output.dispose();
  }

  // Commands (palette) delegate here.
  reconnect() {
    if (this.session) void this.selectSession(this.session.session_id, this.session);
  }
  async logoutCommand() {
    await this.doLogout();
  }
  async newSessionCommand() {
    if (this.api) await this.newSession();
  }

  // ── webview html ───────────────────────────────────────────────────

  private html(webview: vscode.Webview): string {
    const nonce = String(Math.random()).slice(2);
    const uri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${uri('main.css')}" />
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
  }
}
