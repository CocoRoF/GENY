'use client';

/**
 * SkillsTab — host-shared skill registry. Lists every loaded skill
 * (bundled + user) and lets the operator create / edit / delete user
 * skills via /api/skills/user. A header toggle flips
 * `settings.skills.user_skills_enabled` so the skills actually load
 * on the next session.
 *
 * Cycle 20260429 Phase 8 — refactored onto the shared registry
 * primitives (RegistryPageShell + RegistrySection + RegistryCard).
 * The previous bespoke chrome (custom subtitle, hand-rolled card
 * grid) is gone; visual vocabulary now matches the env welcome
 * card and the other three host registries.
 *
 * Removed `embedded` mode — the env-side picker uses
 * HostEnvSelectionPicker (Phase 5), so this tab no longer ships
 * dual chrome.
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
import { EditorModal, ActionButton } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/i18n';
import EnvDefaultStarToggle from '@/components/env_management/EnvDefaultStarToggle';
import { useEnvDefaults } from '@/components/env_management/useEnvDefaults';
import { skillId } from '@/lib/envDefaultsApi';
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

interface FormState {
  id: string;
  name: string;
  description: string;
  body: string;
  category: string;
  effort: string;
  model_override: string;
  allowed_tools: string;
  examples: string;
  version: string;
  execution_mode: string;
  extrasText: string;
}

const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  description: '',
  body: '',
  category: '',
  effort: '',
  model_override: '',
  allowed_tools: '',
  examples: '',
  version: '',
  execution_mode: '',
  extrasText: '',
};

function formToPayload(f: FormState) {
  let extras: Record<string, string | number | boolean> | undefined;
  const trimmed = f.extrasText.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        extras = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            extras[k] = v;
          }
        }
      }
    } catch {
      extras = undefined;
    }
  }
  return {
    id: f.id.trim(),
    name: f.name.trim(),
    description: f.description.trim(),
    body: f.body,
    model_override: f.model_override.trim() || null,
    category: f.category.trim() || null,
    effort: f.effort.trim() || null,
    allowed_tools: f.allowed_tools.split(',').map((s) => s.trim()).filter(Boolean),
    examples: f.examples.split('\n').map((s) => s.trim()).filter(Boolean),
    version: f.version.trim() || null,
    execution_mode: f.execution_mode.trim() || null,
    ...(extras ? { extras } : {}),
  };
}

function detailToForm(d: SkillDetail): FormState {
  return {
    id: d.id,
    name: d.name ?? '',
    description: d.description ?? '',
    body: d.body,
    category: d.category ?? '',
    effort: d.effort ?? '',
    model_override: d.model ?? '',
    allowed_tools: d.allowed_tools.join(', '),
    examples: d.examples.join('\n'),
    version: d.version ?? '',
    execution_mode: d.execution_mode ?? '',
    extrasText:
      d.extras && Object.keys(d.extras).length > 0
        ? JSON.stringify(d.extras, null, 2)
        : '',
  };
}

export interface SkillsTabProps {
  /** Deprecated — embedded mode is no longer used after Phase 5
   *  (env-side picker uses HostEnvSelectionPicker). The prop
   *  remains for callers still passing it; it has no effect. */
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
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
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
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  };

  const openEdit = async (id: string) => {
    setEditingExisting(true);
    try {
      const detail = await skillsApi.get(id);
      setForm(detailToForm(detail));
      setEditorOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitForm = async () => {
    const payload = formToPayload(form);
    if (!payload.id || !payload.name || !payload.description) {
      setError('id, name, description are all required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingExisting) {
        await skillsApi.replaceUserSkill(payload);
      } else {
        await skillsApi.createUserSkill(payload);
      }
      toast.success(editingExisting ? `Updated /${payload.id}` : `Created /${payload.id}`);
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

      <EditorModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editingExisting ? `Edit /${form.id}` : 'New user skill'}
        saving={saving}
        width="xl"
        footer={
          <>
            <ActionButton onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </ActionButton>
            <ActionButton variant="primary" onClick={submitForm} disabled={saving}>
              {saving ? 'Saving…' : editingExisting ? 'Save' : 'Create'}
            </ActionButton>
          </>
        }
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="skill-id">ID *</Label>
            <Input
              id="skill-id"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              disabled={editingExisting}
              placeholder="lower-case, dash/underscore allowed"
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="skill-name">Name *</Label>
            <Input
              id="skill-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="skill-desc">Description *</Label>
            <Input
              id="skill-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="skill-cat">Category</Label>
              <Input
                id="skill-cat"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="skill-eff">Effort</Label>
              <Input
                id="skill-eff"
                value={form.effort}
                onChange={(e) => setForm({ ...form, effort: e.target.value })}
                placeholder="low / medium / high"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="skill-model">Model override</Label>
              <Input
                id="skill-model"
                value={form.model_override}
                onChange={(e) =>
                  setForm({ ...form, model_override: e.target.value })
                }
                className="font-mono"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="skill-tools">
              Allowed tools{' '}
              <span className="opacity-60">(CSV; empty = inherit)</span>
            </Label>
            <Input
              id="skill-tools"
              value={form.allowed_tools}
              onChange={(e) =>
                setForm({ ...form, allowed_tools: e.target.value })
              }
              placeholder="Read, Write, Bash"
              className="font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="skill-ex">
              Examples <span className="opacity-60">(one per line)</span>
            </Label>
            <Textarea
              id="skill-ex"
              value={form.examples}
              onChange={(e) => setForm({ ...form, examples: e.target.value })}
              rows={2}
              className="font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="skill-version">
                Version <span className="opacity-60">(optional)</span>
              </Label>
              <Input
                id="skill-version"
                value={form.version}
                onChange={(e) => setForm({ ...form, version: e.target.value })}
                placeholder="e.g. 1.0.0"
                className="font-mono text-[0.75rem]"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="skill-exec">Execution mode</Label>
              <Input
                id="skill-exec"
                value={form.execution_mode}
                onChange={(e) =>
                  setForm({ ...form, execution_mode: e.target.value })
                }
                placeholder="(empty = inline) inline | fork"
                className="font-mono text-[0.75rem]"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="skill-extras">
              Extras{' '}
              <span className="opacity-60">
                (JSON object, optional — host-specific metadata; flat scalars
                only)
              </span>
            </Label>
            <Textarea
              id="skill-extras"
              value={form.extrasText}
              onChange={(e) =>
                setForm({ ...form, extrasText: e.target.value })
              }
              rows={3}
              spellCheck={false}
              placeholder={'(empty = no extras)\n{"icon": "🛠", "owner": "ops"}'}
              className="font-mono text-[0.75rem]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="skill-body">
              Body{' '}
              <span className="opacity-60">(markdown — what the LLM sees)</span>
            </Label>
            <Textarea
              id="skill-body"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              rows={10}
              className="font-mono"
            />
          </div>
        </div>
      </EditorModal>
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
