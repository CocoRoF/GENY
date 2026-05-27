'use client';

import { useI18n } from '@/lib/i18n';

interface InstructPanelProps {
  value: string;
  onChange: (s: string) => void;
  /** When false, the panel renders read-only / dimmed (mode != design). */
  enabled?: boolean;
}

const PRESET_KEYS = ['warm', 'cold', 'young', 'old', 'energetic', 'calm'] as const;

/** Map of preset key → short English clause appended to the instruct field. */
const PRESET_SNIPPETS: Record<typeof PRESET_KEYS[number], string> = {
  warm: 'warm',
  cold: 'cold and distant',
  young: 'young adult',
  old: 'elderly',
  energetic: 'energetic',
  calm: 'calm and steady',
};

/**
 * Voice Design instruct input. OmniVoice's design mode reads an English
 * attribute string ("female, low pitch, british accent"). The presets
 * are short, composable, English-only by design — the k2-fsa training
 * corpus skews English for the instruct channel.
 */
export default function InstructPanel({ value, onChange, enabled = true }: InstructPanelProps) {
  const { t } = useI18n();

  const apply = (snippet: string) => {
    if (!enabled) return;
    const trimmed = value.trim();
    const next = trimmed ? `${trimmed}, ${snippet}` : snippet;
    onChange(next);
  };

  return (
    <div className={`rounded-lg border p-3 ${
      enabled
        ? 'border-[var(--border-color)] bg-[var(--bg-secondary)]'
        : 'border-[var(--border-color)] bg-[var(--bg-secondary)] opacity-60'
    }`}>
      <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-1">
        {t('voiceStudio.cloneDesign.instruct.label')}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!enabled}
        placeholder={t('voiceStudio.cloneDesign.instruct.placeholder')}
        rows={2}
        className="w-full px-2.5 py-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.8125rem] outline-none focus:border-[var(--primary-color)] resize-none disabled:cursor-not-allowed"
      />
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        <span className="text-[0.6875rem] text-[var(--text-muted)] mr-1">
          {t('voiceStudio.cloneDesign.instruct.presetsLabel')}
        </span>
        {PRESET_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => apply(PRESET_SNIPPETS[key])}
            disabled={!enabled}
            className="px-2 py-0.5 rounded-md text-[0.6875rem] bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t(`voiceStudio.cloneDesign.instruct.preset.${key}`)}
          </button>
        ))}
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            disabled={!enabled}
            className="ml-auto text-[0.6875rem] text-[var(--text-muted)] hover:text-[var(--danger-color)] bg-transparent border-none cursor-pointer transition-colors disabled:cursor-not-allowed"
          >
            {t('voiceStudio.cloneDesign.instruct.clear')}
          </button>
        )}
      </div>
    </div>
  );
}
