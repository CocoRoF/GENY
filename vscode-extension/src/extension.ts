import * as vscode from 'vscode';
import { GenyViewProvider } from './chatView';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new GenyViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GenyViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    provider,
    vscode.commands.registerCommand('geny.login', () =>
      vscode.commands.executeCommand('geny.chat.focus'),
    ),
    vscode.commands.registerCommand('geny.logout', () => provider.logoutCommand()),
    vscode.commands.registerCommand('geny.newSession', () => provider.newSessionCommand()),
    vscode.commands.registerCommand('geny.reconnect', () => provider.reconnect()),
    vscode.commands.registerCommand('geny.showConnectorStatus', () =>
      vscode.commands.executeCommand('geny.chat.focus'),
    ),
  );
}

export function deactivate(): void {
  /* subscriptions dispose automatically */
}
