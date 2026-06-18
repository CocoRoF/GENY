'use client';

import Image from 'next/image';
import { useI18n } from '@/lib/i18n';
import Sparkle from '@/components/ui/Sparkle';
import {
  Rocket,
  Layers,
  Workflow,
  Brain,
  Zap,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

type SectionItem = { title: string; body: string | string[] };

// Section icons cycle through this set so every card gets a distinct
// gradient tile glyph regardless of how many sections the locale ships.
const SECTION_ICONS: LucideIcon[] = [
  Rocket,
  Layers,
  Workflow,
  Brain,
  Zap,
  ShieldCheck,
];

export default function MainTab() {
  const { t, tRaw } = useI18n();

  const sections = tRaw<SectionItem[]>('main.sections');
  const tips = tRaw<string[]>('main.tips');

  return (
    <div className="flex-1 overflow-y-auto">
      {/* ── Hero ──────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="geny-hero-wash absolute inset-0 pointer-events-none" />
        {/* Floating sparkles */}
        <Sparkle
          size={22}
          className="geny-sparkle absolute top-[18%] right-[14%] pointer-events-none hidden sm:block"
        />
        <Sparkle
          size={13}
          className="geny-sparkle absolute top-[42%] right-[26%] pointer-events-none hidden sm:block"
          style={{ animationDelay: '1.2s' }}
        />
        <Sparkle
          size={16}
          className="geny-sparkle absolute top-[30%] left-[12%] pointer-events-none hidden md:block"
          style={{ animationDelay: '2.1s' }}
        />

        <div className="relative max-w-[1080px] mx-auto px-4 md:px-6 pt-12 md:pt-16 pb-10 text-center">
          <div className="flex justify-center mb-6">
            <Image
              src="/geny_full_logo_middle.png"
              alt="Geny"
              width={300}
              height={114}
              priority
              className="object-contain max-w-[240px] md:max-w-[280px] h-auto"
            />
          </div>

          <div className="inline-flex items-center gap-2 geny-eyebrow mb-5">
            <Sparkle size={11} style={{ color: 'var(--primary-color)' }} />
            <span>
              <span className="accent">Geny</span> · Execute, Not You
            </span>
          </div>

          <h1 className="text-3xl md:text-5xl font-extrabold leading-[1.1] tracking-tight text-[var(--text-primary)] mb-4">
            {t('main.heroTitle')}
          </h1>
          <p className="text-base md:text-xl font-semibold geny-gradient-text mb-4">
            {t('main.heroSubtitle')}
          </p>
          <p className="text-sm md:text-base text-[var(--text-secondary)] leading-relaxed max-w-[620px] mx-auto">
            {t('main.heroTagline')}
          </p>
        </div>
      </section>

      {/* ── Body ──────────────────────────────────────────── */}
      <div className="max-w-[1080px] mx-auto px-4 md:px-6 pb-16">
        {/* Sections — card grid with gradient icon tiles */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
          {sections.map((section, i) => {
            const Icon = SECTION_ICONS[i % SECTION_ICONS.length];
            return (
              <section key={i} className="geny-card p-5 md:p-6">
                <div className="flex items-center gap-3 mb-4">
                  <span className="geny-icon-tile w-10 h-10 shrink-0">
                    <Icon size={18} />
                  </span>
                  <h2 className="text-base md:text-[1.05rem] font-bold text-[var(--text-primary)] leading-snug">
                    {section.title}
                  </h2>
                </div>
                <div className="flex flex-col gap-2">
                  {(Array.isArray(section.body) ? section.body : [section.body]).map(
                    (line, j) => (
                      <p
                        key={j}
                        className="text-[0.8125rem] text-[var(--text-secondary)] leading-[1.7]"
                      >
                        {line}
                      </p>
                    ),
                  )}
                </div>
              </section>
            );
          })}
        </div>

        {/* Tips — accent card */}
        <section
          className="geny-card mt-5 p-5 md:p-6 relative overflow-hidden"
          style={{
            background:
              'linear-gradient(135deg, var(--primary-subtle), transparent 70%)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <Sparkle
            size={64}
            className="absolute -top-4 -right-4 opacity-[0.06] pointer-events-none"
            style={{ color: 'var(--primary-color)' }}
          />
          <div className="flex items-center gap-2.5 mb-4 relative">
            <span className="geny-icon-tile w-9 h-9 shrink-0">
              <Sparkle size={15} />
            </span>
            <h2 className="text-base md:text-[1.05rem] font-bold text-[var(--text-primary)]">
              {t('main.tipTitle')}
            </h2>
          </div>
          <ul className="flex flex-col gap-2 list-none p-0 m-0 relative">
            {tips.map((tip, i) => (
              <li
                key={i}
                className="text-[0.8125rem] text-[var(--text-secondary)] leading-[1.7] pl-5 relative"
              >
                <span className="absolute left-0 top-[2px] text-[var(--primary-color)]">
                  <Sparkle size={10} />
                </span>
                {tip}
              </li>
            ))}
          </ul>
        </section>

        {/* Footer */}
        <p className="text-center text-xs text-[var(--text-muted)] mt-10">
          {t('main.footerNote')}
        </p>
      </div>
    </div>
  );
}
