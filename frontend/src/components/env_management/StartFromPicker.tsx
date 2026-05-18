'use client';

/**
 * StartFromPicker — welcome-state picker that lets the user start a
 * draft from one of three places:
 *   - blank (existing newDraft())
 *   - an existing env in the library
 *   - a "preset" tagged env (filtered to those tagged with "preset")
 *
 * Cycle 20260429 Phase 8.2 — when wrapped by `RegistryPageShell`,
 * the host's hero already exposes a primary "새 드래프트" button.
 * Pass `omitBlankRow` to skip the blank-start row inside the picker
 * so the same affordance isn't surfaced twice.
 */

import { useEffect, useMemo, useState } from 'react';
import { Boxes, Copy, Pencil, Plus, Sparkles, Star } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { environmentApi } from '@/lib/environmentApi';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type { EnvironmentSummary } from '@/types/environment';
import { ActionButton } from '@/components/layout';

export interface StartFromPickerProps {
  /** When true, skip the leading "빈 환경으로 시작" row — the
   *  parent surface already exposes a primary "새 드래프트" CTA
   *  (e.g. RegistryPageShell's header onAdd). */
  omitBlankRow?: boolean;
}

export default function StartFromPicker({ omitBlankRow = false }: StartFromPickerProps = {}) {
  const { t } = useI18n();
  const newDraft = useEnvironmentDraftStore((s) => s.newDraft);
  const newDraftFromExisting = useEnvironmentDraftStore(
    (s) => s.newDraftFromExisting,
  );
  const loadExistingForEdit = useEnvironmentDraftStore(
    (s) => s.loadExistingForEdit,
  );
  const seeding = useEnvironmentDraftStore((s) => s.seeding);

  const [envs, setEnvs] = useState<EnvironmentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    environmentApi
      .list()
      .then((res) => {
        if (!cancelled) setEnvs(res);
      })
      .catch(() => {
        /* picker silently degrades to "blank only" */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // An env counts as "preset" (clone-only, no in-place Edit) when:
  //   - the backend marks it ``built_in`` (host-installed template,
  //     id-prefix ``template-``), OR
  //   - the manifest carries the legacy ``preset`` tag.
  // Without the ``built_in`` check, VTuber Environment / Worker
  // Environment leaked into the user-env section after Phase H landed
  // because their manifest doesn't ship the ``preset`` tag — they're
  // identified by id, not by tag.
  const isPreset = (e: EnvironmentSummary): boolean =>
    e.built_in === true || (e.tags || []).includes('preset');

  const presetEnvs = useMemo(() => envs.filter(isPreset), [envs]);
  const nonPresetEnvs = useMemo(() => envs.filter((e) => !isPreset(e)), [envs]);

  const visibleNonPresets = showAll ? nonPresetEnvs : nonPresetEnvs.slice(0, 6);

  const handleBlank = async () => {
    try {
      await newDraft();
    } catch {
      /* error surfaces via store */
    }
  };

  const handleFromExisting = async (id: string) => {
    try {
      await newDraftFromExisting(id);
    } catch {
      /* error surfaces via store */
    }
  };

  const handleEdit = async (id: string) => {
    try {
      await loadExistingForEdit(id);
    } catch {
      /* error surfaces via store */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* ── Blank ── (suppressed when the parent surface owns the primary CTA) */}
      {!omitBlankRow && (
        <div className="flex items-center gap-3 p-3 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <div className="w-10 h-10 rounded-md bg-gradient-to-br from-blue-500/15 to-purple-500/15 flex items-center justify-center shrink-0">
            <Plus className="w-5 h-5 text-[hsl(var(--primary))]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))]">
              {t('envManagement.startFrom.blankTitle')}
            </div>
            <div className="text-[0.7rem] text-[hsl(var(--muted-foreground))] mt-0.5">
              {t('envManagement.startFrom.blankDesc')}
            </div>
          </div>
          <ActionButton
            variant="primary"
            icon={Plus}
            onClick={handleBlank}
            disabled={seeding}
            spinIcon={seeding}
          >
            {seeding ? t('envManagement.seeding') : t('envManagement.newDraft')}
          </ActionButton>
        </div>
      )}

      {/* ── Presets (tagged with "preset") ── */}
      {presetEnvs.length > 0 && (
        <div>
          <div className="flex items-center gap-1 text-[0.7rem] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-2">
            <Star className="w-3 h-3" />
            {t('envManagement.startFrom.presetsTitle')}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {presetEnvs.map((env) => (
              <PresetCard
                key={env.id}
                env={env}
                onPick={() => handleFromExisting(env.id)}
                disabled={seeding}
                accent="violet"
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Existing user-created envs — Edit / Clone ── */}
      {nonPresetEnvs.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1 text-[0.7rem] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              <Boxes className="w-3 h-3" />
              {t('envManagement.startFrom.existingTitle', {
                n: String(nonPresetEnvs.length),
              })}
            </div>
            {nonPresetEnvs.length > 6 && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-[0.7rem] text-[hsl(var(--primary))] hover:underline"
              >
                {showAll
                  ? t('envManagement.startFrom.collapse')
                  : t('envManagement.startFrom.showAll', {
                      n: String(nonPresetEnvs.length),
                    })}
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {visibleNonPresets.map((env) => (
              <UserEnvCard
                key={env.id}
                env={env}
                onEdit={() => handleEdit(env.id)}
                onClone={() => handleFromExisting(env.id)}
                disabled={seeding}
              />
            ))}
          </div>
        </div>
      )}

      {!loading && envs.length === 0 && (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] italic">
          {t('envManagement.startFrom.empty')}
        </p>
      )}
    </div>
  );
}

function PresetCard({
  env,
  onPick,
  disabled,
  accent,
}: {
  env: EnvironmentSummary;
  onPick: () => void;
  disabled: boolean;
  accent: 'violet' | 'blue';
}) {
  const { t } = useI18n();
  const accentClass =
    accent === 'violet'
      ? 'border-violet-500/30 hover:border-violet-500'
      : 'border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]';
  // ``h-full`` lets the grid (default ``align-items: stretch``) make
  // every card in a row the same height regardless of description
  // length. Inside, ``flex-col`` + the description's reserved 2-line
  // ``min-h`` + ``mt-auto`` on the footer keep the visual rhythm
  // consistent for cards with 1-line vs 2-line descriptions.
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className={`group h-full flex flex-col gap-1 p-3 rounded-md border bg-[hsl(var(--card))] hover:bg-[hsl(var(--accent))] transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed ${accentClass}`}
    >
      <div className="flex items-center gap-1.5">
        <Sparkles
          className={`w-3.5 h-3.5 shrink-0 ${
            accent === 'violet' ? 'text-violet-500' : 'text-[hsl(var(--primary))]'
          }`}
        />
        <span className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))] truncate">
          {env.name}
        </span>
      </div>
      <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] line-clamp-2 leading-relaxed min-h-[2.3rem]">
        {env.description || t('envManagement.startFrom.noDescription')}
      </p>
      {env.tags && env.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {env.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="text-[0.625rem] text-[hsl(var(--primary))] mt-auto pt-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {t('envManagement.startFrom.useThis')} →
      </div>
    </button>
  );
}


/**
 * UserEnvCard — card for user-created (non-preset) environments.
 *
 * Card body click ≙ Edit (the obvious / most common action — opens
 * the existing env in place, preserving its id so a subsequent save
 * updates the record rather than creating a clone).
 *
 * The action row at the bottom exposes:
 *   - Edit (primary, same as body click — also visible at rest so
 *     the affordance is discoverable on touch / focus-only flows)
 *   - Clone (secondary — uses ``newDraftFromExisting`` which wipes
 *     identity, behaviour-identical to the preset cards)
 *
 * Built-in presets (``VTuber Environment`` / ``Worker Environment``
 * tagged ``preset``) bypass this component entirely and stay
 * read-only — see ``PresetCard`` above for that path.
 */
function UserEnvCard({
  env,
  onEdit,
  onClone,
  disabled,
}: {
  env: EnvironmentSummary;
  onEdit: () => void;
  onClone: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  // Layout invariants (Phase H polish):
  //   - ``h-full``    Every card stretches to the row's tallest card
  //                   so a 1-line and a 2-line description don't end
  //                   up at different heights side-by-side.
  //   - description ``line-clamp-2 min-h-[2.3rem]`` reserves space
  //                   for exactly two lines; a 1-line description
  //                   still occupies the 2-line slot.
  //   - action row ``mt-auto`` pins the Edit / Clone buttons to the
  //                   bottom of the card regardless of description
  //                   length.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => { if (!disabled) onEdit(); }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      className={`group h-full flex flex-col gap-1 p-3 rounded-md border bg-[hsl(var(--card))] hover:bg-[hsl(var(--accent))] transition-colors text-left cursor-pointer focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))] ${
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'border-[hsl(var(--border))] hover:border-[hsl(var(--primary))]'
      }`}
      aria-disabled={disabled}
      aria-label={t('envManagement.startFrom.editAriaLabel', { name: env.name })}
    >
      <div className="flex items-center gap-1.5">
        <Sparkles className="w-3.5 h-3.5 shrink-0 text-[hsl(var(--primary))]" />
        <span className="text-[0.8125rem] font-semibold text-[hsl(var(--foreground))] truncate flex-1">
          {env.name}
        </span>
      </div>
      <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] line-clamp-2 leading-relaxed min-h-[2.3rem]">
        {env.description || t('envManagement.startFrom.noDescription')}
      </p>
      {env.tags && env.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {env.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      {/* Action row — both buttons stop click propagation so they
          don't double-fire the card body's Edit handler. ``mt-auto``
          pins the row to the card's bottom edge so 1-line and 2-line
          descriptions present identically. */}
      <div className="flex items-center gap-1.5 mt-auto pt-2 border-t border-[hsl(var(--border))]">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); if (!disabled) onEdit(); }}
          disabled={disabled}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[0.6875rem] font-medium text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary)/0.1)] transition-colors disabled:opacity-50"
        >
          <Pencil className="w-3 h-3" />
          {t('envManagement.startFrom.edit')}
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); if (!disabled) onClone(); }}
          disabled={disabled}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[0.6875rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors disabled:opacity-50"
        >
          <Copy className="w-3 h-3" />
          {t('envManagement.startFrom.clone')}
        </button>
      </div>
    </div>
  );
}
