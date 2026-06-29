'use client';

/**
 * TriggersTab — list + editor for VTuber trigger presets.
 *
 * Mirrors the registry-tab pattern (MCP / Skills / Hooks): a hero
 * shell with cards for each saved preset, an "+ New draft" button
 * that creates a default-seeded preset and opens the editor, and a
 * sibling editor view that owns the timing / phases / categories /
 * prompts UI.
 *
 * Environment Presets reuse the same JSON-per-id layout on disk, so
 * the operator can move an exported preset between hosts the same way
 * environment exports work today.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Edit3,
  RotateCcw,
  Star,
  Trash2,
  Zap,
  ZapOff,
} from 'lucide-react';

import {
  RegistryActionButton,
  RegistryCard,
  RegistryEmptyState,
  RegistryPageShell,
  RegistrySection,
} from '@/components/env_management/registry';
import { triggerPresetApi } from '@/lib/triggerPresetApi';
import { useI18n } from '@/lib/i18n';
import type {
  TriggerPresetDetail,
  TriggerPresetSummary,
} from '@/types/triggerPreset';

import TriggerPresetEditor from '@/components/env_management/triggers/TriggerPresetEditor';

type EditorMode =
  | { kind: 'idle' }
  | { kind: 'create' }
  | { kind: 'edit'; presetId: string };

export function TriggersTab() {
  const { t } = useI18n();
  const [presets, setPresets] = useState<TriggerPresetSummary[]>([]);
  const [defaultPresetId, setDefaultPresetId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorMode>({ kind: 'idle' });
  const [editingDetail, setEditingDetail] =
    useState<TriggerPresetDetail | null>(null);
  const [defaultsTemplate, setDefaultsTemplate] =
    useState<TriggerPresetDetail | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { presets: list, defaultPresetId: defId } =
        await triggerPresetApi.list();
      setPresets(list);
      setDefaultPresetId(defId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Cache the bundled defaults once — reused as a seed for "+ New draft"
    // and as the body of the synthetic "default" preview card.
    triggerPresetApi
      .defaults()
      .then(setDefaultsTemplate)
      .catch(() => {
        // Non-fatal — the create flow falls back to a server-side seed.
      });
  }, [refresh]);

  // ── Editor lifecycle ────────────────────────────────────────────

  const openCreate = useCallback(async () => {
    setEditingDetail(null);
    setEditor({ kind: 'create' });
  }, []);

  const openEdit = useCallback(async (presetId: string) => {
    setError(null);
    try {
      const detail = await triggerPresetApi.get(presetId);
      setEditingDetail(detail);
      setEditor({ kind: 'edit', presetId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const closeEditor = useCallback(() => {
    setEditor({ kind: 'idle' });
    setEditingDetail(null);
  }, []);

  const onDuplicate = useCallback(
    async (summary: TriggerPresetSummary) => {
      setError(null);
      try {
        const newName = `${summary.name} (${t('triggersTab.duplicateSuffix')})`;
        await triggerPresetApi.duplicate(summary.id, newName);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const onSetDefault = useCallback(
    async (summary: TriggerPresetSummary) => {
      setError(null);
      try {
        const { presets: list, defaultPresetId: defId } =
          await triggerPresetApi.setDefault(summary.id);
        setPresets(list);
        setDefaultPresetId(defId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const onReset = useCallback(
    async (summary: TriggerPresetSummary) => {
      const ok = window.confirm(
        t('triggersTab.resetConfirm', { name: summary.name }),
      );
      if (!ok) return;
      setError(null);
      try {
        await triggerPresetApi.reset(summary.id);
        await refresh();
        if (editor.kind === 'edit' && editor.presetId === summary.id) {
          // Reload the editor with the freshly reset record so the
          // form reflects defaults instead of the pre-reset draft.
          await openEdit(summary.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [editor, openEdit, refresh],
  );

  const onDelete = useCallback(
    async (summary: TriggerPresetSummary) => {
      setError(null);
      try {
        const used = await triggerPresetApi.sessions(summary.id);
        if (used.active_count > 0) {
          const sessionList = used.sessions
            .map(
              (s) => `  • ${s.session_name || s.session_id}`,
            )
            .join('\n');
          const ok = window.confirm(
            t('triggersTab.deleteInUseConfirm', {
              count: used.active_count,
              sessions: sessionList,
            }),
          );
          if (!ok) return;
        } else {
          const ok = window.confirm(
            t('triggersTab.deleteConfirm', { name: summary.name }),
          );
          if (!ok) return;
        }
        await triggerPresetApi.delete(summary.id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  // ── Sectioning ──────────────────────────────────────────────────
  // Three groups, mirroring the env-management view (built-in presets
  // vs "start from an existing env"):
  //   bundled  — the in-code default preset Geny ships ("Default presets").
  //   featured — `preset`-tagged shareable presets ("Shared presets").
  //   mine     — everything the operator authored ("My presets").
  // The bundled default must NOT sit under "My presets" — it isn't the
  // operator's, it's Geny's built-in.

  const sections = useMemo(() => {
    const bundled: TriggerPresetSummary[] = [];
    const featured: TriggerPresetSummary[] = [];
    const mine: TriggerPresetSummary[] = [];
    for (const p of presets) {
      if (p.is_bundled) bundled.push(p);
      else if (p.tags?.includes('preset')) featured.push(p);
      else mine.push(p);
    }
    return { bundled, featured, mine };
  }, [presets]);

  // ── Editor branch ───────────────────────────────────────────────

  if (editor.kind !== 'idle') {
    const editingSummary =
      editor.kind === 'edit'
        ? presets.find((p) => p.id === editor.presetId)
        : undefined;
    return (
      <TriggerPresetEditor
        mode={editor.kind}
        seed={editor.kind === 'create' ? defaultsTemplate : editingDetail}
        existingSummary={editingSummary}
        onClose={closeEditor}
        onSaved={async () => {
          await refresh();
          closeEditor();
        }}
      />
    );
  }

  // ── List branch ─────────────────────────────────────────────────

  return (
    <RegistryPageShell
      title={t('triggersTab.title')}
      icon={Zap}
      countLabel={t('triggersTab.countLabel', { count: presets.length })}
      subtitle={<>{t('triggersTab.subtitle')}</>}
      bannerNote={t('triggersTab.bannerNote')}
      addLabel={t('triggersTab.addLabel')}
      onAdd={openCreate}
      onRefresh={() => void refresh()}
      loading={loading}
      error={error}
      onDismissError={() => setError(null)}
    >
      {presets.length === 0 ? (
        <RegistryEmptyState
          icon={Zap}
          title={t('triggersTab.emptyTitle')}
          hint={t('triggersTab.emptyHint')}
          addLabel={t('triggersTab.addLabel')}
          onAdd={openCreate}
        />
      ) : (
        <>
          {sections.bundled.length > 0 && (
            <RegistrySection
              label={t('triggersTab.sectionBundledLabel')}
              count={sections.bundled.length}
              description={t('triggersTab.sectionBundledDesc')}
            >
              {sections.bundled.map((p) => (
                <PresetCard
                  key={p.id}
                  summary={p}
                  isDefault={p.id === defaultPresetId}
                  onEdit={() => void openEdit(p.id)}
                  onDuplicate={() => void onDuplicate(p)}
                  onSetDefault={() => void onSetDefault(p)}
                  onReset={() => void onReset(p)}
                  onDelete={() => void onDelete(p)}
                />
              ))}
            </RegistrySection>
          )}

          {sections.featured.length > 0 && (
            <RegistrySection
              label={t('triggersTab.sectionFeaturedLabel')}
              count={sections.featured.length}
              description={t('triggersTab.sectionFeaturedDesc')}
            >
              {sections.featured.map((p) => (
                <PresetCard
                  key={p.id}
                  summary={p}
                  isDefault={p.id === defaultPresetId}
                  onEdit={() => void openEdit(p.id)}
                  onDuplicate={() => void onDuplicate(p)}
                  onSetDefault={() => void onSetDefault(p)}
                  onReset={() => void onReset(p)}
                  onDelete={() => void onDelete(p)}
                />
              ))}
            </RegistrySection>
          )}

          {sections.mine.length > 0 && (
            <RegistrySection
              label={t('triggersTab.sectionMineLabel')}
              count={sections.mine.length}
            >
              {sections.mine.map((p) => (
                <PresetCard
                  key={p.id}
                  summary={p}
                  isDefault={p.id === defaultPresetId}
                  onEdit={() => void openEdit(p.id)}
                  onDuplicate={() => void onDuplicate(p)}
                  onSetDefault={() => void onSetDefault(p)}
                  onReset={() => void onReset(p)}
                  onDelete={() => void onDelete(p)}
                />
              ))}
            </RegistrySection>
          )}
        </>
      )}
    </RegistryPageShell>
  );
}

interface PresetCardProps {
  summary: TriggerPresetSummary;
  /** True when this preset is the host-wide designated default. */
  isDefault: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onSetDefault: () => void;
  onReset: () => void;
  onDelete: () => void;
}

