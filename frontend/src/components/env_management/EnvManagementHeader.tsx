'use client';

/**
 * EnvManagementHeader — single-row navigation chrome for /environments.
 *
 * Cycle 20260429 follow-up — replaced the always-visible 5-tab strip
 * with a single dropdown switcher button. Click the current-tab
 * button → a 5-option panel pops in (spring/bounce animation) below
 * → pick one → router.replace to that tab. The dropdown always
 * shows where you ARE (current tab in the trigger) and where you
 * could GO (the 5 options). One row, no double-header competition
 * with CompactMetaBar.
 *
 * Behaviour:
 *   - Click trigger → toggle dropdown
 *   - Click an option → navigate via `?tab=`, close dropdown
 *   - Click outside dropdown → close
 *   - Escape → close
 *
 * Visual: the trigger looks like a regular tab button when closed
 * (matches the operator's mental model of "I'm on this tab"); the
 * dropdown panel uses `animate-dropdown-pop` (defined in globals.css)
 * for the spring effect — Quart-Out cubic-bezier with overshoot, so
 * it pops out then settles instead of fading flatly in.
 *
 * URL state: `?tab=...` (unchanged from Phase 2). Default tab
 * (`environments`) drops the param so the canonical URL stays
 * `/environments`.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Boxes,
  Layers,
  Network,
  Plug,
  Shield,
  Sparkles,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import Selector, { type SelectorItem } from '@/components/ui/Selector';

export type EnvManagementTab =
  | 'environments'
  | 'mcp'
  | 'skills'
  | 'custom_tools'
  | 'sandbox_packs'
  | 'hooks'
  | 'permissions'
  | 'triggers';

const TAB_ORDER: EnvManagementTab[] = [
  'environments',
  'mcp',
  'skills',
  'custom_tools',
  'sandbox_packs',
  'hooks',
  'permissions',
  'triggers',
];

interface TabDef {
  id: EnvManagementTab;
  icon: LucideIcon;
  fallbackLabel: string;
  fallbackHint: string;
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
    id: 'custom_tools',
    icon: Wrench,
    fallbackLabel: '커스텀 도구',
    fallbackHint: 'DB 등록된 사용자 도구 (HTTP / MCP 프록시 / 별칭)',
    key: 'custom_tools',
  },
  {
    id: 'sandbox_packs',
    icon: Boxes,
    fallbackLabel: 'Sandbox Tool Packs',
    fallbackHint: '샌드박스에서 만든 도구 팩 — 환경에 포함',
    key: 'sandbox_packs',
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
  {
    id: 'triggers',
    icon: Zap,
    fallbackLabel: '트리거 관리',
    fallbackHint: 'VTuber 자가 발화 프리셋 관리',
    key: 'triggers',
  },
];

export function parseTab(value: string | null | undefined): EnvManagementTab {
  if (value && (TAB_ORDER as string[]).includes(value)) {
    return value as EnvManagementTab;
  }
  return 'environments';
}

// ── Standalone dropdown switcher ────────────────────────────────

export interface TabSwitcherDropdownProps {
  active: EnvManagementTab;
}

/**
 * The bare dropdown switcher. Renders just the trigger + popover —
 * caller embeds it in whatever row chrome they own (CompactMetaBar
 * uses it on the leading edge).
 */
export function TabSwitcherDropdown({ active }: TabSwitcherDropdownProps) {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();

  const switchTo = (tab: EnvManagementTab) => {
    if (tab === active) return;
    const next = new URLSearchParams(searchParams.toString());
    if (tab === 'environments') {
      next.delete('tab');
    } else {
      next.set('tab', tab);
    }
    const qs = next.toString();
    router.replace(qs ? `/environments?${qs}` : '/environments');
  };

  const items: SelectorItem<EnvManagementTab>[] = TABS.map((tab) => ({
    id: tab.id,
    icon: tab.icon,
    label: t(`envManagement.topTabs.${tab.key}`) || tab.fallbackLabel,
    description: t(`envManagement.topTabs.${tab.key}Hint`) || tab.fallbackHint,
  }));

  return (
    <Selector
      items={items}
      value={active}
      onChange={switchTo}
      ariaLabel={t('envManagement.backToHome')}
      minWidthPx={224}
    />
  );
}

// ── Backwards-compat default export ──────────────────────────────

/**
 * Legacy `EnvManagementHeader` — kept as a thin wrapper that
 * renders just the leading nav cluster (← 홈으로 + dropdown
 * switcher) on its own bordered row. Used on the FIRST screen
 * (env overview, no draft). When a draft is loaded or a host
 * registry tab is active, `CompactMetaBar` embeds the
 * `TabSwitcherDropdown` directly instead, so the chrome stays
 * one row.
 */
export interface EnvManagementHeaderProps {
  active: EnvManagementTab;
}

export default function EnvManagementHeader({
  active,
}: EnvManagementHeaderProps) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-[0.75rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] no-underline transition-colors px-2 py-1 rounded hover:bg-[hsl(var(--accent))]"
      >
        <ArrowLeft size={13} />
        {t('envManagement.backToHome')}
      </Link>
      <div className="w-px h-4 bg-[hsl(var(--border))] mx-1" />
      <TabSwitcherDropdown active={active} />
    </div>
  );
}
