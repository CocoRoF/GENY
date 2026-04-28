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

registerToolDetail('Read', readToolHelp);
registerToolDetail('Write', writeToolHelp);
registerToolDetail('Edit', editToolHelp);
registerToolDetail('Glob', globToolHelp);
registerToolDetail('Grep', grepToolHelp);
registerToolDetail('NotebookEdit', notebookEditToolHelp);

registerToolDetail('Bash', bashToolHelp);
