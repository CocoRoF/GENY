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

  /** Group by `bundled` vs `user` for the section header. The
   *  registered category field is informational and rendered as a
   *  badge on each card; we keep grouping coarse so the operator
   *  scans bundled-then-user, not 6 small clusters. */
  const grouped = useMemo(() => {
    const bundled: SkillRow[] = [];
    const user: SkillRow[] = [];
    skills.forEach((s) => {
      if (s.id && userIds.has(s.id)) user.push(s);
      else bundled.push(s);
    });
    return { bundled, user };
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

  return (
    <>
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
            {grouped.bundled.length > 0 && (
              <RegistrySection
                label={t('envManagement.registry.skills.sectionBundled')}
                count={grouped.bundled.length}
              >
                {grouped.bundled.map((s, i) => (
                  <SkillCard
                    key={s.id ?? `bundled-${i}`}
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
          </>
        )}
      </RegistryPageShell>

      <SkillFormModal
        open={editorOpen}
        editingExisting={editingExisting}
        initialDetail={editingDetail}
        saving={saving}
        error={error}
        onClose={() => setEditorOpen(false)}
        onSubmit={handleSubmit}
      />
    </>
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
  const badges = [
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
