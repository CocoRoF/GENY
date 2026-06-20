'use client';

/**
 * ToolSettingsPicker — schema-driven per-environment tool configuration.
 *
 * Renders one card per tool schema fetched from
 * `GET /api/tool-settings/schemas` (currently only `web_search`). Each
 * schema's fields share the exact shape of the global-settings `ConfigField`,
 * so they reuse the existing `ConfigFieldInput` + localization helpers from
 * `SettingsTab`.
 *
 * Values are NOT persisted via a dedicated endpoint — they live on the
 * environment manifest draft at
 *   `host_selections.extras.tool_settings[<schema.key>]`
 * (the same `extras` mechanism as `owned_subagent` / `subworker_types`) and
 * ride the normal manifest save. Writes go through the store's
 * `setToolSetting` action, which prunes empty entries.
 *
 * Because the source is the schema list, new tools the backend adds appear
 * here automatically with no frontend change.
 */

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, X } from 'lucide-react';
import { toolSettingsApi } from '@/lib/api';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import { useI18n } from '@/lib/i18n';
import MarkdownRenderer from '@/components/file-viewer/MarkdownRenderer';
import {
  ConfigFieldInput,
  getLocalizedField,
  getLocalizedSchema,
} from '@/components/tabs/SettingsTab';
import type { ConfigSchema, ConfigField, ToolSettingSchema } from '@/types';

/**
 * Build the values object that should be persisted for a schema. Drops any
 * field whose value is empty or equal to its default, so a card the user
 * never touched (or reset) leaves no `tool_settings` entry behind.
 */
function nonDefaultValues(
  schema: ToolSettingSchema,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const v = values[field.name];
    const isEmpty =
      v === undefined ||
      v === null ||
      v === '' ||
      (Array.isArray(v) && v.length === 0);
    if (isEmpty) continue;
    if (field.default !== undefined && v === field.default) continue;
    out[field.name] = v;
  }
  return out;
}

export default function ToolSettingsPicker() {
  const { t, locale } = useI18n();
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const setToolSetting = useEnvironmentDraftStore((s) => s.setToolSetting);

  const [schemas, setSchemas] = useState<ToolSettingSchema[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [guideKey, setGuideKey] = useState<string | null>(null);

  useEffect(() => {
    // Runs once on mount (empty deps) — initial state is already
    // { loading: true, error: null }, so no synchronous setState here.
    let alive = true;
    toolSettingsApi
      .getSchemas()
      .then((list) => {
        if (alive) setSchemas(list);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Stored values per schema key, read straight from the draft.
  const stored = useMemo(
    () =>
      (draft?.host_selections?.extras?.tool_settings as
        | Record<string, Record<string, unknown>>
        | undefined) ?? {},
    [draft],
  );

  const guideSchema = schemas.find((s) => s.key === guideKey) ?? null;

  if (loading) {
    return (
      <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))]">
        {locale === 'ko' ? '불러오는 중…' : 'Loading…'}
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-[0.75rem] text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  }

  if (schemas.length === 0) {
    return (
      <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))]">
        {locale === 'ko'
          ? '구성 가능한 도구가 없습니다.'
          : 'No configurable tools.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {schemas.map((schema) => {
        // The localization helpers only read `i18n` / `display_name` /
        // `description` / `fields[].name`, all of which this schema has, so
        // the structurally-compatible cast is safe.
        const asConfig = schema as unknown as ConfigSchema;
        const ls = getLocalizedSchema(asConfig, locale);
        const current = stored[schema.key] ?? {};

        const onFieldChange = (fieldName: string, value: unknown) => {
          const merged: Record<string, unknown> = { ...current, [fieldName]: value };
          const next = nonDefaultValues(schema, merged);
          // Pass null when nothing differs from defaults so the entry (and the
          // empty `extras` container) is dropped by the store action.
          setToolSetting(schema.key, Object.keys(next).length > 0 ? next : null);
        };

        return (
          <div
            key={schema.key}
            className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 flex flex-col gap-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5 min-w-0">
                <h4 className="text-[0.875rem] font-semibold text-[hsl(var(--foreground))]">
                  {ls.display_name}
                </h4>
                {ls.description && (
                  <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] leading-relaxed">
                    {ls.description}
                  </p>
                )}
              </div>
              {schema.setup_guide && (
                <button
                  type="button"
                  onClick={() => setGuideKey(schema.key)}
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors shrink-0"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  {locale === 'ko' ? '설정 방법' : 'Setup guide'}
                </button>
              )}
            </div>

            <div className="flex flex-col gap-4">
              {schema.fields.map((field: ConfigField) => {
                const value = current[field.name] ?? field.default ?? '';
                const lf = getLocalizedField(field, asConfig, locale);
                return (
                  <ConfigFieldInput
                    key={field.name}
                    field={field}
                    value={value}
                    onChange={(v) => onFieldChange(field.name, v)}
                    allValues={current}
                    allFields={schema.fields}
                    onChangeField={onFieldChange}
                    localizedLabel={lf.label}
                    localizedDescription={lf.description}
                    localizedPlaceholder={lf.placeholder}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Setup guide modal (Markdown) — mirrors SettingsTab's guide modal. */}
      {guideSchema?.setup_guide && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setGuideKey(null)}
        >
          <div
            className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg w-full max-w-[760px] mx-4 max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center py-4 px-6 border-b border-[hsl(var(--border))]">
              <h3 className="flex items-center gap-2 text-[1rem] font-semibold text-[hsl(var(--foreground))]">
                <BookOpen size={16} />{' '}
                {getLocalizedSchema(guideSchema as unknown as ConfigSchema, locale).display_name}{' '}
                · {locale === 'ko' ? '설정 방법' : 'Setup guide'}
              </h3>
              <button
                type="button"
                className="flex items-center justify-center w-8 h-8 rounded-md bg-transparent border-none text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] cursor-pointer"
                onClick={() => setGuideKey(null)}
                aria-label={t('common.cancel')}
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <MarkdownRenderer
                content={
                  guideSchema.setup_guide[locale] ||
                  guideSchema.setup_guide.ko ||
                  guideSchema.setup_guide.en ||
                  Object.values(guideSchema.setup_guide)[0] ||
                  ''
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
