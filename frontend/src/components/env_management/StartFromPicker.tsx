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
import { BookOpen, Boxes, Copy, Plus, Sparkles, Star, Trash2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { environmentApi } from '@/lib/environmentApi';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type { EnvironmentSummary } from '@/types/environment';
import { ActionButton } from '@/components/common/layout';
import MarkdownRenderer from '@/components/file-viewer/MarkdownRenderer';
import { presetGuide } from '@/lib/presetGuides';
import RegistryGrid from '@/components/env_management/registry/RegistryGrid';
import RegistryCard, {
  type RegistryCardBadge,
} from '@/components/env_management/registry/RegistryCard';
import RegistryActionButton from '@/components/env_management/registry/RegistryActionButton';

export interface StartFromPickerProps {
  /** When true, skip the leading "빈 환경으로 시작" row — the
   *  parent surface already exposes a primary "새 드래프트" CTA
   *  (e.g. RegistryPageShell's header onAdd). */
  omitBlankRow?: boolean;
}

export default function StartFromPicker({ omitBlankRow = false }: StartFromPickerProps = {}) {
  const { t, locale } = useI18n();
  const [guideEnv, setGuideEnv] = useState<EnvironmentSummary | null>(null);
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

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await environmentApi.delete(id);
      setEnvs((prev) => prev.filter((e) => e.id !== id));
    } catch {
      /* keep the card; backend rejects (e.g. in-use) — surfaced via toast layer */
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* ── Blank ── (suppressed when the parent surface owns the primary CTA) */}
      {!omitBlankRow && (
        <div className="flex items-center gap-3 p-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]">
          <div className="w-10 h-10 rounded-lg bg-[hsl(var(--primary)/0.1)] flex items-center justify-center shrink-0">
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
          <RegistryGrid>
            {presetEnvs.map((env) => (
              <PresetCard
                key={env.id}
                env={env}
                onPick={() => handleFromExisting(env.id)}
                onShowGuide={() => setGuideEnv(env)}
                disabled={seeding}
              />
            ))}
          </RegistryGrid>
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
          <RegistryGrid>
            {visibleNonPresets.map((env) => (
              <UserEnvCard
                key={env.id}
                env={env}
                onEdit={() => handleEdit(env.id)}
                onClone={() => handleFromExisting(env.id)}
                onDelete={() => handleDelete(env.id)}
                disabled={seeding || deletingId === env.id}
                deleting={deletingId === env.id}
              />
            ))}
          </RegistryGrid>
        </div>
      )}

      {!loading && envs.length === 0 && (
        <p className="text-[0.7rem] text-[hsl(var(--muted-foreground))] italic">
          {t('envManagement.startFrom.empty')}
        </p>
      )}

      {/* ── Preset "설명보기" modal ── */}
      {guideEnv && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setGuideEnv(null)}
        >
          <div
            className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-lg w-full max-w-[640px] max-h-[85vh] flex flex-col shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between py-3 px-5 border-b border-[hsl(var(--border))]">
              <h3 className="flex items-center gap-2 text-[0.95rem] font-semibold text-[hsl(var(--foreground))]">
                <BookOpen className="w-4 h-4 text-violet-500" />
                {guideEnv.name}
              </h3>
              <button
                type="button"
                onClick={() => setGuideEnv(null)}
                aria-label={t('common.close')}
                className="inline-flex items-center justify-center w-7 h-7 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <MarkdownRenderer
                content={presetGuide(guideEnv, locale === 'en' ? 'en' : 'ko')}
              />
            </div>
            <div className="flex justify-end gap-2 py-3 px-5 border-t border-[hsl(var(--border))]">
              <button
                type="button"
                onClick={() => setGuideEnv(null)}
                className="inline-flex items-center h-8 px-3 rounded-md border border-[hsl(var(--border))] text-[0.75rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
              >
                {t('common.close')}
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = guideEnv.id;
                  setGuideEnv(null);
                  handleFromExisting(id);
                }}
                disabled={seeding}
                className="inline-flex items-center h-8 px-3 rounded-md bg-[hsl(var(--primary))] text-[0.75rem] font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {t('envManagement.startFrom.useThis')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PresetCard({
  env,
  onPick,
  onShowGuide,
  disabled,
}: {
  env: EnvironmentSummary;
  onPick: () => void;
  onShowGuide: () => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const badges: RegistryCardBadge[] = [
    { label: t('envManagement.startFrom.presetBadge'), tone: 'info', icon: Star },
  ];
  return (
    <RegistryCard
      icon={Sparkles}
      title={env.name}
      description={env.description || t('envManagement.startFrom.noDescription')}
      badges={badges}
      onClick={() => { if (!disabled) onPick(); }}
      actions={
        <RegistryActionButton
          icon={BookOpen}
          title={t('envManagement.startFrom.viewGuide')}
          onClick={onShowGuide}
          alwaysVisible
        />
      }
    />
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
  onDelete,
  disabled,
  deleting,
}: {
  env: EnvironmentSummary;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
  disabled: boolean;
  deleting: boolean;
}) {
  const { t } = useI18n();
  // Card body click ≙ Edit (the obvious / most common action). Clone + Delete
  // live in the action cluster. Delete is guarded by a native confirm — uniform
  // with the other registry tabs (persona / tool-packs).
  const badges: RegistryCardBadge[] = (env.tags || [])
    .slice(0, 3)
    .map((tag) => ({ label: tag, tone: 'neutral' as const }));
  return (
    <RegistryCard
      icon={Sparkles}
      title={env.name}
      description={env.description || t('envManagement.startFrom.noDescription')}
      badges={badges}
      onClick={() => { if (!disabled) onEdit(); }}
      actions={
        <>
          <RegistryActionButton
            icon={Copy}
            title={t('envManagement.startFrom.clone')}
            onClick={() => { if (!disabled) onClone(); }}
            disabled={disabled}
          />
          <RegistryActionButton
            icon={Trash2}
            title={t('envManagement.startFrom.delete')}
            variant="danger"
            disabled={disabled || deleting}
            onClick={() => {
              if (disabled) return;
              if (window.confirm(t('envManagement.startFrom.deleteConfirmPrompt', { name: env.name }))) onDelete();
            }}
          />
        </>
      }
    />
  );
}
