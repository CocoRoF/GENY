// Per-capability consent for destructive local operations.
//
// Policy comes from settings (geny.consent.fileWrite / geny.consent.terminal):
//   'ask'     — a modal every time
//   'session' — a modal once per group, then allow for this VSCode session
//   'auto'    — never prompt (the user opted in)
// The modal also offers "Allow for this session" which upgrades the group to
// session-allow in memory (not persisted) so the agent can work in a flow.

import * as vscode from 'vscode';
import type { CapabilityContext, ConsentGroup } from './capabilities';

export class ConsentManager {
  private sessionAllow = new Set<ConsentGroup>();

  constructor(private log: (m: string) => void) {}

  /** Reset session-allow (e.g. on logout / server switch). */
  reset(): void {
    this.sessionAllow.clear();
  }

  private mode(group: ConsentGroup): 'ask' | 'session' | 'auto' {
    const cfg = vscode.workspace.getConfiguration('geny');
    const key = group === 'terminal' ? 'consent.terminal' : 'consent.fileWrite';
    const v = cfg.get<string>(key, 'ask');
    return v === 'auto' || v === 'session' ? v : 'ask';
  }

  async request(group: ConsentGroup, title: string, detail: string): Promise<boolean> {
    if (this.mode(group) === 'auto' || this.sessionAllow.has(group)) return true;

    const allowOnce = 'Allow';
    const allowSession = group === 'terminal' ? 'Allow commands this session' : 'Allow writes this session';
    const deny = 'Deny';
    const choice = await vscode.window.showWarningMessage(
      title,
      { modal: true, detail },
      allowOnce,
      allowSession,
      deny,
    );
    if (choice === allowSession) {
      this.sessionAllow.add(group);
      return true;
    }
    return choice === allowOnce;
  }

  /** Build the CapabilityContext consent hook + command echo. */
  makeContext(): Pick<CapabilityContext, 'consent' | 'terminalEcho'> {
    return {
      consent: (group, t, d) => this.request(group, t, d),
      // DISPLAY only — the command is actually executed via child_process (to
      // capture output); echoing to an OutputChannel avoids double-running.
      terminalEcho: (command, cwd) => {
        const cfg = vscode.workspace.getConfiguration('geny');
        if (!cfg.get<boolean>('terminal.show', true)) return;
        try {
          const out = getEchoChannel();
          out.appendLine(`$ ${command}    (cwd: ${cwd})`);
          out.show(true);
        } catch {
          /* echo is best-effort */
        }
      },
    };
  }
}

let echoChannel: vscode.OutputChannel | undefined;
function getEchoChannel(): vscode.OutputChannel {
  if (!echoChannel) echoChannel = vscode.window.createOutputChannel('Geny Agent');
  return echoChannel;
}
