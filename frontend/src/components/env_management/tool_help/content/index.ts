/**
 * Tool-detail content registry — bootstraps the per-tool factory map
 * via side-effect import. Each content file exports its factory and
 * we register them all here, keyed by the canonical tool name.
 *
 * BuiltinToolsExplorer / GenyToolsExplorer should `import` this
 * module once at top level so the registrations run before any
 * `?` button can fire a lookup.
 */

import { registerToolDetail } from '../registry';

// ── filesystem family ──
import { readToolHelp } from './Read';
import { writeToolHelp } from './Write';
import { editToolHelp } from './Edit';
import { globToolHelp } from './Glob';
import { grepToolHelp } from './Grep';
import { notebookEditToolHelp } from './NotebookEdit';

// ── shell family ──
import { bashToolHelp } from './Bash';

// ── agent family ──
import { agentToolHelp } from './Agent';

// ── meta family ──
import { toolSearchToolHelp } from './ToolSearch';
import { enterPlanModeToolHelp } from './EnterPlanMode';
import { exitPlanModeToolHelp } from './ExitPlanMode';

// ── workflow family ──
import { todoWriteToolHelp } from './TodoWrite';

// ── interaction family ──
import { askUserQuestionToolHelp } from './AskUserQuestion';

// ── notification family ──
import { pushNotificationToolHelp } from './PushNotification';

// ── mcp family ──
import { mcpToolHelp } from './MCP';
import { listMcpResourcesToolHelp } from './ListMcpResources';
import { readMcpResourceToolHelp } from './ReadMcpResource';
import { mcpAuthToolHelp } from './McpAuth';

// ── worktree family ──
import { enterWorktreeToolHelp } from './EnterWorktree';
import { exitWorktreeToolHelp } from './ExitWorktree';

// ── dev family ──
import { lspToolHelp } from './LSP';
import { replToolHelp } from './REPL';
import { briefToolHelp } from './Brief';

registerToolDetail('Read', readToolHelp);
registerToolDetail('Write', writeToolHelp);
registerToolDetail('Edit', editToolHelp);
registerToolDetail('Glob', globToolHelp);
registerToolDetail('Grep', grepToolHelp);
registerToolDetail('NotebookEdit', notebookEditToolHelp);

registerToolDetail('Bash', bashToolHelp);

registerToolDetail('Agent', agentToolHelp);

registerToolDetail('ToolSearch', toolSearchToolHelp);
registerToolDetail('EnterPlanMode', enterPlanModeToolHelp);
registerToolDetail('ExitPlanMode', exitPlanModeToolHelp);

registerToolDetail('TodoWrite', todoWriteToolHelp);

registerToolDetail('AskUserQuestion', askUserQuestionToolHelp);

registerToolDetail('PushNotification', pushNotificationToolHelp);

registerToolDetail('MCP', mcpToolHelp);
registerToolDetail('ListMcpResources', listMcpResourcesToolHelp);
registerToolDetail('ReadMcpResource', readMcpResourceToolHelp);
registerToolDetail('McpAuth', mcpAuthToolHelp);

registerToolDetail('EnterWorktree', enterWorktreeToolHelp);
registerToolDetail('ExitWorktree', exitWorktreeToolHelp);

registerToolDetail('LSP', lspToolHelp);
registerToolDetail('REPL', replToolHelp);
registerToolDetail('Brief', briefToolHelp);
