'use client';

/**
 * TriggersTab — list + editor for VTuber trigger presets.
 *
 * Mirrors the registry-tab pattern (MCP / Skills / Hooks): a hero
 * shell with cards for each saved preset, an "+ 새 드래프트" button
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
  const [presets, setPresets] = useState<TriggerPresetSummary[]>([]);
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
      const list = await triggerPresetApi.list();
      setPresets(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Cache the bundled defaults once — reused as a seed for "+ 새 드래프트"
    // and as the body of the synthetic "기본값" preview card.
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
        const newName = `${summary.name} (복사본)`;
        await triggerPresetApi.duplicate(summary.id, newName);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const onReset = useCallback(
    async (summary: TriggerPresetSummary) => {
      const ok = window.confirm(
        `"${summary.name}" 의 모든 설정을 기본값으로 되돌릴까요?\n` +
          '타이밍 / 페이즈 / 카테고리 / 프롬프트가 모두 초기화됩니다.',
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
            `이 프리셋은 현재 ${used.active_count}개의 세션이 사용 중입니다:\n${sessionList}\n\n` +
              '삭제하면 해당 세션들은 자동으로 기본 트리거 동작으로 되돌아갑니다. 계속할까요?',
          );
          if (!ok) return;
        } else {
          const ok = window.confirm(
            `"${summary.name}" 프리셋을 삭제할까요?`,
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
  // Group by tag — "preset" tagged go to a featured section, the rest
  // fall under "내 프리셋". Mirrors the env-preset tag-driven section
  // pattern so operators can mark favorites or shippable presets.

  const sections = useMemo(() => {
    const featured: TriggerPresetSummary[] = [];
    const mine: TriggerPresetSummary[] = [];
    for (const p of presets) {
      if (p.tags?.includes('preset')) featured.push(p);
      else mine.push(p);
    }
    return { featured, mine };
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
      title="트리거 프리셋"
      icon={Zap}
      countLabel={`${presets.length}개 프리셋`}
      subtitle={
        <>
          VTuber 자가 발화(생각 트리거)의 타이밍, 페이즈, 카테고리, 프롬프트를
          묶은 프리셋입니다. VTuber 세션을 만들 때 선택해 부착하면 라이브 반영
          되며, 부착하지 않은 세션은 기본값으로 동작합니다.
        </>
      }
      bannerNote={
        '프리셋은 호스트 공용 — 한 번 만들면 모든 VTuber 세션에서 선택할 수 있어요. 미부착 세션은 내장 기본 트리거로 동작합니다.'
      }
      addLabel="새 드래프트"
      onAdd={openCreate}
      onRefresh={() => void refresh()}
      loading={loading}
      error={error}
      onDismissError={() => setError(null)}
    >
      {presets.length === 0 ? (
        <RegistryEmptyState
          icon={Zap}
          title="아직 만든 프리셋이 없어요"
          hint={
            '＋ 새 드래프트를 누르면 현재 기본 동작과 동일한 프리셋이 만들어져요. 거기서부터 페이즈와 확률을 조절해 보세요.'
          }
          addLabel="새 드래프트"
          onAdd={openCreate}
        />
      ) : (
        <>
          {sections.featured.length > 0 && (
            <RegistrySection
              label="공유 프리셋"
              count={sections.featured.length}
              description="`preset` 태그가 붙은 추천/공유용 프리셋"
            >
              {sections.featured.map((p) => (
                <PresetCard
                  key={p.id}
                  summary={p}
                  onEdit={() => void openEdit(p.id)}
                  onDuplicate={() => void onDuplicate(p)}
                  onReset={() => void onReset(p)}
                  onDelete={() => void onDelete(p)}
                />
              ))}
            </RegistrySection>
          )}

          <RegistrySection
            label="내 프리셋"
            count={sections.mine.length}
          >
            {sections.mine.map((p) => (
              <PresetCard
                key={p.id}
                summary={p}
                onEdit={() => void openEdit(p.id)}
                onDuplicate={() => void onDuplicate(p)}
                onReset={() => void onReset(p)}
                onDelete={() => void onDelete(p)}
              />
            ))}
          </RegistrySection>
        </>
      )}
    </RegistryPageShell>
  );
}

interface PresetCardProps {
  summary: TriggerPresetSummary;
  onEdit: () => void;
  onDuplicate: () => void;
  onReset: () => void;
  onDelete: () => void;
}

function PresetCard({
  summary,
  onEdit,
  onDuplicate,
  onReset,
  onDelete,
}: PresetCardProps) {
  const updated = summary.updated_at
    ? new Date(summary.updated_at).toLocaleString()
    : '';
  return (
    <RegistryCard
      icon={summary.enabled ? Zap : ZapOff}
      title={summary.name}
      description={summary.description || ' '}
      badges={[
        {
          label: `${summary.category_count} 상황`,
          tone: 'info',
        },
        {
          label: `${summary.prompt_count} 프롬프트`,
          tone: 'neutral',
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
          <RegistryActionButton
            icon={Edit3}
            onClick={onEdit}
            title="편집"
            variant="primary"
          />
          <RegistryActionButton
            icon={Copy}
            onClick={onDuplicate}
            title="복제"
          />
          <RegistryActionButton
            icon={RotateCcw}
            onClick={onReset}
            title="기본값으로 초기화"
          />
          <RegistryActionButton
            icon={Trash2}
            onClick={onDelete}
            title="삭제"
            variant="danger"
          />
        </>
      }
      onClick={onEdit}
    />
  );
}
