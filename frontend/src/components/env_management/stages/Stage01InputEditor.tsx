'use client';

/**
 * Stage01InputEditor — curated editor for s01_input.
 *
 * Stage 1 owns input VALIDATION and NORMALIZATION — not system prompt
 * (that belongs to Stage 3, see Stage03SystemEditor). The earlier
 * version of this editor mis-placed a system prompt textarea here;
 * removed in cycle 20260427_3 once the contract was double-checked
 * against geny-executor's stages/s01_input/strategy.py.
 *
 * Stage 1 strategy slots:
 *   - Validator (DefaultValidator / PassthroughValidator /
 *     StrictValidator / SchemaValidator)
 *   - Normalizer (DefaultNormalizer / MultimodalNormalizer)
 *
 * Both pickers are presented as friendly tile choices; everything
 * else (artifact / chains / raw config) lives under Advanced.
 */

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { catalogApi } from '@/lib/environmentApi';
import { localizeIntrospection } from '../stage_locale';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type {
  StageIntrospection,
  StageManifestEntry,
} from '@/types/environment';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import SectionHelpButton from '../section_help/SectionHelpButton';
import StageGenericEditor from '../StageGenericEditor';

// Friendly choice tiles for the two main slot picks. The catalog is
// the source of truth for "is this option available in the current
// build" — anything not in catalog.available_impls is greyed out.
// Tile ids must match geny-executor's registered impl keys exactly:
//   validator slot registry: default | passthrough | strict | schema
//   normalizer slot registry: default | multimodal
// (Class names like "DefaultValidator" are NOT what catalog.available_impls
// returns; using them silently disables every tile because the Set lookup
// misses.)
const VALIDATOR_OPTIONS = [
  {
    id: 'default',
    titleKey: 'envManagement.stage01.validator.default.title',
    descKey: 'envManagement.stage01.validator.default.desc',
  },
  {
    id: 'passthrough',
    titleKey: 'envManagement.stage01.validator.passthrough.title',
    descKey: 'envManagement.stage01.validator.passthrough.desc',
  },
  {
    id: 'strict',
    titleKey: 'envManagement.stage01.validator.strict.title',
    descKey: 'envManagement.stage01.validator.strict.desc',
  },
  {
    id: 'schema',
    titleKey: 'envManagement.stage01.validator.schema.title',
    descKey: 'envManagement.stage01.validator.schema.desc',
  },
];

