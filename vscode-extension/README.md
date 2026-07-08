# Geny for VSCode

Chat with your Geny agents from inside VSCode — and let them work in your **real
workspace**: read, search, edit files, and run terminal commands on your
machine, like GitHub Copilot or Claude Code, but powered by your own Geny
server and its agents.

## How it works

The extension is a Geny **connector**: it logs in to your Geny server, opens a
chat with an agent session, and opens a second WebSocket that exposes a set of
`vscode.*` capabilities. When the agent calls a `vscode_*` tool, the call is
routed over that socket and executed locally by the extension against your
workspace, then the result is returned to the agent.

- **Isolated tool set.** The agent only gets these local-workspace tools when
  its session runs under the dedicated **"VSCode 확장"** environment
  (`template-vscode-env`). They never leak into other agents/environments.
- **You stay in control.** File writes and terminal commands are gated by
  per-capability consent (`ask` / `session` / `auto`, in settings).

## Local capabilities the agent can use

Read: `workspace_info`, `read_file`, `list_dir`, `find_files`, `search_text`,
`active_editor`, `diagnostics`, `open`.
Change (consent-gated): `write_file`, `edit`, `run_terminal`.

## Usage

1. Open the **Geny** view in the Activity Bar.
2. Log in with your Geny server URL, username, and password.
3. Create a **New VSCode session** (bound to the VSCode environment) or pick an
   existing one.
4. Chat. Ask it to explore, refactor, add a feature, run the tests — it works in
   the folder you have open.

## Settings

- `geny.serverUrl` — default server URL for the login form.
- `geny.consent.fileWrite` — `ask` | `session` | `auto` for file writes/edits.
- `geny.consent.terminal` — `ask` | `session` | `auto` for terminal commands.
- `geny.terminal.show` — echo agent-run commands into a "Geny Agent" output
  channel (output is still captured and returned to the agent).

## Develop

```
npm install
npm run watch      # rebuild on change
# F5 in VSCode to launch an Extension Development Host
npm run package    # produce a .vsix
```
