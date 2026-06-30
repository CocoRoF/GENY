'use client';

/**
 * CompactMetaBar — single-row chrome for /environments.
 *
 * Cycle 20260429 follow-up — absorbed the navigation cluster
 * (← 홈으로 + tab dropdown) so /environments has exactly ONE
 * header row regardless of state. Operator's previous complaint
 * (this bar stacked on top of EnvManagementHeader producing a
 * double header) is fixed by merging both surfaces here.
 *
 * Layout (left → right):
 *
 *   [← 홈으로] [Tab Dropdown ▼]                                  ← always
 *   ──────────── conditionally, when env tab + draft ────────────
 *   | [name input] [ⓘ desc] [tags] | [warn] | [전역] [버리기] [저장]
 *
 * The tab dropdown ("환경관리 ▼") replaced the previous 5-tab
 * strip — clicking it pops a 5-option panel below. Single
 * trigger = single source of "where am I", which is what the
 * operator wanted. See `TabSwitcherDropdown` in
 * EnvManagementHeader.tsx for the dropdown internals.
 *
 * Description and full validation list move into popovers (click
 * the ⓘ button or "X warnings" chip) so the bar stays at ~52px
 * tall regardless of content.
 */

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  Info,
  Plus,
  Save,
  Settings2,
  X,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ActionButton } from '@/components/common/layout';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import { environmentApi } from '@/lib/environmentApi';
import type { EnvironmentSessionSummary } from '@/types/environment';
import ConfirmModal from '@/components/modals/ConfirmModal';
import {
  TabSwitcherDropdown,
  type EnvManagementTab,
} from './EnvManagementHeader';

export interface CompactMetaBarProps {
  /** Which top-level tab is active. Drives whether env-specific
   *  fields (name/tags/save) render alongside the nav cluster. */
  activeTab: EnvManagementTab;
  onSaved: (newEnvId: string) => void;
  onOpenGlobals: () => void;
}

