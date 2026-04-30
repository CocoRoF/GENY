'use client';

/**
 * McpServersTab — host-shared registry for custom MCP servers.
 *
 * Reads from /api/mcp/custom. Cycle 20260429 Phase 9.1 split the
 * form into a dedicated `McpServerFormModal` (localised, section-
 * based, transport-aware visual selector, live JSON preview); this
 * file is now just the list view + CRUD orchestration.
 *
 * Per-session OAuth flow lives inside MCPAdminPanel.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  customMcpApi,
  type CustomMcpServerSummary,
} from '@/lib/api';
import { Globe, Network, Pencil, Server, Terminal, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import EnvDefaultStarToggle from '@/components/env_management/EnvDefaultStarToggle';
import { useEnvDefaults } from '@/components/env_management/useEnvDefaults';
import McpServerFormModal, {
  type McpServerFormSubmit,
} from '@/components/env_management/mcp/McpServerFormModal';
import {
  RegistryPageShell,
  RegistryGrid,
  RegistryCard,
  RegistryEmptyState,
  RegistryActionButton,
} from '@/components/env_management/registry';

export function McpServersTab() {
  const { t } = useI18n();
  const [servers, setServers] = useState<CustomMcpServerSummary[]>([]);

  const loadEnvDefaultsOnce = useEnvDefaults((s) => s.loadOnce);
  useEffect(() => {
    loadEnvDefaultsOnce();
  }, [loadEnvDefaultsOnce]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingExisting, setEditingExisting] = useState(false);
  const [editingName, setEditingName] = useState('');
  const [editingConfig, setEditingConfig] =
    useState<Record<string, unknown> | undefined>(undefined);
  const [editingDescription, setEditingDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await customMcpApi.list();
      setServers(r.servers);
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
    setEditingExisting(false);
    setEditingName('');
    setEditingConfig(undefined);
    setEditingDescription('');
    setError(null);
    setEditorOpen(true);
  };

  const openEdit = async (name: string) => {
    setError(null);
    try {
      const detail = await customMcpApi.get(name);
      const cfg = detail.config as Record<string, unknown>;
      const desc =
        typeof cfg.description === 'string' ? (cfg.description as string) : '';
      setEditingExisting(true);
      setEditingName(detail.name);
      setEditingConfig(cfg);
      setEditingDescription(desc);
      setEditorOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSubmit = async (payload: McpServerFormSubmit) => {
    setSaving(true);
    setError(null);
    try {
      if (editingExisting) {
        await customMcpApi.replace(
          payload.name,
          payload.config,
          payload.description || undefined,
        );
        toast.success(`Updated ${payload.name}`);
      } else {
        await customMcpApi.create(
          payload.name,
          payload.config,
          payload.description || undefined,
        );
        toast.success(`Created ${payload.name}`);
      }
      setEditorOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (name: string) => {
    if (!window.confirm(`Delete custom MCP server "${name}"?`)) return;
    try {
      await customMcpApi.remove(name);
      toast.success(`Deleted ${name}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const isEmpty = !loading && servers.length === 0;
  const addLabel = t('envManagement.registry.mcp.addLabel');

  if (editorOpen) {
    return (
      <McpServerFormModal
        editingExisting={editingExisting}
        initialName={editingName}
        initialConfig={editingConfig}
        initialDescription={editingDescription}
        saving={saving}
        error={error}
        onClose={() => setEditorOpen(false)}
        onSubmit={handleSubmit}
      />
    );
  }

  return (
    <RegistryPageShell
      icon={Network}
      title={t('envManagement.registry.mcp.title')}
      subtitle={t('envManagement.registry.mcp.subtitle')}
      countLabel={t('envManagement.registry.mcp.countLabel', {
        n: String(servers.length),
      })}
      bannerNote={t('envManagement.registry.mcp.bannerNote')}
      addLabel={addLabel}
      onAdd={openCreate}
      onRefresh={refresh}
      loading={loading}
      error={error}
      onDismissError={() => setError(null)}
    >
      {isEmpty ? (
        <RegistryEmptyState
          icon={Network}
          title={t('envManagement.registry.mcp.emptyTitle')}
          hint={t('envManagement.registry.emptyHint', { addLabel })}
          addLabel={addLabel}
          onAdd={openCreate}
        />
      ) : (
        <RegistryGrid>
          {servers.map((s) => (
            <McpServerCard
              key={s.name}
              summary={s}
              onEdit={() => openEdit(s.name)}
              onDelete={() => onDelete(s.name)}
            />
          ))}
        </RegistryGrid>
      )}
    </RegistryPageShell>
  );
}

export default McpServersTab;

// ── Card ────────────────────────────────────────────────────────

function McpServerCard({
  summary,
  onEdit,
  onDelete,
}: {
  summary: CustomMcpServerSummary;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const transport = (summary.type ?? 'stdio') as
    | 'stdio'
    | 'http'
    | 'sse'
    | string;
  const isStdio = transport === 'stdio';
  const TransportIcon = isStdio ? Terminal : Globe;
  const transportTone = isStdio
    ? 'good'
    : transport === 'sse'
      ? 'info'
      : 'info';

  return (
    <RegistryCard
      icon={Server}
      title={summary.name}
      titleMono
      description={summary.description ?? '—'}
      badges={[
        { label: transport, tone: transportTone, icon: TransportIcon },
      ]}
      star={
        <EnvDefaultStarToggle category="mcp_servers" itemId={summary.name} />
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
