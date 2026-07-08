// Execute WebSocket — chat with the agent for one session.
//
// Opens /ws/execute/{sessionId} (Bearer header), sends {type:"execute", prompt},
// streams back `status`/`log`/`result`/`error`/`done` frames. Persistent: send
// another `execute` after `done` for the next turn.

import WebSocket from 'ws';
import { wsBase } from './api';

export interface ExecuteEvents {
  onStatus(status: string, message?: string): void;
  /** A streamed log line. level is RESPONSE / TOOL / TOOL_RES / STAGE / … */
  onLog(level: string, message: string, metadata: Record<string, unknown>): void;
  onResult(result: unknown): void;
  onError(error: string): void;
  onDone(): void;
  onOpen(): void;
  onClose(): void;
}

export class ExecuteClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private queue: string[] = [];

  constructor(
    private serverUrl: string,
    private token: string,
    private sessionId: string,
    private ev: ExecuteEvents,
    private log: (m: string) => void,
  ) {}

  connect(): void {
    this.closed = false;
    const url = `${wsBase(this.serverUrl)}/ws/execute/${encodeURIComponent(this.sessionId)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.token}` } });
    } catch (e) {
      this.ev.onError(`chat connect failed: ${String(e)}`);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.ev.onOpen();
      // flush any prompts queued before the socket opened
      for (const p of this.queue.splice(0)) this.rawSend({ type: 'execute', prompt: p });
    });
    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const d = msg?.data || {};
      switch (msg?.type) {
        case 'status':
          this.ev.onStatus(d.status, d.message);
          break;
        case 'log':
          this.ev.onLog(String(d.level || ''), String(d.message ?? ''), d.metadata || {});
          break;
        case 'result':
          this.ev.onResult(d);
          break;
        case 'error':
          this.ev.onError(String(d.error || 'error'));
          break;
        case 'done':
          this.ev.onDone();
          break;
        // heartbeat ignored
      }
    });
    ws.on('close', (code: number) => {
      this.ev.onClose();
      if (code === 4401) {
        this.log('chat unauthorized (4401)');
        return;
      }
      if (!this.closed) setTimeout(() => this.connect(), 3000);
    });
    ws.on('error', (e) => this.log(`chat error: ${String((e as Error)?.message || e)}`));
  }

  send(prompt: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.rawSend({ type: 'execute', prompt });
    } else {
      this.queue.push(prompt);
    }
  }

  stop(): void {
    this.rawSend({ type: 'stop' });
  }

  private rawSend(obj: unknown): void {
    try {
      this.ws?.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
