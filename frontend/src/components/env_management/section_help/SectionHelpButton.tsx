'use client';

/**
 * SectionHelpButton — the "?" icon that lives in the header of every
 * curated section. Clicking it opens SectionHelpModal targeted at the
 * help blob registered under `helpId`.
 *
 * Render this inline next to the section title, e.g.:
 *   <header className="flex items-center gap-2">
 *     <h4>...</h4>
 *     <SectionHelpButton helpId="stage01.validator" />
 *   </header>
 *
 * If the help blob isn't registered yet, the button is hidden so we
 * don't surface dead chrome before content is written.
 */

import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { hasSectionHelp } from './content';
import SectionHelpModal from './SectionHelpModal';

interface SectionHelpButtonProps {
  helpId: string;
}

export default function SectionHelpButton({ helpId }: SectionHelpButtonProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  if (!hasSectionHelp(helpId)) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('envManagement.sectionHelp.openTip')}
        aria-label={t('envManagement.sectionHelp.openTip')}
        className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))] transition-colors shrink-0"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
      <SectionHelpModal
        open={open}
        helpId={helpId}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
