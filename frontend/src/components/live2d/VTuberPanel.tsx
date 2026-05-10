'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Inbox } from 'lucide-react';
import { useVTuberStore } from '@/store/useVTuberStore';
import { useI18n } from '@/lib/i18n';
import BakedImportsModal from '@/components/avatar/BakedImportsModal';

// Dynamic import — AvatarCanvas pulls pixi.js + Spine runtime, both
// browser-only. AvatarCanvas dispatches between Live2DCanvas and
// SpineCanvas based on the assigned model's `runtime` field.
const AvatarCanvas = dynamic(() => import('@/components/avatar/AvatarCanvas'), { ssr: false });

/**
 * VTuberPanel — wraps Live2DCanvas with model selector, emotion info, and SSE lifecycle.
 *
 * This component handles:
 *  - Loading models from backend on mount
 *  - Fetching the current agent-model assignment
 *  - Starting/stopping the avatar state SSE subscription
 *  - Model selection UI
 *  - Displaying current emotion state
 */

interface VTuberPanelProps {
  sessionId: string;
  className?: string;
  /** If true, show the model picker and controls. Default true. */
  showControls?: boolean;
}

export default function VTuberPanel({
  sessionId,
  className = '',
  showControls = true,
}: VTuberPanelProps) {
  const { t } = useI18n();
  const {
    models,
    modelsLoaded,
    assignments,
    avatarStates,
    fetchModels,
    assignModel,
    fetchAssignment,
    subscribeAvatar,
    unsubscribeAvatar,
  } = useVTuberStore();

  const assignedModelName = assignments[sessionId];
  const currentState = avatarStates[sessionId];
  const [bakedImportsOpen, setBakedImportsOpen] = useState(false);

  // Load models on mount
  useEffect(() => {
    if (!modelsLoaded) fetchModels();
  }, [modelsLoaded, fetchModels]);

  // Fetch current assignment for this session
  useEffect(() => {
    if (sessionId) fetchAssignment(sessionId);
  }, [sessionId, fetchAssignment]);

  // Subscribe to avatar state SSE when a model is assigned
  useEffect(() => {
    if (!sessionId || !assignedModelName) return;
    subscribeAvatar(sessionId);
    return () => unsubscribeAvatar(sessionId);
  }, [sessionId, assignedModelName, subscribeAvatar, unsubscribeAvatar]);

  const handleModelChange = async (modelName: string) => {
    if (!sessionId) return;
    try {
      await assignModel(sessionId, modelName);
    } catch {
      // Error already logged in store
    }
  };

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Controls bar */}
      {showControls && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0">
          {/* Model selector */}
          <label className="text-[0.75rem] text-[var(--text-muted)] font-medium shrink-0">
            {t('vtuber.model') ?? 'Model'}
          </label>
          <select
            className="flex-1 min-w-0 px-2 py-1 text-[0.75rem] rounded-md bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] outline-none cursor-pointer"
            value={assignedModelName || ''}
            onChange={(e) => handleModelChange(e.target.value)}
          >
            <option value="" disabled>
              {t('vtuber.selectModel') ?? 'Select model...'}
            </option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                [{m.runtime ?? 'live2d'}] {m.display_name}
              </option>
            ))}
          </select>

          {/* Avatar import button — surfaces baked-zip inbox from
              the avatar-editor service. Hidden when no controls. */}
          <button
            type="button"
            onClick={() => setBakedImportsOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--text-muted)] hover:border-[var(--primary-color)] hover:text-[var(--primary-color)]"
            title="Avatar Editor 에서 보낸 puppet 가져오기"
          >
            <Inbox size={11} />
            가져오기
          </button>

          {/* Current emotion badge */}
          {currentState && (
            <span className="px-2 py-0.5 text-[0.6875rem] font-medium rounded-full bg-[rgba(59,130,246,0.1)] text-[var(--primary-color)] shrink-0">
              {currentState.emotion}
            </span>
          )}
        </div>
      )}

      <BakedImportsModal
        open={bakedImportsOpen}
        onClose={() => setBakedImportsOpen(false)}
      />

      {/* Canvas area */}
      <div className="flex-1 min-h-0 relative bg-[var(--bg-primary)]">
        {assignedModelName ? (
          <AvatarCanvas sessionId={sessionId} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] text-sm">
            {t('vtuber.noModel') ?? 'No model assigned. Select a model above.'}
          </div>
        )}
      </div>
    </div>
  );
}
