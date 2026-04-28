'use client';

/**
 * Stage09ParseEditor — curated editor for s09_parse.
 *
 * Two slot pickers: parser (default / structured_output) +
 * signal_detector (regex / structured / hybrid). Inline config:
 *   structured_output → schema (JSON object editor; validated on blur)
 */

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { catalogApi } from '@/lib/environmentApi';
import { localizeIntrospection } from '../stage_locale';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type {
  StageIntrospection,
  StageManifestEntry,
} from '@/types/environment';
import { Textarea } from '@/components/ui/textarea';
import {
  InlinePanel,
  TilePicker,
  readSlotConfig,
  type TileOption,
} from './_CuratedHelpers';

const PARSER_OPTIONS: TileOption[] = [
  { id: 'default', titleKey: 'envManagement.stage09.parser.default.title', descKey: 'envManagement.stage09.parser.default.desc' },
  { id: 'structured_output', titleKey: 'envManagement.stage09.parser.structured.title', descKey: 'envManagement.stage09.parser.structured.desc' },
];

const SIGNAL_OPTIONS: TileOption[] = [
  { id: 'regex', titleKey: 'envManagement.stage09.signal.regex.title', descKey: 'envManagement.stage09.signal.regex.desc' },
  { id: 'structured', titleKey: 'envManagement.stage09.signal.structured.title', descKey: 'envManagement.stage09.signal.structured.desc' },
  { id: 'hybrid', titleKey: 'envManagement.stage09.signal.hybrid.title', descKey: 'envManagement.stage09.signal.hybrid.desc' },
];

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function Stage09ParseEditor({ order, entry }: Props) {
  const { t } = useI18n();
  const locale = useI18n((s) => s.locale);
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const [intro, setIntro] = useState<StageIntrospection | null>(null);

  useEffect(() => {
    let cancelled = false;
    catalogApi
      .stage(order)
      .then((res) => !cancelled && setIntro(localizeIntrospection(res, locale)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [order, locale]);

  const parserAvail = new Set(intro?.strategy_slots?.['parser']?.available_impls ?? PARSER_OPTIONS.map((o) => o.id));
  const sigAvail = new Set(intro?.strategy_slots?.['signal_detector']?.available_impls ?? SIGNAL_OPTIONS.map((o) => o.id));

  const currentParser = entry.strategies?.['parser'] ?? intro?.strategy_slots?.['parser']?.current_impl ?? 'default';
  const currentSig = entry.strategies?.['signal_detector'] ?? intro?.strategy_slots?.['signal_detector']?.current_impl ?? 'regex';

  const setSlot = (slot: string, id: string) =>
    patchStage(order, { strategies: { ...(entry.strategies ?? {}), [slot]: id } });

  // structured_output schema
  const parserConfig = readSlotConfig(entry, 'parser');
  const patchParserConfig = (next: Record<string, unknown>) =>
    patchStage(order, {
      strategy_configs: { ...(entry.strategy_configs ?? {}), parser: next },
    });

  const schemaObj =
    parserConfig.schema && typeof parserConfig.schema === 'object'
      ? (parserConfig.schema as Record<string, unknown>)
      : null;
  const [schemaText, setSchemaText] = useState(() =>
    schemaObj ? JSON.stringify(schemaObj, null, 2) : '',
  );
  const [schemaError, setSchemaError] = useState<string | null>(null);

  useEffect(() => {
    setSchemaText(schemaObj ? JSON.stringify(schemaObj, null, 2) : '');
    setSchemaError(null);
  }, [JSON.stringify(schemaObj)]);

  const commitSchema = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setSchemaError(null);
      patchParserConfig({ ...parserConfig, schema: null });
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setSchemaError(t('envManagement.stage09.config.structured.errorObject'));
        return;
      }
      setSchemaError(null);
      patchParserConfig({ ...parserConfig, schema: parsed });
    } catch (e) {
      setSchemaError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <TilePicker
        titleKey="envManagement.stage09.parserTitle"
        hintKey="envManagement.stage09.parserHint"
        helpId="stage09.parser"
        options={PARSER_OPTIONS}
        available={parserAvail}
        current={currentParser}
        onPick={(id) => setSlot('parser', id)}
        cols={2}
      >
        {currentParser === 'structured_output' && (
          <InlinePanel>
            <label className="text-[0.75rem] font-medium text-[hsl(var(--foreground))]">
              {t('envManagement.stage09.config.structured.schema')}
            </label>
            <p className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">
              {t('envManagement.stage09.config.structured.schemaHint')}
            </p>
            <Textarea
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
              onBlur={(e) => commitSchema(e.target.value)}
              rows={8}
              className="font-mono text-[0.75rem] leading-relaxed resize-y"
              spellCheck={false}
              placeholder='{\n  "type": "object",\n  "properties": { "answer": { "type": "string" } },\n  "required": ["answer"]\n}'
            />
            {schemaError && (
              <p className="text-[0.6875rem] text-red-600 dark:text-red-400">
                {schemaError}
              </p>
            )}
          </InlinePanel>
        )}
      </TilePicker>

      <TilePicker
        titleKey="envManagement.stage09.signalTitle"
        hintKey="envManagement.stage09.signalHint"
        helpId="stage09.signal"
        options={SIGNAL_OPTIONS}
        available={sigAvail}
        current={currentSig}
        onPick={(id) => setSlot('signal_detector', id)}
        cols={3}
      />

    </div>
  );
}
