'use client';

/**
 * EnvManagementHeader — top-level navigation for the /environments
 * route. Hosts the 5-tab strip the operator restructure introduced:
 *
 *   ← Home | ✨ 환경 관리 | [환경관리] [MCP] [SKILLS] [HOOK] [권한]
 *
 * Tabs are mutually exclusive — picking one swaps the entire body
 * of `EnvManagementShell`. The "환경관리" tab is the home tab and
 * keeps the existing `CompactMetaBar` + canvas/stage editor flow.
 * The other four mount the host-level registry editor for that
 * category (hooks/skills/permissions/mcp_servers) so the operator
 * has a single hub for everything that participates in env
 * composition.
 *
 * Tab state is held in the URL via `?tab=...` so deep links from
 * a wiki page or another teammate land on the right tab. Default
 * is `environments` when the param is missing or unknown.
 *
 * Visual: dense single-row, no decorative chrome — leading nav and
 * tabs share the same horizontal strip. The bar sits ABOVE
 * CompactMetaBar (which only renders for the `environments` tab),
 * so non-env tabs get just one header row. This intentionally
 * undercuts the old "stack a header for each concern" pattern —
 * the user only edits one tab at a time.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Layers,
  Network,
  Plug,
  Shield,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export type EnvManagementTab =
  | 'environments'
  | 'mcp'
  | 'skills'
  | 'hooks'
  | 'permissions';

const TAB_ORDER: EnvManagementTab[] = [
  'environments',
  'mcp',
  'skills',
  'hooks',
  'permissions',
];

interface TabDef {
  id: EnvManagementTab;
  icon: LucideIcon;
  // Translation keys live under envManagement.topTabs.{label,hint}.
  // Hardcoded fallbacks below match the Korean source so a missing
  // key shows something sensible rather than the raw `topTabs.mcp`.
  fallbackLabel: string;
  fallbackHint: string;
  // i18n key suffix.
  key: string;
}

const TABS: TabDef[] = [
  {
    id: 'environments',
    icon: Layers,
    fallbackLabel: '환경관리',
    fallbackHint: '21단계 파이프라인 환경 만들기/편집',
    key: 'environments',
  },
  {
    id: 'mcp',
    icon: Network,
    fallbackLabel: 'MCP',
    fallbackHint: '호스트에 등록된 MCP 서버',
    key: 'mcp',
  },
  {
    id: 'skills',
    icon: Sparkles,
    fallbackLabel: 'SKILLS',
    fallbackHint: '호스트에 등록된 스킬',
    key: 'skills',
  },
  {
    id: 'hooks',
    icon: Plug,
    fallbackLabel: 'HOOK',
    fallbackHint: '호스트에 등록된 훅',
    key: 'hooks',
  },
  {
    id: 'permissions',
    icon: Shield,
    fallbackLabel: '권한',
    fallbackHint: '호스트에 등록된 권한 룰',
    key: 'permissions',
  },
];

export function parseTab(value: string | null | undefined): EnvManagementTab {
  if (value && (TAB_ORDER as string[]).includes(value)) {
    return value as EnvManagementTab;
  }
  return 'environments';
}

export interface EnvManagementHeaderProps {
  active: EnvManagementTab;
}

export default function EnvManagementHeader({
  active,
}: EnvManagementHeaderProps) {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();

  const switchTo = (tab: EnvManagementTab) => {
    if (tab === active) return;
    const next = new URLSearchParams(searchParams.toString());
    if (tab === 'environments') {
      // Default tab — drop the param so the URL stays short.
      next.delete('tab');
    } else {
      next.set('tab', tab);
    }
    const qs = next.toString();
    router.replace(qs ? `/environments?${qs}` : '/environments');
  };

  return (
    <div className="flex items-center gap-1 px-3 h-11 shrink-0 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      {/* Leading: ← Home */}
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-[0.75rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] no-underline transition-colors px-2 py-1 rounded hover:bg-[hsl(var(--accent))]"
      >
        <ArrowLeft size={13} />
        {t('envManagement.backToHome')}
      </Link>

      <div className="w-px h-4 bg-[hsl(var(--border))] mx-1" />

      {/* Tabs */}
      <nav className="flex items-center gap-0.5">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.id === active;
          const label =
            t(`envManagement.topTabs.${tab.key}`) || tab.fallbackLabel;
          const hint =
            t(`envManagement.topTabs.${tab.key}Hint`) || tab.fallbackHint;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => switchTo(tab.id)}
              title={hint}
              aria-current={isActive ? 'page' : undefined}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[0.8125rem] transition-colors ${
                isActive
                  ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/40 font-semibold'
                  : 'text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]/60 border border-transparent'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
