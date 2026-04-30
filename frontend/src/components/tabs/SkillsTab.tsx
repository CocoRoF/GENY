'use client';

/**
 * SkillsTab — host-shared skill registry. Lists every loaded skill
 * (bundled + user) and lets the operator create / edit / delete user
 * skills via /api/skills/user. A header toggle flips
 * `settings.skills.user_skills_enabled` so the skills actually load
 * on the next session.
 *
 * Cycle 20260429 Phase 9.3 — split the form into a dedicated
 * `SkillFormModal` (sectioned, localised, with per-field hints +
 * smart placeholders); this file is now just the list view + CRUD
 * orchestration. Mirrors what Phase 9.1 did for MCP.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  agentApi,
  skillsApi,
  frameworkSettingsApi,
  type SkillDetail,
} from '@/lib/api';
import { Pencil, Power, Sparkles, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import EnvDefaultStarToggle from '@/components/env_management/EnvDefaultStarToggle';
import { useEnvDefaults } from '@/components/env_management/useEnvDefaults';
import { skillId } from '@/lib/envDefaultsApi';
import SkillFormModal, {
  type SkillFormSubmit,
} from '@/components/env_management/skills/SkillFormModal';
import {
  RegistryPageShell,
  RegistrySection,
  RegistryCard,
  RegistryEmptyState,
  RegistryActionButton,
} from '@/components/env_management/registry';

interface SkillRow {
  id: string | null;
  name: string | null;
  description: string | null;
  allowed_tools: string[];
  category?: string | null;
  effort?: string | null;
  examples?: string[];
  /** Phase 10 follow-up — origin classification. Drives the badge
   *  + which section the skill lives in. */
  source_kind?: 'executor' | 'geny' | 'user' | 'mcp' | 'unknown';
}

export interface SkillsTabProps {
  /** Deprecated — embedded mode is no longer used after Phase 5. */
  embedded?: boolean;
}

