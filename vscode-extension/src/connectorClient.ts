// Connector WebSocket — the local-capability bridge.
//
// Opens /ws/connector/{sessionId} (Bearer header — a Node WS can set arbitrary
// handshake headers, the priority-#1 auth source), advertises the vscode.*
// capabilities, and answers each `capability_call` frame by running the matching
// VSCode operation locally and replying `capability_result`.
//
// Wire protocol (backend ws/connector_stream.py + connector_registry.py):
//   → {"type":"hello","capabilities":[...]}
//   ← {"type":"ready","data":{accepted_capabilities:[...]}}
//   ← {"type":"capability_call","data":{request_id, tool, args, reason}}
//   → {"type":"capability_result","data":{request_id, ok, result|error|denied}}
//   ↔ {"type":"heartbeat","ts":n}

import * as vscode from 'vscode';
import WebSocket from 'ws';

import { wsBase } from './api';
import { CAPABILITY_NAMES, dispatchCapability, CapabilityContext } from './capabilities';

export type ConnectorState = 'connecting' | 'ready' | 'offline';

export class ConnectorClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private _state: ConnectorState = 'offline';

  constructor(
    private serverUrl: string,
    private token: string,
    private sessionId: string,
    private ctx: CapabilityContext,
    private onState: (s: ConnectorState) => void,
    private log: (msg: string) => void,
  ) {}

  get state(): ConnectorState {
    return this._state;
  }

  private setState(s: ConnectorState) {
    if (this._state !== s) {
      this._state = s;
      this.onState(s);
    }
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  dispose(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.setState('offline');
  }

  private scheduleRetry() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, 4000);
  }

  private connect() {
    if (this.closed) return;
    this.setState('connecting');
    const url = `${wsBase(this.serverUrl)}/ws/connector/${encodeURIComponent(this.sessionId)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch (e) {
      this.log(`connector connect failed: ${String(e)}`);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.log('connector socket open — advertising capabilities');
      this.send({ type: 'hello', capabilities: CAPABILITY_NAMES });
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ type: 'heartbeat', ts: Date.now() }), 25000);
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg?.type === 'ready') {
        this.setState('ready');
        const caps = msg?.data?.accepted_capabilities;
        this.log(`connector ready — ${Array.isArray(caps) ? caps.length : 0} capabilities accepted`);
      } else if (msg?.type === 'capability_call') {
        void this.handleCall(msg.data);
      }
      // heartbeat echoes are ignored (keepalive only)
    });

    ws.on('close', (code: number) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.setState('offline');
      if (code === 4401) {
        this.log('connector unauthorized (4401) — token invalid/expired');
        // Do not hot-retry an auth failure; the extension refreshes + restarts.
        return;
      }
      if (!this.closed) this.scheduleRetry();
    });

    ws.on('error', (err) => {
      this.log(`connector error: ${String((err as Error)?.message || err)}`);
      // 'close' follows and schedules the retry.
    });
  }

  private async handleCall(data: { request_id?: string; tool?: string; args?: any; reason?: string }) {
    const request_id = data?.request_id;
    const tool = data?.tool || '';
    const args = data?.args || {};
    let payload: Record<string, unknown>;
    try {
      payload = await dispatchCapability(tool, args, this.ctx, data?.reason);
    } catch (e) {
      payload = { ok: false, error: String((e as Error)?.message || e) };
    }
    this.send({ type: 'capability_result', data: { request_id, ...payload } });
  }

  private send(obj: unknown) {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      /* socket gone */
    }
  }
}

// Re-export for callers that only need the advertised list.
export { CAPABILITY_NAMES };
