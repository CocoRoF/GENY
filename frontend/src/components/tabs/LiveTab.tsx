'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Inbox } from 'lucide-react';
import Selector from '@/components/ui/Selector';
import { useAppStore } from '@/store/useAppStore';
import { useVTuberStore } from '@/store/useVTuberStore';
import { useI18n } from '@/lib/i18n';
import BakedImportsModal from '@/components/avatar/BakedImportsModal';

const AvatarCanvas = dynamic(() => import('@/components/avatar/AvatarCanvas'), { ssr: false });

/**
 * LiveTab — Full session tab for Live2D avatar display.
 *
 * Features:
 *  - Model selector dropdown
 *  - Full-size Live2D rendering canvas
 *  - Emotion tester buttons (per model's emotion map)
 *  - Real-time avatar state display
 *  - SSE subscription lifecycle management
 */

export default function LiveTab() {
  const { t } = useI18n();
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const {
    models,
    modelsLoaded,
    assignments,
    avatarStates,
    fetchModels,
    assignModel,
    unassignModel,
    fetchAssignment,
    subscribeAvatar,
    unsubscribeAvatar,
    setEmotion,
    getModelForSession,
  } = useVTuberStore();

  const sessionId = selectedSessionId || '';
  const assignedModelName = assignments[sessionId];
  const currentState = avatarStates[sessionId];
  const assignedModel = getModelForSession(sessionId);
  const [bakedImportsOpen, setBakedImportsOpen] = useState(false);

  // Load models on mount
  useEffect(() => {
    if (!modelsLoaded) fetchModels();
  }, [modelsLoaded, fetchModels]);

  // Fetch assignment when session changes
  useEffect(() => {
    if (sessionId) fetchAssignment(sessionId);
  }, [sessionId, fetchAssignment]);

  // Subscribe to avatar SSE when assigned
  useEffect(() => {
    if (!sessionId || !assignedModelName) return;
    subscribeAvatar(sessionId);
    return () => unsubscribeAvatar(sessionId);
  }, [sessionId, assignedModelName, subscribeAvatar, unsubscribeAvatar]);

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-sm">
        {t('common.selectSession') ?? 'Select a session to get started'}
      </div>
    );
  }

  const emotionKeys = assignedModel ? Object.keys(assignedModel.emotionMap) : [];

  return (
    <div className="flex flex-col h-full">
      {/* ── Top Bar ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0 flex-wrap">
        {/* Model selector */}
        <div className="flex items-center gap-2">
          <label className="text-[0.75rem] text-[var(--text-muted)] font-medium">
            {t('vtuber.model') ?? 'Model'}
          </label>
          <Selector
            variant="field"
            size="sm"
            fullWidth={false}
            minWidthPx={180}
            className="min-w-[160px]"
            ariaLabel={t('vtuber.model') ?? 'Model'}
            value={assignedModelName || ''}
            onChange={(v) => {
              if (v) assignModel(sessionId, v);
              else unassignModel(sessionId);
            }}
            items={[
              { id: '', label: t('vtuber.selectModel') ?? 'Select model...' },
              ...models.map((m) => ({
                id: m.name,
                label: `[${m.runtime ?? 'live2d'}] ${m.display_name}`,
              })),
            ]}
          />

          {/* Avatar import button — shared with VTuberTab. Opens the
              baked-puppet inbox modal (geny-avatar integration). */}
          <button
            type="button"
            onClick={() => setBakedImportsOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[0.6875rem] text-[var(--text-muted)] hover:border-[var(--primary-color)] hover:text-[var(--primary-color)] cursor-pointer transition-colors"
            title={t('vtuber.importBakedTitle')}
          >
            <Inbox size={11} />
            {t('vtuber.importBaked')}
          </button>
        </div>

        {/* Emotion tester */}
        {assignedModel && emotionKeys.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[0.6875rem] text-[var(--text-muted)] font-medium mr-1">
              {t('vtuber.emotions') ?? 'Emotions'}:
            </span>
            {emotionKeys.map((emo) => (
              <button
                key={emo}
                onClick={() => setEmotion(sessionId, emo)}
                className={`px-2 py-0.5 text-[0.6875rem] rounded-full border cursor-pointer transition-all duration-150 ${
                  currentState?.emotion === emo
                    ? 'bg-[var(--primary-color)] text-white border-[var(--primary-color)]'
                    : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-color)] hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                {emo}
              </button>
            ))}
          </div>
        )}

        {/* State badge */}
        {currentState && (
          <div className="ml-auto flex items-center gap-2 text-[0.6875rem] text-[var(--text-muted)]">
            <span className="px-2 py-0.5 rounded-full bg-[rgba(59,130,246,0.1)] text-[var(--primary-color)] font-medium">
              {currentState.emotion}
            </span>
            <span className="opacity-60">
              {currentState.motion_group}[{currentState.motion_index}]
            </span>
          </div>
        )}
      </div>

      {/* ── Canvas Area ── */}
      <div className="flex-1 min-h-0 relative bg-[var(--bg-primary)]">
        {assignedModelName ? (
          <AvatarCanvas sessionId={sessionId} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[var(--text-muted)]">
            <svg className="w-16 h-16 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
            <p className="text-sm">
              {t('vtuber.noModel') ?? 'No model assigned. Select a model above.'}
            </p>
          </div>
        )}
      </div>

      <BakedImportsModal
        open={bakedImportsOpen}
        onClose={() => setBakedImportsOpen(false)}
      />
    </div>
  );
}