export function SkillsTab(_props: SkillsTabProps = {}) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [userSkillsEnabled, setUserSkillsEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEnvDefaultsOnce = useEnvDefaults((s) => s.loadOnce);
  useEffect(() => {
    loadEnvDefaultsOnce();
  }, [loadEnvDefaultsOnce]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingExisting, setEditingExisting] = useState(false);
  const [editingDetail, setEditingDetail] = useState<SkillDetail | null>(null);
  const [saving, setSaving] = useState(false);

  const [userIds, setUserIds] = useState<Set<string>>(new Set());

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await agentApi.skillsList();
      setSkills(list.skills as SkillRow[]);

      const ids = list.skills.map((s) => s.id).filter(Boolean) as string[];
      const details = await Promise.allSettled(ids.map((id) => skillsApi.get(id)));
      const userSet = new Set<string>();
      details.forEach((r) => {
        if (r.status === 'fulfilled' && r.value.is_user_skill) userSet.add(r.value.id);
      });
      setUserIds(userSet);

      try {
        const sec = await frameworkSettingsApi.get('skills');
        const v = sec.values as { user_skills_enabled?: boolean };
        setUserSkillsEnabled(!!v.user_skills_enabled);
      } catch {
        setUserSkillsEnabled(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  /** Group by origin (Phase 10 follow-up).
   *  - executor: skills shipped with geny-executor (verify, debug,
   *    lorem-ipsum, stuck, batch, simplify, skillify, loop)
   *  - geny: first-party Geny-specific skills under
   *    backend/skills/bundled/
   *  - user: operator-supplied under ~/.geny/skills/, editable here
   *  - mcp / unknown: bucketed under "other"
   *
   *  Pre-source_kind payloads fall back to the userIds-from-detail
   *  classifier so older backends keep working unchanged. */
  const grouped = useMemo(() => {
    const executor: SkillRow[] = [];
    const geny: SkillRow[] = [];
    const user: SkillRow[] = [];
    const other: SkillRow[] = [];
    skills.forEach((s) => {
      const kind = s.source_kind;
      if (kind === 'executor') {
        executor.push(s);
      } else if (kind === 'geny') {
        geny.push(s);
      } else if (kind === 'user') {
        user.push(s);
      } else if (kind === 'mcp' || kind === 'unknown') {
        other.push(s);
      } else {
        // No source_kind on the payload (old backend) — fall back to
        // the per-skill detail roundtrip that populated userIds.
        if (s.id && userIds.has(s.id)) user.push(s);
        else geny.push(s);
      }
    });
    return { executor, geny, user, other };
  }, [skills, userIds]);

  const openCreate = () => {
    setEditingExisting(false);
    setEditingDetail(null);
    setError(null);
    setEditorOpen(true);
  };

  const openEdit = async (id: string) => {
    setError(null);
    try {
      const detail = await skillsApi.get(id);
      setEditingExisting(true);
      setEditingDetail(detail);
      setEditorOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSubmit = async (payload: SkillFormSubmit) => {
    setSaving(true);
    setError(null);
    try {
      if (editingExisting) {
        await skillsApi.replaceUserSkill(payload);
      } else {
        await skillsApi.createUserSkill(payload);
      }
      toast.success(
        editingExisting ? `Updated /${payload.id}` : `Created /${payload.id}`,
      );
      setEditorOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm(`Delete user skill /${id}?`)) return;
    try {
      await skillsApi.deleteUserSkill(id);
      toast.success(`Deleted /${id}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onToggleEnabled = async () => {
    if (userSkillsEnabled === null) return;
    setError(null);
    try {
      await frameworkSettingsApi.patch('skills', {
        user_skills_enabled: !userSkillsEnabled,
      });
      setUserSkillsEnabled((v) => !v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const enabledBadge = userSkillsEnabled !== null && (
    <button
      type="button"
      onClick={onToggleEnabled}
      title={`user_skills_enabled: ${userSkillsEnabled ? 'true' : 'false'} — 클릭하여 토글`}
      className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-[0.6875rem] font-medium border transition-colors ${
        userSkillsEnabled
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15'
          : 'border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]'
      }`}
    >
      <Power className="w-3 h-3" />
      {userSkillsEnabled ? 'enabled' : 'disabled'}
    </button>
  );

  const isEmpty = !loading && skills.length === 0;
  const addLabel = t('envManagement.registry.skills.addLabel');

  if (editorOpen) {
    return (
      <SkillFormModal
        editingExisting={editingExisting}
        initialDetail={editingDetail}
        saving={saving}
        error={error}
        onClose={() => setEditorOpen(false)}
        onSubmit={handleSubmit}
      />
    );
  }

  return (
    <RegistryPageShell
      icon={Sparkles}
      title={t('envManagement.registry.skills.title')}
      subtitle={t('envManagement.registry.skills.subtitle')}
      countLabel={t('envManagement.registry.skills.countLabel', {
        n: String(skills.length),
      })}
      bannerNote={t('envManagement.registry.skills.bannerNote')}
      addLabel={addLabel}
      onAdd={openCreate}
      onRefresh={refresh}
      loading={loading}
      error={error}
      onDismissError={() => setError(null)}
      headerExtras={enabledBadge}
    >
      {isEmpty ? (
        <RegistryEmptyState
          icon={Sparkles}
          title={t('envManagement.registry.skills.emptyTitle')}
          hint={t('envManagement.registry.emptyHint', { addLabel })}
          addLabel={addLabel}
          onAdd={openCreate}
        />
      ) : (
        <>
          {grouped.executor.length > 0 && (
            <RegistrySection
              label={t('envManagement.registry.skills.sectionExecutor')}
              count={grouped.executor.length}
            >
              {grouped.executor.map((s, i) => (
                <SkillCard
                  key={s.id ?? `executor-${i}`}
                  skill={s}
                  isUser={false}
                />
              ))}
            </RegistrySection>
          )}
          {grouped.geny.length > 0 && (
            <RegistrySection
              label={t('envManagement.registry.skills.sectionBundled')}
              count={grouped.geny.length}
            >
              {grouped.geny.map((s, i) => (
                <SkillCard
                  key={s.id ?? `geny-${i}`}
                  skill={s}
                  isUser={false}
                />
              ))}
            </RegistrySection>
          )}
          {grouped.user.length > 0 && (
            <RegistrySection
              label={t('envManagement.registry.skills.sectionUser')}
              count={grouped.user.length}
            >
              {grouped.user.map((s, i) => (
                <SkillCard
                  key={s.id ?? `user-${i}`}
                  skill={s}
                  isUser={true}
                  onEdit={() => s.id && openEdit(s.id)}
                  onDelete={() => s.id && onDelete(s.id)}
                />
              ))}
            </RegistrySection>
          )}
          {grouped.other.length > 0 && (
            <RegistrySection
              label={t('envManagement.registry.skills.sectionOther')}
              count={grouped.other.length}
            >
              {grouped.other.map((s, i) => (
                <SkillCard
                  key={s.id ?? `other-${i}`}
                  skill={s}
                  isUser={false}
                />
              ))}
            </RegistrySection>
          )}
        </>
      )}
    </RegistryPageShell>
  );
}

export default SkillsTab;

// ── Card ─────────────────────────────────────────────────────────

function SkillCard({
  skill,
  isUser,
  onEdit,
  onDelete,
}: {
  skill: SkillRow;
  isUser: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const id = skill.id ?? '(unnamed)';

  // Phase 10 follow-up — a tone-coded source badge so the catalog
  // immediately shows where each skill came from. Same tones as
  // PermissionsTab's behavior badge: good/info/warn/neutral.
  const sourceBadge = (() => {
    switch (skill.source_kind) {
      case 'executor':
        return {
          label: t('envManagement.registry.skills.badgeExecutor'),
          tone: 'info' as const,
        };
      case 'geny':
        return {
          label: t('envManagement.registry.skills.badgeGeny'),
          tone: 'good' as const,
        };
      case 'user':
        return {
          label: t('envManagement.registry.skills.badgeUser'),
          tone: 'neutral' as const,
        };
      case 'mcp':
        return {
          label: t('envManagement.registry.skills.badgeMcp'),
          tone: 'warn' as const,
        };
      default:
        return null;
    }
  })();

  const badges = [
    ...(sourceBadge ? [sourceBadge] : []),
    ...(skill.category
      ? [{ label: skill.category, tone: 'info' as const }]
      : []),
    ...(skill.effort
      ? [{ label: skill.effort, tone: 'neutral' as const }]
      : []),
  ];
  return (
    <RegistryCard
      icon={Sparkles}
      title={`/${id}`}
      titleMono
      description={skill.description ?? skill.name ?? '—'}
      badges={badges}
      meta={
        skill.allowed_tools.length > 0
          ? t('envManagement.registry.skills.toolsCount', {
              n: String(skill.allowed_tools.length),
            })
          : undefined
      }
      variant={isUser ? 'default' : 'muted'}
      star={
        <EnvDefaultStarToggle
          category="skills"
          itemId={skillId(skill)}
        />
      }
      actions={
        isUser ? (
          <>
            {onEdit && (
              <RegistryActionButton
                icon={Pencil}
                onClick={onEdit}
                title={t('envManagement.registry.editTip')}
                variant="primary"
              />
            )}
            {onDelete && (
              <RegistryActionButton
                icon={Trash2}
                onClick={onDelete}
                title={t('envManagement.registry.deleteTip')}
                variant="danger"
              />
            )}
          </>
        ) : null
      }
    />
  );
}
