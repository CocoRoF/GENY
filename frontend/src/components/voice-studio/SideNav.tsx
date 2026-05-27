'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, AudioLines, Library, ListChecks, Wrench, Settings } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

const NAV_ITEMS = [
  { href: '/voice-studio/clone-design', key: 'cloneDesign', Icon: AudioLines },
  { href: '/voice-studio/voices',       key: 'voices',      Icon: Library },
  { href: '/voice-studio/batch',        key: 'batch',       Icon: ListChecks },
  { href: '/voice-studio/tools',        key: 'tools',       Icon: Wrench },
  { href: '/voice-studio/settings',     key: 'settings',    Icon: Settings },
] as const;

export default function SideNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  return (
    <aside className="w-56 shrink-0 border-r border-[var(--border-color)] bg-[var(--bg-secondary)] flex flex-col">
      <div className="flex items-center h-14 px-4 border-b border-[var(--border-color)]">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-[0.8125rem] text-[var(--text-muted)] hover:text-[var(--text-primary)] no-underline transition-colors"
        >
          <ArrowLeft size={14} />
          {t('voiceStudio.backToApp')}
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_ITEMS.map(({ href, key, Icon }) => {
          const active = pathname === href || (pathname?.startsWith(href + '/') ?? false);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-2 px-4 py-2.5 text-[0.8125rem] border-l-2 no-underline transition-colors duration-100 ${
                active
                  ? 'bg-[var(--primary-subtle)] text-[var(--primary-color)] border-[var(--primary-color)] font-medium'
                  : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Icon size={14} className="shrink-0 opacity-80" />
              <span className="truncate">{t(`voiceStudio.nav.${key}`)}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