const NORMALIZER_OPTIONS = [
  {
    id: 'default',
    titleKey: 'envManagement.stage01.normalizer.default.title',
    descKey: 'envManagement.stage01.normalizer.default.desc',
  },
  {
    id: 'multimodal',
    titleKey: 'envManagement.stage01.normalizer.multimodal.title',
    descKey: 'envManagement.stage01.normalizer.multimodal.desc',
  },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage01InputEditor({ order, entry }: Props) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);

  const [intro, setIntro] = useState<StageIntrospection | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    catalogApi
      .stage(order)
      .then((res) => {
        if (!cancelled) setIntro(localizeIntrospection(res, locale));
      })
      .catch(() => {
        /* falls back gracefully — every option just shows enabled */
      });
    return () => {
      cancelled = true;
    };
  }, [order, locale]);

  const availableValidator = new Set(
    intro?.strategy_slots?.['validator']?.available_impls ??
      VALIDATOR_OPTIONS.map((o) => o.id),
  );
  const availableNormalizer = new Set(
    intro?.strategy_slots?.['normalizer']?.available_impls ??
      NORMALIZER_OPTIONS.map((o) => o.id),
  );

  const currentValidator =
    entry.strategies?.['validator'] ??
    intro?.strategy_slots?.['validator']?.current_impl ??
    'default';
  const currentNormalizer =
    entry.strategies?.['normalizer'] ??
    intro?.strategy_slots?.['normalizer']?.current_impl ??
    'default';

  const setValidator = (id: string) =>
    patchStage(order, {
      strategies: { ...(entry.strategies ?? {}), validator: id },
    });
  const setNormalizer = (id: string) =>
    patchStage(order, {
      strategies: { ...(entry.strategies ?? {}), normalizer: id },
    });

  // strategy_configs.validator — only `strict` and `schema` actually read it.
  const validatorConfig =
    (entry.strategy_configs?.['validator'] as Record<string, unknown> | undefined) ??
    {};
  const patchValidatorConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: {
        ...(entry.strategy_configs ?? {}),
        validator: next,
      },
    });

  // ── Strict — blocked_patterns list ──
  const blockedPatterns = Array.isArray(validatorConfig.blocked_patterns)
    ? (validatorConfig.blocked_patterns as string[])
    : [];
  const setBlockedPatterns = (next: string[]) =>
    patchValidatorConfig({ ...validatorConfig, blocked_patterns: next });

  // ── Schema — JSON schema dict (string in textarea, parsed on blur) ──
  const schemaObj =
    validatorConfig.schema && typeof validatorConfig.schema === 'object'
      ? (validatorConfig.schema as Record<string, unknown>)
      : null;
  const [schemaText, setSchemaText] = useState(() =>
    schemaObj ? JSON.stringify(schemaObj, null, 2) : '',
  );
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // Re-sync the textarea when the entry's schema changes from outside this
  // component (e.g., switching environments while a draft is open).
  useEffect(() => {
    setSchemaText(schemaObj ? JSON.stringify(schemaObj, null, 2) : '');
    setSchemaError(null);
  }, [JSON.stringify(schemaObj)]);

  const commitSchema = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setSchemaError(null);
      patchValidatorConfig({ ...validatorConfig, schema: {} });
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setSchemaError(t('envManagement.stage01.schema.errorObject'));
        return;
      }
      setSchemaError(null);
      patchValidatorConfig({ ...validatorConfig, schema: parsed });
    } catch (e) {
      setSchemaError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* ── Validator ── */}
      <section className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <header className="flex items-center gap-2">
          <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
            {t('envManagement.stage01.validatorTitle')}
          </h4>
          <SectionHelpButton helpId="stage01.validator" />
        </header>
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          {t('envManagement.stage01.validatorHint')}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {VALIDATOR_OPTIONS.map((opt) => {
            const available = availableValidator.has(opt.id);
            const active = currentValidator === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={!available}
                onClick={() => setValidator(opt.id)}
                className={`flex items-start gap-2 p-2.5 rounded-md border text-left transition-colors ${
                  active
                    ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]'
                    : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))]'
                } ${!available ? 'opacity-40 cursor-not-allowed' : ''}`}
                title={!available ? t('envManagement.stage01.unavailable') : undefined}
              >
                <div className="min-w-0">
                  <div className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
                    {t(opt.titleKey)}
                  </div>
                  <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mt-0.5">
                    {t(opt.descKey)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Strict — inline blocked_patterns list */}
        {currentValidator === 'strict' && (
          <BlockedPatternsList
            patterns={blockedPatterns}
            onChange={setBlockedPatterns}
          />
        )}

        {/* Schema — inline JSON Schema editor */}
        {currentValidator === 'schema' && (
          <div className="flex flex-col gap-1.5 pt-3 mt-1 border-t border-[hsl(var(--border))]">
            <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
              {t('envManagement.stage01.schema.label')}
            </label>
            <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
              {t('envManagement.stage01.schema.hint')}
            </p>
            <Textarea
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
              onBlur={(e) => commitSchema(e.target.value)}
              placeholder='{\n  "type": "object",\n  "required": ["query"]\n}'
              rows={8}
              className="font-mono text-[0.75rem] leading-relaxed resize-y"
              spellCheck={false}
            />
            {schemaError && (
              <p className="text-[0.6875rem] text-red-600 dark:text-red-400">
                {schemaError}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── Normalizer ── */}
      <section className="flex flex-col gap-2 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <header className="flex items-center gap-2">
          <h4 className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
            {t('envManagement.stage01.normalizerTitle')}
          </h4>
          <SectionHelpButton helpId="stage01.normalizer" />
        </header>
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
          {t('envManagement.stage01.normalizerHint')}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {NORMALIZER_OPTIONS.map((opt) => {
            const available = availableNormalizer.has(opt.id);
            const active = currentNormalizer === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={!available}
                onClick={() => setNormalizer(opt.id)}
                className={`flex items-start gap-2 p-2.5 rounded-md border text-left transition-colors ${
                  active
                    ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]'
                    : 'border-[hsl(var(--border))] bg-[hsl(var(--background))] hover:bg-[hsl(var(--accent))]'
                } ${!available ? 'opacity-40 cursor-not-allowed' : ''}`}
                title={!available ? t('envManagement.stage01.unavailable') : undefined}
              >
                <div className="min-w-0">
                  <div className="text-[0.8125rem] font-medium text-[hsl(var(--foreground))]">
                    {t(opt.titleKey)}
                  </div>
                  <div className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] mt-0.5">
                    {t(opt.descKey)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Advanced ── */}
      <section className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-[0.8125rem] font-semibold text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors text-left"
        >
          {advancedOpen ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          {t('envManagement.stage01.advancedTitle')}
          <span className="text-[0.6875rem] font-normal text-[hsl(var(--muted-foreground))]">
            {t('envManagement.stage01.advancedHint')}
          </span>
        </button>
        {advancedOpen && (
          <div className="px-3 pb-3 border-t border-[hsl(var(--border))] pt-3">
            <StageGenericEditor order={order} entry={entry} />
          </div>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

interface BlockedPatternsListProps {
  patterns: string[];
  onChange: (next: string[]) => void;
}

function BlockedPatternsList({ patterns, onChange }: BlockedPatternsListProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');

  const add = () => {
    const v = draft.trim();
    if (!v || patterns.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...patterns, v]);
    setDraft('');
  };
  const removeAt = (idx: number) =>
    onChange(patterns.filter((_, i) => i !== idx));

  return (
    <div className="flex flex-col gap-1.5 pt-3 mt-1 border-t border-[hsl(var(--border))]">
      <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
        {t('envManagement.stage01.blockedPatterns.label')}
      </label>
      <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
        {t('envManagement.stage01.blockedPatterns.hint')}
      </p>

      {patterns.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 mt-1">
          {patterns.map((p, idx) => (
            <li
              key={`${p}-${idx}`}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-[hsl(var(--accent))] border border-[hsl(var(--border))]"
            >
              <code className="text-[0.7rem] font-mono text-[hsl(var(--foreground))]">
                {p}
              </code>
              <button
                type="button"
                onClick={() => removeAt(idx)}
                className="w-4 h-4 inline-flex items-center justify-center rounded hover:bg-[hsl(var(--destructive)/0.15)] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] transition-colors"
                aria-label={t('common.delete')}
              >
                <X className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1.5 mt-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={t('envManagement.stage01.blockedPatterns.placeholder')}
          className="h-7 text-[0.75rem] flex-1"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="h-7 px-2 inline-flex items-center gap-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.7rem] font-medium text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Plus className="w-3 h-3" />
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}