export default function CompactMetaBar({
  activeTab,
  onSaved,
  onOpenGlobals,
}: CompactMetaBarProps) {
  const { t } = useI18n();
  const draft = useEnvironmentDraftStore((s) => s.draft);
  const saving = useEnvironmentDraftStore((s) => s.saving);
  const errorBanner = useEnvironmentDraftStore((s) => s.error);
  const validationErrors = useEnvironmentDraftStore((s) => s.validationErrors);
  const resetDraft = useEnvironmentDraftStore((s) => s.resetDraft);
  const patchMetadata = useEnvironmentDraftStore((s) => s.patchMetadata);
  const saveDraft = useEnvironmentDraftStore((s) => s.saveDraft);
  const isDirty = useEnvironmentDraftStore((s) => s.isDirty);
  const stageDirty = useEnvironmentDraftStore((s) => s.stageDirty);
  const clearError = useEnvironmentDraftStore((s) => s.clearError);
  const editingId = useEnvironmentDraftStore((s) => s.editingId);

  const [descOpen, setDescOpen] = useState(false);
  const [validOpen, setValidOpen] = useState(false);
  const [tagInput, setTagInput] = useState('');
  // Active sessions that will pick up the edited manifest — shown in a
  // confirm before an EDIT save commits (propagation lands on next turn).
  const [confirmActive, setConfirmActive] = useState<EnvironmentSessionSummary[] | null>(null);
  const [checkingSessions, setCheckingSessions] = useState(false);
  // "Save before leaving?" prompt — opened by the Back button when the
  // draft is dirty. For preset-seeded drafts the env may have no name yet,
  // so the modal hosts a required name input before Save & leave unlocks.
  const [leaveOpen, setLeaveOpen] = useState(false);
  const descRef = useRef<HTMLDivElement | null>(null);
  const validRef = useRef<HTMLDivElement | null>(null);

  // Close popovers on outside click
  useEffect(() => {
    if (!descOpen && !validOpen) return;
    const handler = (e: MouseEvent) => {
      if (descOpen && descRef.current && !descRef.current.contains(e.target as Node)) {
        setDescOpen(false);
      }
      if (validOpen && validRef.current && !validRef.current.contains(e.target as Node)) {
        setValidOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [descOpen, validOpen]);

  // Escape closes the "save before leaving?" prompt = cancel (stay),
  // matching ConfirmModal's Escape-to-close behaviour.
  useEffect(() => {
    if (!leaveOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLeaveOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [leaveOpen]);

  // env-edit fields render only when both apply: we're on the
  // environments tab AND a draft is loaded. Other states (registry
  // tabs, env tab pre-draft) render just the nav cluster — single
  // row, no env metadata.
  const showEnvFields = activeTab === 'environments' && !!draft;

  const nameValid = draft ? draft.metadata.name.trim().length > 0 : false;
  const errorCount = validationErrors.filter((e) => e.severity === 'error').length;
  const warningCount = validationErrors.filter((e) => e.severity !== 'error').length;
  const blockedByValidation = errorCount > 0;
  const busy = saving || checkingSessions;
  const saveDisabled =
    !showEnvFields || !nameValid || blockedByValidation || busy;

  // The actual commit — saveDraft (which PUTs the manifest; the backend
  // flags live sessions to reload on their next turn) then hands control
  // back to the page for post-save navigation.
  const doSave = async () => {
    if (!draft) return;
    setConfirmActive(null);
    try {
      const res = await saveDraft({
        name: draft.metadata.name,
        description: draft.metadata.description,
        tags: draft.metadata.tags,
      });
      onSaved(res.id);
    } catch {
      /* error surfaces via store.error */
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    // Editing an existing env → warn which active sessions use it before
    // committing (they re-apply the manifest on their next turn).
    if (editingId) {
      setCheckingSessions(true);
      try {
        const res = await environmentApi.linkedSessions(editingId);
        const active = res.sessions.filter((s) => !s.is_deleted);
        if (active.length > 0) {
          setConfirmActive(active);
          return; // hold for the confirm
        }
      } catch {
        /* session check failed — fall through and save anyway */
      } finally {
        setCheckingSessions(false);
      }
    }
    await doSave();
  };

  // Back — graceful exit. Clean draft drops straight to the overview
  // (resetDraft is state-driven). A dirty draft opens the "save before
  // leaving?" prompt instead of discarding silently.
  const handleBack = () => {
    if (!isDirty()) {
      resetDraft();
      return;
    }
    setLeaveOpen(true);
  };

  const handleSaveAndLeave = async () => {
    setLeaveOpen(false);
    // handleSave handles the existing-env active-session check + saves;
    // saveDraft clears the draft on success → overview.
    await handleSave();
  };

  const handleDontSave = () => {
    setLeaveOpen(false);
    resetDraft();
  };

  const addTag = () => {
    if (!draft) return;
    const tag = tagInput.trim();
    if (!tag) return;
    if ((draft.metadata.tags || []).includes(tag)) {
      setTagInput('');
      return;
    }
    patchMetadata({ tags: [...(draft.metadata.tags || []), tag] });
    setTagInput('');
  };

  const removeTag = (tag: string) => {
    if (!draft) return;
    patchMetadata({
      tags: (draft.metadata.tags || []).filter((t) => t !== tag),
    });
  };

  return (
    <>
    <div className="flex items-center gap-3 h-[52px] px-4 border-b border-[hsl(var(--border))] bg-[hsl(var(--card))] shrink-0">
      {/* ── Back: 뒤로가기 while editing an env (graceful save-or-discard exit
              to the overview), 홈으로 otherwise. ── */}
      {showEnvFields ? (
        <button
          type="button"
          onClick={handleBack}
          disabled={saving}
          className="inline-flex items-center gap-1 h-7 px-2 rounded text-[0.75rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--accent))] shrink-0 disabled:opacity-50"
          title={t('envManagement.backButton')}
        >
          <ArrowLeft size={13} />
          {t('envManagement.backButton')}
        </button>
      ) : (
        <Link
          href="/"
          className="inline-flex items-center gap-1 h-7 px-2 rounded text-[0.75rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] no-underline transition-colors hover:bg-[hsl(var(--accent))] shrink-0"
          title="메인으로"
        >
          <ArrowLeft size={13} />
          {t('envManagement.backToHome')}
        </Link>
      )}
      <div className="w-px h-4 bg-[hsl(var(--border))] shrink-0" />

      {/* ── Tab switcher dropdown (always) ── */}
      <TabSwitcherDropdown active={activeTab} />

      {!showEnvFields && (
        <>
          <div className="flex-1" />
          {errorBanner && (
            <button
              type="button"
              onClick={clearError}
              className="inline-flex items-center gap-1 text-[0.7rem] text-red-600 dark:text-red-400 hover:underline shrink-0"
            >
              <AlertTriangle className="w-3 h-3" />
              {errorBanner}
              <X className="w-3 h-3 ml-1" />
            </button>
          )}
        </>
      )}

      {showEnvFields && draft && (
        <>
          <div className="w-px h-4 bg-[hsl(var(--border))] shrink-0" />
          {/* env-edit fields below — extracted into a fragment so
              the conditional gate sits at one explicit boundary
              instead of repeating `showEnvFields &&` per element. */}
          <EnvEditFields
            draft={draft}
            tagInput={tagInput}
            setTagInput={setTagInput}
            descOpen={descOpen}
            setDescOpen={setDescOpen}
            descRef={descRef}
            validOpen={validOpen}
            setValidOpen={setValidOpen}
            validRef={validRef}
            stageDirty={stageDirty}
            validationErrors={validationErrors}
            errorCount={errorCount}
            warningCount={warningCount}
            nameValid={nameValid}
            saveDisabled={saveDisabled}
            saving={busy}
            patchMetadata={patchMetadata}
            addTag={addTag}
            removeTag={removeTag}
            handleSave={handleSave}
            onOpenGlobals={onOpenGlobals}
            t={t}
          />
        </>
      )}
    </div>

    {confirmActive && (
      <ConfirmModal
        title={t('envManagement.applyToSessionsTitle')}
        message={
          <div>
            <p>{t('envManagement.applyToSessionsBody', { n: String(confirmActive.length) })}</p>
            <ul className="mt-2 max-h-44 overflow-y-auto flex flex-col gap-0.5 text-[0.8125rem]">
              {confirmActive.slice(0, 12).map((s) => (
                <li key={s.session_id} className="flex items-center gap-1.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      s.status === 'running' || s.status === 'idle'
                        ? 'bg-[var(--success-color)]'
                        : s.status === 'error'
                        ? 'bg-[var(--danger-color)]'
                        : 'bg-[hsl(var(--muted-foreground))]'
                    }`}
                  />
                  <span className="truncate text-[hsl(var(--foreground))]">
                    {s.session_name || s.session_id.slice(0, 8)}
                  </span>
                  {s.role && (
                    <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))]">· {s.role}</span>
                  )}
                </li>
              ))}
              {confirmActive.length > 12 && (
                <li className="text-[hsl(var(--muted-foreground))]">
                  +{confirmActive.length - 12} more
                </li>
              )}
            </ul>
          </div>
        }
        note={t('envManagement.applyToSessionsNote')}
        onConfirm={doSave}
        onClose={() => setConfirmActive(null)}
      />
    )}

    {leaveOpen && (
      // "Save before leaving?" — custom 3-button prompt (Save & leave /
      // Don't save / Cancel) hosting an optional required name input for
      // preset-seeded drafts. Mirrors ConfirmModal's overlay/panel
      // classes; overlay click / Escape = cancel (stay).
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={() => setLeaveOpen(false)}
      >
        <div
          className="bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl w-full max-w-[400px] max-h-[85vh] flex flex-col shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex justify-between items-center py-4 px-6 border-b border-[hsl(var(--border))]">
            <h3 className="text-[1rem] font-semibold text-[hsl(var(--foreground))]">
              {t('envManagement.saveBeforeLeaveTitle')}
            </h3>
            <button
              className="flex items-center justify-center w-8 h-8 rounded-md bg-transparent border-none text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] cursor-pointer transition-colors"
              onClick={() => setLeaveOpen(false)}
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
            {!draft || draft.metadata.name.trim() === '' ? (
              <div className="flex flex-col gap-1.5">
                <label className="text-[0.6875rem] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                  {t('envManagement.envNameLabel')}
                </label>
                <Input
                  value={draft?.metadata.name ?? ''}
                  onChange={(e) => patchMetadata({ name: e.target.value })}
                  placeholder={t('envManagement.namePlaceholder')}
                  className="h-8 text-[0.8125rem]"
                  autoFocus
                />
                <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))]">
                  {t('envManagement.presetNamePrompt')}
                </p>
              </div>
            ) : (
              <div className="text-[0.8125rem] text-[hsl(var(--muted-foreground))]">
                {t('envManagement.saveBeforeLeaveDirty')}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end items-center gap-2 py-4 px-6 border-t border-[hsl(var(--border))]">
            <button
              className="inline-flex items-center h-8 px-3 rounded-md border border-[hsl(var(--border))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] cursor-pointer transition-colors"
              onClick={() => setLeaveOpen(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              className="inline-flex items-center h-8 px-3 rounded-md border border-[hsl(var(--border))] text-[0.8125rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] cursor-pointer transition-colors"
              onClick={handleDontSave}
            >
              {t('envManagement.dontSave')}
            </button>
            <button
              className="inline-flex items-center h-8 px-3.5 rounded-md bg-violet-500 hover:bg-violet-600 text-white text-[0.8125rem] font-medium cursor-pointer transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleSaveAndLeave}
              disabled={!draft || draft.metadata.name.trim() === ''}
            >
              {t('envManagement.saveAndLeave')}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

interface EnvEditFieldsProps {
  draft: NonNullable<ReturnType<typeof useEnvironmentDraftStore.getState>['draft']>;
  tagInput: string;
  setTagInput: (v: string) => void;
  descOpen: boolean;
  setDescOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  descRef: React.RefObject<HTMLDivElement | null>;
  validOpen: boolean;
  setValidOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  validRef: React.RefObject<HTMLDivElement | null>;
  stageDirty: Set<number>;
  validationErrors: ReturnType<typeof useEnvironmentDraftStore.getState>['validationErrors'];
  errorCount: number;
  warningCount: number;
  nameValid: boolean;
  saveDisabled: boolean;
  saving: boolean;
  patchMetadata: ReturnType<typeof useEnvironmentDraftStore.getState>['patchMetadata'];
  addTag: () => void;
  removeTag: (tag: string) => void;
  handleSave: () => Promise<void>;
  onOpenGlobals: () => void;
  t: (k: string, vars?: Record<string, string>) => string;
}

function EnvEditFields({
  draft,
  tagInput,
  setTagInput,
  descOpen,
  setDescOpen,
  descRef,
  validOpen,
  setValidOpen,
  validRef,
  stageDirty,
  validationErrors,
  errorCount,
  warningCount,
  nameValid,
  saveDisabled,
  saving,
  patchMetadata,
  addTag,
  removeTag,
  handleSave,
  onOpenGlobals,
  t,
}: EnvEditFieldsProps) {
  return (
    <>
      {/* ── Name input ── */}
      <div className="flex items-center gap-1.5">
        <span className="text-[0.625rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
          {t('envManagement.nameLabel')}
        </span>
        <Input
          value={draft.metadata.name}
          onChange={(e) => patchMetadata({ name: e.target.value })}
          placeholder={t('envManagement.namePlaceholder')}
          className={`h-7 w-[180px] text-[0.8125rem] font-medium ${
            !nameValid ? 'border-red-500/50' : ''
          }`}
        />
      </div>

      {/* ── Description popover trigger ── */}
      <div className="relative" ref={descRef}>
        <button
          type="button"
          onClick={() => setDescOpen((v) => !v)}
          className={`inline-flex items-center justify-center w-7 h-7 rounded-md border transition-colors ${
            draft.metadata.description
              ? 'border-[hsl(var(--primary)/0.4)] bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--primary))]'
              : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]'
          }`}
          title={t('envManagement.compactBar.descriptionTip')}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
        {descOpen && (
          <div className="absolute left-0 top-full mt-1 z-30 w-[360px] p-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-lg">
            <label className="text-[0.6875rem] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              {t('envManagement.descriptionLabel')}
            </label>
            <Textarea
              value={draft.metadata.description}
              onChange={(e) => patchMetadata({ description: e.target.value })}
              placeholder={t('envManagement.descriptionPlaceholder')}
              rows={3}
              className="mt-1 text-[0.8125rem] resize-none"
              autoFocus
            />
          </div>
        )}
      </div>

      {/* ── Tags inline ── */}
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto scrollbar-hide">
        {(draft.metadata.tags || []).slice(0, 6).map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[hsl(var(--accent))] text-[0.6875rem] text-[hsl(var(--foreground))] shrink-0"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-[hsl(var(--muted-foreground))] hover:text-red-500 leading-none"
              aria-label="remove tag"
            >
              ×
            </button>
          </span>
        ))}
        {(draft.metadata.tags || []).length > 6 && (
          <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] shrink-0">
            +{(draft.metadata.tags || []).length - 6}
          </span>
        )}
        <div className="inline-flex items-center gap-0.5 shrink-0">
          <Input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addTag();
              }
            }}
            placeholder={t('envManagement.addTag')}
            className="h-6 w-[100px] text-[0.6875rem]"
          />
          {tagInput.trim() && (
            <button
              type="button"
              onClick={addTag}
              className="inline-flex items-center justify-center w-6 h-6 rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))]"
              aria-label="add tag"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── Status pills ── */}
      <div className="flex items-center gap-2 shrink-0">
        {stageDirty.size > 0 && (
          <span className="text-[0.6875rem] text-[hsl(var(--muted-foreground))] tabular-nums">
            {t('envManagement.editedStages', { n: String(stageDirty.size) })}
          </span>
        )}
        {(errorCount > 0 || warningCount > 0) && (
          <div className="relative" ref={validRef}>
            <button
              type="button"
              onClick={() => setValidOpen((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[0.6875rem] font-medium transition-colors ${
                errorCount > 0
                  ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
              }`}
            >
              <AlertTriangle className="w-3 h-3" />
              {errorCount > 0
                ? t('envManagement.validationErrorsRed', { n: String(errorCount) })
                : t('envManagement.validationWarnings', { n: String(warningCount) })}
            </button>
            {validOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 w-[420px] max-h-[380px] overflow-y-auto p-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-lg">
                <div className="text-[0.6875rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))] mb-2">
                  {t('envManagement.viewValidationDetails')}
                </div>
                <ul className="flex flex-col gap-1">
                  {validationErrors.map((v, i) => (
                    <li
                      key={`${v.path}_${i}`}
                      className={`flex items-start gap-1.5 px-2 py-1.5 rounded border ${
                        v.severity === 'error'
                          ? 'bg-red-500/5 border-red-500/30 text-red-700 dark:text-red-300'
                          : 'bg-amber-500/5 border-amber-500/30 text-amber-700 dark:text-amber-300'
                      }`}
                    >
                      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0 text-[0.7rem]">
                        <code className="text-[0.625rem] font-mono opacity-70">
                          {v.path}
                        </code>
                        <div className="mt-0.5">{v.message}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Globals + Discard + Save ── */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onOpenGlobals}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.7rem] font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-colors"
          title={t('envManagement.compactBar.globalsTip')}
        >
          <Settings2 className="w-3.5 h-3.5" />
          {t('envManagement.compactBar.globalsLabel')}
        </button>
        <ActionButton
          variant="primary"
          icon={Save}
          onClick={handleSave}
          disabled={saveDisabled}
          spinIcon={saving}
        >
          {saving ? t('envManagement.saving') : t('envManagement.save')}
        </ActionButton>
      </div>
    </>
  );
}