function PresetCard({
  summary,
  isDefault,
  onEdit,
  onDuplicate,
  onSetDefault,
  onReset,
  onDelete,
}: PresetCardProps) {
  const { t } = useI18n();
  const updated = summary.updated_at
    ? new Date(summary.updated_at).toLocaleString()
    : '';
  return (
    <RegistryCard
      icon={summary.enabled ? Zap : ZapOff}
      title={summary.name}
      description={summary.description || ' '}
      active={isDefault}
      badges={[
        // The default-preset badge leads the row so it's the first
        // thing the operator reads — "good" tone (green) makes it
        // unmistakable which preset is the active host default.
        ...(isDefault
          ? [
              {
                label: t('triggersTab.badgeDefault'),
                tone: 'good' as const,
                icon: Star,
              },
            ]
          : []),
        {
          label: t('triggersTab.badgeCategories', {
            count: summary.category_count,
          }),
          tone: 'info' as const,
        },
        {
          label: t('triggersTab.badgePrompts', {
            count: summary.prompt_count,
          }),
          tone: 'neutral' as const,
        },
        ...(summary.enabled
          ? []
          : [
              {
                label: 'disabled',
                tone: 'warn' as const,
              },
            ]),
      ]}
      meta={updated}
      actions={
        <>
          {/* The default preset already wears the "Default" badge — only
              non-default presets get the "set as default" affordance. */}
          {!isDefault && (
            <RegistryActionButton
              icon={Star}
              onClick={onSetDefault}
              title={t('triggersTab.actionSetDefault')}
            />
          )}
          <RegistryActionButton
            icon={Edit3}
            onClick={onEdit}
            title={t('triggersTab.actionEdit')}
            variant="primary"
          />
          <RegistryActionButton
            icon={Copy}
            onClick={onDuplicate}
            title={t('triggersTab.actionDuplicate')}
          />
          <RegistryActionButton
            icon={RotateCcw}
            onClick={onReset}
            title={t('triggersTab.actionReset')}
          />
          <RegistryActionButton
            icon={Trash2}
            onClick={onDelete}
            title={t('triggersTab.actionDelete')}
            variant="danger"
          />
        </>
      }
      onClick={onEdit}
    />
  );
}
