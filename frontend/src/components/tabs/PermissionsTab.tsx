'use client';

/**
 * PermissionsTab — view & edit the executor's permission rules
 * (PR-E.2.2). Lives behind the dev-only "Permissions" global tab.
 *
 * Cycle 20260429 Phase 9.5 — split the form into a dedicated
 * `PermissionFormModal` (sectioned, localised, with visual radio
 * cards for the allow/deny/ask choice + per-field hints); this file
 * is now the list view + CRUD orchestration. Mirrors what 9.1-9.4
 * did for MCP / Skill / Hook.
 *
 * Read state comes from /api/permissions/list (cascade-merged) so the
 * operator sees what the matrix actually loaded — including yaml-only
 * rules that aren't editable here. Writes go through /api/permissions/rules
 * which mutates user-scope settings.json. Rules from non-user sources
 * surface in the table read-only with a hint pointing at the file.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  permissionApi,
  PermissionRulePayload,
  PermissionListResponse,
  PermissionRulesResponse,
  PERMISSION_MODES,
  EXECUTOR_PERMISSION_MODES,
} from '@/lib/api';
import { Pencil, Shield, Trash2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import EnvDefaultStarToggle from '@/components/env_management/EnvDefaultStarToggle';
import { useEnvDefaults } from '@/components/env_management/useEnvDefaults';
import { permissionId } from '@/lib/envDefaultsApi';
import PermissionFormModal from '@/components/env_management/permissions/PermissionFormModal';
import {
  RegistryPageShell,
  RegistryGrid,
  RegistryCard,
  RegistryEmptyState,
  RegistryActionButton,
} from '@/components/env_management/registry';

export interface PermissionsTabProps {
  /** Deprecated — embedded mode is no longer used after Phase 5. */
  embedded?: boolean;
}

