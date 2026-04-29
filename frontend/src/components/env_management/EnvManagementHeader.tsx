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

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ChevronDown,
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
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const activeDef = TABS.find((tt) => tt.id === active) ?? TABS[0];
  const ActiveIcon = activeDef.icon;
  const activeLabel =
    t(`envManagement.topTabs.${activeDef.key}`) || activeDef.fallbackLabel;

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const switchTo = (tab: EnvManagementTab) => {
    setOpen(false);
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

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[0.8125rem] font-semibold border transition-colors ${
          open
            ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/40'
            : 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30 hover:bg-violet-500/15'
        }`}
      >
        <ActiveIcon size={13} />
        {activeLabel}
        <ChevronDown
          size={13}
          className={`transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="animate-dropdown-pop absolute left-0 top-full mt-1 z-40 min-w-[200px] py-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-lg"
        >
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
                role="menuitem"
                onClick={() => switchTo(tab.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                  isActive
                    ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300 font-semibold'
                    : 'text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]'
                }`}
              >
                <Icon size={13} className="mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[0.8125rem] font-medium">{label}</div>
                  <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] leading-snug">
                    {hint}
                  </div>
                </div>
                {isActive && (
                  <span
                    className="mt-1 w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
