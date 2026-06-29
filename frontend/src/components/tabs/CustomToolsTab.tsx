'use client';

/**
 * CustomToolsTab — DB-backed custom-tool registry (Phase C / PR #4).
 *
 * Mirrors McpServersTab / SkillsTab — list view + `RegistryPageShell`
 * chrome, full editor lives in `CustomToolFormModal`. CRUD goes through
 * `customToolsApi`; each mutation triggers the backend's
 * `ToolLoader.reload_custom_tools_db()` so the new roster lands in
 * the active session pool without restart.
 *
 * Three sections:
 *   * Bundled samples  — `is_sample=true` rows shipped by Geny.
 *   * User custom      — `is_sample=false` rows the operator created.
 *   * (disabled)       — fold of rows with `enabled=false` from either
 *                        bucket; collapsed by default so the busy view
 *                        stays the curated active set.
 *
 * Cards expose 4 actions:
 *   * Edit       (Pencil)   → opens the modal pre-filled.
 *   * Duplicate  (Copy)     → forks (sample → user; clones name with
 *                              `_copy` suffix).
 *   * Toggle     (Power)    → calls /enabled.
 *   * Delete     (Trash2)   → removes the row.
 *
 * Samples can be deleted by an operator; the duplicate button is the
 * intended "edit a sample" path (fork, then edit the user copy).
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  customToolsApi,
  type CustomToolSummary,
  type CustomToolDetail,
} from '@/lib/api';
import {
  Copy,
  Globe,
  Link2,
  Pencil,
  Power,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  RegistryPageShell,
  RegistryGrid,
  RegistryCard,
  RegistryEmptyState,
  RegistryActionButton,
  RegistrySection,
} from '@/components/env_management/registry';
import CustomToolFormModal, {
  type CustomToolFormSubmit,
} from '@/components/env_management/custom_tools/CustomToolFormModal';
import EnvDefaultStarToggle from '@/components/env_management/EnvDefaultStarToggle';
import { useEnvDefaults } from '@/components/env_management/useEnvDefaults';

export function CustomToolsTab() {
  const { t } = useI18n();
  // C6 — ★ "default" toggle wiring (env-defaults custom_tools category).
  const loadEnvDefaultsOnce = useEnvDefaults((s) => s.loadOnce);
  useEffect(() => {
    loadEnvDefaultsOnce();
  }, [loadEnvDefaultsOnce]);
  const [tools, setTools] = useState<CustomToolSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingDetail, setEditingDetail] = useState<CustomToolDetail | null>(
    null,
  );

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await customToolsApi.list();
      setTools(r.tools);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const openCreate = () => {
    setEditingDetail(null);
    setError(null);
    setEditorOpen(true);
  };

  const openEdit = async (id: string) => {
    setError(null);
    try {
      const detail = await customToolsApi.get(id);
      setEditingDetail(detail);
      setEditorOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSubmit = async (payload: CustomToolFormSubmit) => {
    setSaving(true);
    setError(null);
    try {
      if (payload.id) {
        await customToolsApi.replace(payload.id, payload.body);
        toast.success(`Updated ${payload.body.name}`);
      } else {
        await customToolsApi.create(payload.body);
        toast.success(`Created ${payload.body.name}`);
      }
      setEditorOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (summary: CustomToolSummary) => {
    if (!window.confirm(`Delete custom tool "${summary.name}"?`)) return;
    try {
      await customToolsApi.remove(summary.id);
      toast.success(`Deleted ${summary.name}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDuplicate = async (summary: CustomToolSummary) => {
    try {
      const dup = await customToolsApi.duplicate(summary.id);
      toast.success(`Duplicated to ${dup.name}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onToggle = async (summary: CustomToolSummary) => {
    try {
      await customToolsApi.setEnabled(summary.id, !summary.enabled);
      toast.success(`${summary.enabled ? 'Disabled' : 'Enabled'} ${summary.name}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const isEmpty = !loading && tools.length === 0;
  const addLabel = t('envManagement.registry.customTools.addLabel');

  if (editorOpen) {
    return (
      <CustomToolFormModal
        editing={editingDetail}
        saving={saving}
        error={error}
        onClose={() => setEditorOpen(false)}
        onSubmit={handleSubmit}
      />
    );
  }

  const samples = tools.filter((t) => t.is_sample);
  const userTools = tools.filter((t) => !t.is_sample);

  return (
    <RegistryPageShell
      icon={Wrench}
      title={t('envManagement.registry.customTools.title')}
      subtitle={t('envManagement.registry.customTools.subtitle')}
      countLabel={t('envManagement.registry.customTools.countLabel', {
        n: String(tools.length),
      })}
      bannerNote={t('envManagement.registry.customTools.bannerNote')}
      addLabel={addLabel}
      onAdd={openCreate}
      onRefresh={refresh}
      loading={loading}
      error={error}
      onDismissError={() => setError(null)}
    >
      {isEmpty ? (
        <RegistryEmptyState
          icon={Wrench}
          title={t('envManagement.registry.customTools.emptyTitle')}
          hint={t('envManagement.registry.emptyHint', { addLabel })}
          addLabel={addLabel}
          onAdd={openCreate}
        />
      ) : (
        <>
          {samples.length > 0 && (
            <RegistrySection
              label={t('envManagement.registry.customTools.samplesTitle')}
              count={samples.length}
              description={t(
                'envManagement.registry.customTools.samplesSubtitle',
              )}
              inline
            >
              <RegistryGrid>
                {samples.map((s) => (
                  <CustomToolCard
                    key={s.id}
                    summary={s}
                    onEdit={() => openEdit(s.id)}
                    onDelete={() => onDelete(s)}
                    onDuplicate={() => onDuplicate(s)}
                    onToggle={() => onToggle(s)}
                  />
                ))}
              </RegistryGrid>
            </RegistrySection>
          )}
          {userTools.length > 0 && (
            <RegistrySection
              label={t('envManagement.registry.customTools.userTitle')}
              count={userTools.length}
              description={t(
                'envManagement.registry.customTools.userSubtitle',
              )}
              inline
            >
              <RegistryGrid>
                {userTools.map((s) => (
                  <CustomToolCard
                    key={s.id}
                    summary={s}
                    onEdit={() => openEdit(s.id)}
                    onDelete={() => onDelete(s)}
                    onDuplicate={() => onDuplicate(s)}
                    onToggle={() => onToggle(s)}
                  />
                ))}
              </RegistryGrid>
            </RegistrySection>
          )}
        </>
      )}
    </RegistryPageShell>
  );
}

export default CustomToolsTab;

// ── Card ────────────────────────────────────────────────────────

function CustomToolCard({
  summary,
  onEdit,
  onDelete,
  onDuplicate,
  onToggle,
}: {
  summary: CustomToolSummary;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const KindIcon =
    summary.backend_kind === 'http'
      ? Globe
      : summary.backend_kind === 'mcp_proxy'
        ? Link2
        : Wrench;
  const kindTone =
    summary.backend_kind === 'http'
      ? 'info'
      : summary.backend_kind === 'mcp_proxy'
        ? 'good'
        : 'neutral';

  const badges: Array<{
    label: string;
    tone: 'good' | 'info' | 'neutral' | 'warn';
    icon?: typeof Wrench;
  }> = [
    { label: summary.backend_kind, tone: kindTone, icon: KindIcon },
  ];
  if (summary.is_sample) {
    badges.push({ label: 'sample', tone: 'neutral' });
  }
  if (!summary.enabled) {
    badges.push({ label: 'disabled', tone: 'warn' });
  }

  return (
    <RegistryCard
      icon={Wrench}
      title={summary.name}
      titleMono
      description={summary.description || '—'}
      badges={badges}
      star={
        // C6 — id is the tool *name* (what lands in tools.external).
        <EnvDefaultStarToggle category="custom_tools" itemId={summary.name} />
      }
      actions={
        <>
          <RegistryActionButton
            icon={Pencil}
            onClick={onEdit}
            title={t('envManagement.registry.editTip')}
            variant="primary"
          />
          <RegistryActionButton
            icon={Copy}
            onClick={onDuplicate}
            title={t('envManagement.registry.customTools.duplicateTip')}
            variant="default"
          />
          <RegistryActionButton
            icon={Power}
            onClick={onToggle}
            title={
              summary.enabled
                ? t('envManagement.registry.customTools.disableTip')
                : t('envManagement.registry.customTools.enableTip')
            }
            variant={summary.enabled ? 'default' : 'primary'}
          />
          <RegistryActionButton
            icon={Trash2}
            onClick={onDelete}
            title={t('envManagement.registry.deleteTip')}
            variant="danger"
          />
        </>
      }
    />
  );
}
