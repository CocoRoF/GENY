/**
 * Canonical section / tab icons — single source of truth so every tab header,
 * sub-tab strip, and nav uses the SAME glyph (and the same lucide style) for the
 * same concept. Import from here for tab chrome instead of reaching into
 * `lucide-react` directly, so the icon for e.g. "Logs" or "Tools" is changed in
 * one place.
 *
 * Render them in the canonical header style (see TabShell): `size={14}`,
 * `strokeWidth={2.25}`, `text-[hsl(var(--primary))]`.
 */

import {
  LayoutDashboard,
  Settings,
  MessageSquare,
  ListChecks,
  Zap,
  HardDrive,
  Brain,
  ScrollText,
  Folder,
  Layers,
  Wrench,
  FolderOpen,
  Bot,
  User,
  type LucideIcon,
} from 'lucide-react';

/** Section → icon. Keys are stable concept names, not tab ids. */
export const SectionIcons = {
  dashboard: LayoutDashboard,
  settings: Settings,
  chat: MessageSquare,
  tasks: ListChecks,
  hooks: Zap,
  storage: HardDrive,
  memory: Brain,
  logs: ScrollText,
  environment: Folder,
  manifest: Layers,
  tools: Wrench,
  workspace: FolderOpen,
  agent: User,
  subAgent: Bot,
} as const satisfies Record<string, LucideIcon>;

export type SectionIconKey = keyof typeof SectionIcons;