export function PermissionsTab(_props: PermissionsTabProps = {}) {
  const { t } = useI18n();
  const [editable, setEditable] = useState<PermissionRulesResponse | null>(null);
  const [inspect, setInspect] = useState<PermissionListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEnvDefaultsOnce = useEnvDefaults((s) => s.loadOnce);
  useEffect(() => {
    loadEnvDefaultsOnce();
  }, [loadEnvDefaultsOnce]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingRule, setEditingRule] = useState<PermissionRulePayload | null>(null);
  const [saving, setSaving] = useState(false);

  // R.1 (cycle 20260426_2) — mode pickers reflect settings.json values
  // (null = section absent → install layer falls back to env / default).
  const [savingMode, setSavingMode] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [edit, ins] = await Promise.all([
        permissionApi.listEditable(),
        permissionApi.inspect(),
      ]);
      setEditable(edit);
      setInspect(ins);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const editableCount = editable?.rules.length ?? 0;
  const inspectCount = inspect?.rules.length ?? 0;

  // Map index in editable.rules to ensure delete/replace target the
  // user-scope file. Non-user-scope rules from inspect are read-only
  // here (their PUT target index doesn't exist in editable).
  const editableIdxByKey = useMemo(() => {
    const map = new Map<string, number>();
    editable?.rules.forEach((r, idx) => {
      const key = `${r.tool_name}::${r.pattern ?? ''}::${r.behavior}::${r.source}`;
      map.set(key, idx);
    });
    return map;
  }, [editable]);

  const openCreate = () => {
    setEditingIdx(null);
    setEditingRule(null);
    setError(null);
    setEditorOpen(true);
  };

  const openEdit = (idx: number) => {
    const r = editable?.rules[idx];
    if (!r) return;
    setEditingIdx(idx);
    setEditingRule(r);
    setError(null);
    setEditorOpen(true);
  };

  const handleSubmit = async (payload: PermissionRulePayload) => {
    setSaving(true);
    setError(null);
    try {
      const res =
        editingIdx === null
          ? await permissionApi.append(payload)
          : await permissionApi.replace(editingIdx, payload);
      setEditable(res);
      // Inspect view will go stale until next refresh; trigger one.
      try {
        const ins = await permissionApi.inspect();
        setInspect(ins);
      } catch {/* keep stale inspect — no harm */}
      toast.success(
        editingIdx === null ? 'Permission rule added' : 'Permission rule updated',
      );
      setEditorOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleModeChange = async (
    field: 'mode' | 'executor_mode',
    value: string,
  ) => {
    setSavingMode(true);
    setError(null);
    try {
      const res = await permissionApi.patchMode({ [field]: value });
      setEditable(res);
      try {
        const ins = await permissionApi.inspect();
        setInspect(ins);
      } catch {/* keep stale inspect */}
      toast.success(`Permission ${field} = ${value}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingMode(false);
    }
  };

  const deleteRule = async (idx: number) => {
    const target = editable?.rules[idx];
    if (!target) return;
    const confirmed = window.confirm(
      `Delete permission rule for ${target.tool_name} (${target.behavior})?`,
    );
    if (!confirmed) return;
    setError(null);
    try {
      const res = await permissionApi.remove(idx);
      setEditable(res);
      try {
        const ins = await permissionApi.inspect();
        setInspect(ins);
      } catch {/* keep stale inspect */}
      toast.success(`Removed rule for ${target.tool_name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const subtitle = (
    <>
      Mode: <span className="font-mono uppercase">{inspect?.mode ?? '—'}</span>{' '}
      · {inspectCount} loaded · {editableCount} editable
      {editable && (
        <>
          {' · '}
          <span className="font-mono">{editable.settings_path}</span>
        </>
      )}
    </>
  );

  // Phase 9.9.4 — surface what each mode actually does. The two
  // selectors are orthogonal: `mode` is Geny's runner-level meta-policy
  // (advisory = open, enforce = strict), `executor_mode` is the
  // executor's PermissionMode enum value the matrix consumes.
  const RUNNER_MODE_HINT: Record<string, string> = {
    advisory:
      '느슨함 — 사용자가 고른 executor 모드(default / plan / bypass …)가 그대로 적용. 권한 룰은 평소대로 평가됩니다.',
    enforce:
      '엄격함 — bypass / auto / dontAsk / acceptEdits 같은 권한 무력화 모드를 default로 강제 다운그레이드. 룰이 절대 우회되지 않게 합니다.',
  };
  const EXECUTOR_MODE_HINT: Record<string, string> = {
    default: '기본 — 룰이 결정. 매칭 룰이 없으면 도구 자체의 check_permissions 폴백.',
    plan: '계획 모드 — 파괴적 도구는 명시적 ALLOW 룰이 없으면 자동 ASK.',
    auto: '자동 — 룰이 없는 호출도 모두 허용 (CI 등 비대화형). DENY 룰은 여전히 차단.',
    bypass: '우회 — 모든 권한 게이트 무시 (DENY까지). 개발 전용.',
    acceptEdits: 'Edit-친화 — 편집 도구의 ASK 룰을 자동 ALLOW로 승격.',
    dontAsk: '묻지 않음 — 모든 ASK 룰을 자동 ALLOW로 승격. DENY는 그대로.',
  };
  const runnerMode = editable?.mode ?? inspect?.mode ?? 'advisory';
  const execMode = editable?.executor_mode ?? 'default';
  const modeSelectors = (
    <div className="hidden md:flex items-center gap-1.5">
      <span
        className="text-[0.6875rem] uppercase text-[hsl(var(--muted-foreground))] font-semibold tracking-wider"
        title="Geny 러너 모드 — advisory(기본)는 열려 있고 enforce는 권한 무력화 모드를 차단합니다."
      >
        Mode
      </span>
      <Select
        value={runnerMode}
        onValueChange={(v) => handleModeChange('mode', v)}
        disabled={savingMode}
      >
        <SelectTrigger
          className="h-7 w-[110px] text-[0.75rem]"
          title={RUNNER_MODE_HINT[runnerMode] ?? ''}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERMISSION_MODES.map((m) => (
            <SelectItem key={m} value={m} title={RUNNER_MODE_HINT[m] ?? ''}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span
        className="text-[0.6875rem] uppercase text-[hsl(var(--muted-foreground))] font-semibold tracking-wider ml-2"
        title="Executor 모드 — 매트릭스가 ALLOW/DENY/ASK를 결정할 때 쓰는 PermissionMode 값."
      >
        Exec
      </span>
      <Select
        value={execMode}
        onValueChange={(v) => handleModeChange('executor_mode', v)}
        disabled={savingMode}
      >
        <SelectTrigger
          className="h-7 w-[120px] text-[0.75rem]"
          title={EXECUTOR_MODE_HINT[execMode] ?? ''}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EXECUTOR_PERMISSION_MODES.map((m) => (
            <SelectItem key={m} value={m} title={EXECUTOR_MODE_HINT[m] ?? ''}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {runnerMode === 'enforce' &&
        (
          ['bypass', 'auto', 'dontAsk', 'acceptEdits'] as const
        ).includes(
          execMode as 'bypass' | 'auto' | 'dontAsk' | 'acceptEdits',
        ) && (
          <span
            className="ml-1 inline-flex items-center h-7 px-2 rounded-md text-[0.65rem] font-semibold border border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
            title="enforce 모드에서 권한 무력화 executor 모드는 세션 시작 시 default로 다운그레이드됩니다."
          >
            ⚠ → default
          </span>
        )}
    </div>
  );

  const sourcesFooter = inspect?.sources_consulted &&
    inspect.sources_consulted.length > 0 && (
      <details className="text-[0.75rem] text-[hsl(var(--muted-foreground))]">
        <summary className="cursor-pointer">
          Sources consulted ({inspect.sources_consulted.length})
        </summary>
        <ul className="mt-1 ml-4 list-disc">
          {inspect.sources_consulted.map((p) => (
            <li key={p} className="font-mono">
              {p}
            </li>
          ))}
        </ul>
      </details>
    );

  const isEmpty = (inspect?.rules ?? []).length === 0 && !loading;
  const addLabel = t('envManagement.registry.permissions.addLabel');

  if (editorOpen) {
    return (
      <PermissionFormModal
        editingIdx={editingIdx}
        initialRule={editingRule}
        saving={saving}
        error={error}
        onClose={() => setEditorOpen(false)}
        onSubmit={handleSubmit}
      />
    );
  }

  return (
    <RegistryPageShell
      icon={Shield}
      title={t('envManagement.registry.permissions.title')}
      subtitle={subtitle}
      countLabel={t('envManagement.registry.permissions.countLabel', {
        n: String(inspectCount),
      })}
      bannerNote={t('envManagement.registry.permissions.bannerNote')}
      addLabel={addLabel}
      onAdd={openCreate}
      onRefresh={refresh}
      loading={loading}
      error={error}
      onDismissError={() => setError(null)}
      headerExtras={modeSelectors}
    >
      {isEmpty ? (
        <RegistryEmptyState
          icon={Shield}
          title={t('envManagement.registry.permissions.emptyTitle')}
          hint={t('envManagement.registry.emptyHint', { addLabel })}
          addLabel={addLabel}
          onAdd={openCreate}
        />
      ) : (
        <RegistryGrid>
          {(inspect?.rules ?? []).map((r, viewIdx) => {
            const key = `${r.tool_name}::${r.pattern ?? ''}::${r.behavior}::${r.source}`;
            const editIdx = editableIdxByKey.get(key);
            const editableRow = editIdx !== undefined;
            return (
              <PermissionCard
                key={`${key}-${viewIdx}`}
                rule={r}
                editable={editableRow}
                onEdit={editableRow ? () => openEdit(editIdx!) : undefined}
                onDelete={editableRow ? () => deleteRule(editIdx!) : undefined}
              />
            );
          })}
        </RegistryGrid>
      )}

      {sourcesFooter}
    </RegistryPageShell>
  );
}

export default PermissionsTab;

// ── Card ─────────────────────────────────────────────────────────

function PermissionCard({
  rule,
  editable,
  onEdit,
  onDelete,
}: {
  rule: { tool_name: string; pattern: string | null; behavior: string; source: string; reason: string | null };
  editable: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  return (
    <RegistryCard
      icon={Shield}
      title={rule.tool_name}
      titleMono
      subtitle={rule.pattern ? rule.pattern : undefined}
      description={rule.reason ?? undefined}
      badges={[
        {
          label: rule.behavior,
          tone:
            rule.behavior === 'allow'
              ? 'good'
              : rule.behavior === 'deny'
                ? 'danger'
                : 'warn',
        },
        { label: rule.source, tone: editable ? 'neutral' : 'info' },
      ]}
      variant={editable ? 'default' : 'muted'}
      meta={editable ? undefined : 'external'}
      star={
        <EnvDefaultStarToggle
          category="permissions"
          itemId={permissionId({
            tool_name: rule.tool_name,
            pattern: rule.pattern,
            behavior: rule.behavior,
          })}
        />
      }
      actions={
        editable ? (
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
