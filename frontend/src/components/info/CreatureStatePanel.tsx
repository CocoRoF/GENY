'use client';

/**
 * CreatureStatePanel — renders a session's Tamagotchi snapshot.
 *
 * Shipped in cycle 20260422_5 (X7) alongside backend changes that
 * expose `CreatureStateSnapshot` through the `/api/agents/{id}`
 * response. The component is a pure presentational layer: it takes
 * the snapshot + a translator and draws three groups of bars
 * (vitals / bond / mood) plus a life-stage / dominant-mood header.
 *
 * Design notes:
 * - Intentionally lightweight — inline divs, no external chart
 *   library. Matches the existing InfoTab aesthetic (bg-secondary
 *   cards, muted labels, monospace values).
 * - Vitals axes go 0–100 with a semantic direction. "hunger" and
 *   "stress" are *bad* at high values, so we invert the color to
 *   red as they grow. Energy / cleanliness use green for high.
 * - Bond axes are unbounded in backend ([0, ∞)); we soft-clamp at
 *   100 for the visual bar and show the raw number beside it, so
 *   long-running sessions still render sanely.
 * - Mood axes are [0, 1]; rendered as percent.
 */

import type { CreatureStateSnapshot } from '@/types';
import { Heart, Battery, Brain, Sparkles } from 'lucide-react';

export interface CreatureStatePanelProps {
  snapshot: CreatureStateSnapshot;
  t: (key: string, params?: Record<string, string>) => string;
  /**
   * Compact "game UI" rendering for the VTuberTab status badge
   * hover overlay. Uses a darker translucent backdrop, neon
   * accents and tighter spacing while preserving the same
   * three-section layout (vitals / bond / mood).
   */
  compact?: boolean;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

/** Bar with percentage fill. `tone` drives the color gradient. */
function StatBar({
  label,
  value,
  max,
  tone,
  valueLabel,
}: {
  label: string;
  value: number;   // in same units as `max`
  max: number;
  tone: 'good' | 'warn' | 'neutral' | 'info';
  valueLabel?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const toneColor =
    tone === 'good'
      ? 'var(--success-color, #10b981)'
      : tone === 'warn'
        ? 'var(--danger-color, #ef4444)'
        : tone === 'info'
          ? 'var(--primary-color, #3b82f6)'
          : 'var(--text-muted, #6b7280)';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-muted)]">
          {label}
        </span>
        <span
          className="text-[11px] text-[var(--text-primary)]"
          style={{ fontFamily: "'SF Mono', 'Fira Code', monospace" }}
        >
          {valueLabel ?? `${pct.toFixed(0)}%`}
        </span>
      </div>
      <div
        className="h-1.5 w-full rounded-full overflow-hidden"
        style={{ background: 'var(--bg-tertiary, rgba(0,0,0,0.08))' }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, background: toneColor }}
        />
      </div>
    </div>
  );
}

export default function CreatureStatePanel({
  snapshot,
  t,
  compact = false,
}: CreatureStatePanelProps) {
  const { mood, bond, vitals, progression, mood_dominant, last_interaction_at } =
    snapshot;

  // Mood axis ordering — keep in lockstep with backend MoodVector.keys()
  const moodAxes: Array<[keyof typeof mood, string]> = [
    ['joy', t('info.creatureState.moodAxes.joy')],
    ['sadness', t('info.creatureState.moodAxes.sadness')],
    ['anger', t('info.creatureState.moodAxes.anger')],
    ['fear', t('info.creatureState.moodAxes.fear')],
    ['calm', t('info.creatureState.moodAxes.calm')],
    ['excitement', t('info.creatureState.moodAxes.excitement')],
  ];

  // Plan/Phase01 — dominant-mood string returned by the backend is
  // an English key ("calm", "joy", ...). Look it up in the i18n
  // moodDominant map so the UI shows a localized label; fall back to
  // the raw key when the translation table doesn't cover it (forward
  // compat for new emotions).
  const dominantLabel = mood_dominant
    ? (t(`info.creatureState.moodDominant.${mood_dominant}`) || mood_dominant)
    : '—';

  const bondAxes: Array<[keyof typeof bond, string]> = [
    ['affection', t('info.creatureState.bondAxes.affection')],
    ['trust', t('info.creatureState.bondAxes.trust')],
    ['familiarity', t('info.creatureState.bondAxes.familiarity')],
    ['dependency', t('info.creatureState.bondAxes.dependency')],
  ];

  // Vitals — semantic direction: hunger/stress are bad when high.
  type VitalAxis = readonly [keyof typeof vitals, string, 'good' | 'warn'];
  const vitalAxes: readonly VitalAxis[] = [
    ['hunger', t('info.creatureState.vitalsAxes.hunger'), 'warn'],
    ['energy', t('info.creatureState.vitalsAxes.energy'), 'good'],
    ['stress', t('info.creatureState.vitalsAxes.stress'), 'warn'],
    ['cleanliness', t('info.creatureState.vitalsAxes.cleanliness'), 'good'],
  ];

  // ─── Compact "game UI" rendering for the VTuberTab hover overlay ─
  if (compact) {
    return (
      <div
        className="rounded-xl border border-[rgba(99,102,241,0.45)] shadow-[0_0_30px_rgba(99,102,241,0.25),inset_0_0_20px_rgba(0,0,0,0.6)] backdrop-blur-md p-3.5 w-[360px] text-[var(--text-primary)]"
        style={{
          background:
            'linear-gradient(160deg, rgba(15,18,38,0.92) 0%, rgba(28,16,46,0.92) 100%)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-[rgba(99,102,241,0.25)]">
          <div className="flex items-center gap-1.5">
            <Sparkles size={13} className="text-[#a5b4fc]" />
            <span className="text-[11px] font-bold uppercase tracking-[1px] text-[#c7d2fe]">
              {t('info.creatureState.title')}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px]">
            <span className="px-1.5 py-0.5 rounded bg-[rgba(99,102,241,0.2)] text-[#e0e7ff] uppercase tracking-[0.8px] border border-[rgba(99,102,241,0.4)]">
              {progression.life_stage || '—'}
            </span>
            <span className="text-[#a5b4fc]">
              {t('info.creatureState.ageDays', { days: String(progression.age_days) })}
            </span>
          </div>
        </div>

        {/* Dominant mood pill */}
        <div className="mb-3 flex items-center justify-between text-[10px]">
          <span className="uppercase tracking-[0.8px] text-[#a5b4fc]">
            {t('info.creatureState.dominantMood')}
          </span>
          <span className="font-mono text-[#fde68a] uppercase">{dominantLabel}</span>
        </div>

        {/* Vitals */}
        <div className="mb-2.5">
          <div className="flex items-center gap-1 mb-1">
            <Battery size={11} className="text-[#a5b4fc]" />
            <span className="text-[10px] font-bold uppercase tracking-[1px] text-[#c7d2fe]">
              {t('info.creatureState.vitals')}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {vitalAxes.map(([key, label, tone]) => (
              <StatBar
                key={key}
                label={label}
                value={clamp100(vitals[key])}
                max={100}
                tone={tone}
                valueLabel={vitals[key].toFixed(0)}
              />
            ))}
          </div>
        </div>

        {/* Bond */}
        <div className="mb-2.5">
          <div className="flex items-center gap-1 mb-1">
            <Heart size={11} className="text-[#a5b4fc]" />
            <span className="text-[10px] font-bold uppercase tracking-[1px] text-[#c7d2fe]">
              {t('info.creatureState.bond')}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {bondAxes.map(([key, label]) => (
              <StatBar
                key={key}
                label={label}
                value={Math.max(-100, Math.min(100, bond[key]))}
                max={100}
                tone="info"
                valueLabel={bond[key].toFixed(1)}
              />
            ))}
          </div>
        </div>

        {/* Mood */}
        <div>
          <div className="flex items-center gap-1 mb-1">
            <Brain size={11} className="text-[#a5b4fc]" />
            <span className="text-[10px] font-bold uppercase tracking-[1px] text-[#c7d2fe]">
              {t('info.creatureState.mood')}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {moodAxes.map(([key, label]) => (
              <StatBar
                key={key}
                label={label}
                value={clamp01(mood[key]) * 100}
                max={100}
                tone="neutral"
                valueLabel={`${(clamp01(mood[key]) * 100).toFixed(0)}%`}
              />
            ))}
          </div>
        </div>

        {/* Footer: last interaction */}
        <div className="mt-2.5 pt-2 border-t border-[rgba(99,102,241,0.25)] flex items-center justify-between text-[9px] text-[#a5b4fc]">
          <span className="uppercase tracking-[0.8px]">
            {t('info.creatureState.lastInteraction')}
          </span>
          <span className="font-mono">{formatTimestamp(last_interaction_at)}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative mb-4 rounded-xl border border-[var(--border-color)] overflow-hidden"
      style={{
        background:
          'linear-gradient(135deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%)',
      }}
    >
      {/* Decorative top accent bar (HUD frame) */}
      <div
        className="h-[2px] w-full"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, var(--primary-color, #6366f1) 20%, #a855f7 50%, var(--primary-color, #6366f1) 80%, transparent 100%)',
        }}
      />

      <div className="p-3.5">
        {/* ── Header: title + life-stage badge ─────────────────────── */}
        <div className="flex items-center justify-between mb-3 pb-2.5 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2">
            <div
              className="flex items-center justify-center w-6 h-6 rounded-md"
              style={{
                background:
                  'linear-gradient(135deg, rgba(99,102,241,0.18), rgba(168,85,247,0.18))',
                border: '1px solid rgba(99,102,241,0.35)',
              }}
            >
              <Sparkles size={12} className="text-[var(--primary-color,#6366f1)]" />
            </div>
            <span className="text-[12px] font-bold uppercase tracking-[1px] text-[var(--text-primary)]">
              {t('info.creatureState.title')}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span
              className="px-2 py-0.5 rounded-md font-bold uppercase tracking-[1px] text-[10px]"
              style={{
                background:
                  'linear-gradient(135deg, rgba(168,85,247,0.18), rgba(99,102,241,0.18))',
                color: 'var(--primary-color, #6366f1)',
                border: '1px solid rgba(99,102,241,0.4)',
                boxShadow: '0 0 12px rgba(99,102,241,0.15)',
              }}
            >
              {progression.life_stage || '—'}
            </span>
            <span
              className="font-mono text-[var(--text-muted)] text-[11px]"
              style={{ fontFamily: "'SF Mono', 'Fira Code', monospace" }}
            >
              {t('info.creatureState.ageDays', {
                days: String(progression.age_days),
              })}
            </span>
          </div>
        </div>

        {/* ── Featured: dominant mood + last interaction ───────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
          <div
            className="relative flex flex-col gap-0.5 py-2 px-3 rounded-lg overflow-hidden"
            style={{
              background:
                'linear-gradient(135deg, rgba(99,102,241,0.10), rgba(168,85,247,0.06))',
              border: '1px solid rgba(99,102,241,0.30)',
            }}
          >
            <span className="text-[10px] font-semibold uppercase tracking-[1px] text-[var(--text-muted)]">
              ◆ {t('info.creatureState.dominantMood')}
            </span>
            <span
              className="text-[15px] font-bold text-[var(--text-primary)]"
              style={{
                textShadow: '0 0 10px rgba(99,102,241,0.35)',
              }}
            >
              {dominantLabel}
            </span>
          </div>
          <div
            className="flex flex-col gap-0.5 py-2 px-3 rounded-lg"
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
            }}
          >
            <span className="text-[10px] font-semibold uppercase tracking-[1px] text-[var(--text-muted)]">
              ◇ {t('info.creatureState.lastInteraction')}
            </span>
            <span
              className="text-[12px] text-[var(--text-primary)] break-all"
              style={{ fontFamily: "'SF Mono', 'Fira Code', monospace" }}
            >
              {formatTimestamp(last_interaction_at)}
            </span>
          </div>
        </div>

        {/* ── Vitals group ────────────────────────────────────────── */}
        <SectionHeader icon={<Battery size={12} />} label={t('info.creatureState.vitals')} accent="#10b981" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 mb-3">
          {vitalAxes.map(([key, label, tone]) => (
            <SegmentedStatBar
              key={key}
              label={label}
              value={clamp100(vitals[key])}
              max={100}
              tone={tone}
              valueLabel={vitals[key].toFixed(1)}
            />
          ))}
        </div>

        {/* ── Bond group ──────────────────────────────────────────── */}
        <SectionHeader icon={<Heart size={12} />} label={t('info.creatureState.bond')} accent="#ec4899" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 mb-3">
          {bondAxes.map(([key, label]) => (
            <SegmentedStatBar
              key={key}
              label={label}
              value={Math.max(-100, Math.min(100, bond[key]))}
              max={100}
              tone="info"
              valueLabel={bond[key].toFixed(2)}
            />
          ))}
        </div>

        {/* ── Mood group ──────────────────────────────────────────── */}
        <SectionHeader icon={<Brain size={12} />} label={t('info.creatureState.mood')} accent="#a855f7" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
          {moodAxes.map(([key, label]) => (
            <SegmentedStatBar
              key={key}
              label={label}
              value={clamp01(mood[key]) * 100}
              max={100}
              tone="neutral"
              valueLabel={`${(clamp01(mood[key]) * 100).toFixed(0)}%`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Section divider header used between Vitals / Bond / Mood blocks. */
function SectionHeader({
  icon,
  label,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span style={{ color: accent }}>{icon}</span>
      <span className="text-[11px] font-bold uppercase tracking-[1.5px] text-[var(--text-primary)]">
        {label}
      </span>
      <div
        className="flex-1 h-px"
        style={{
          background: `linear-gradient(90deg, ${accent}55 0%, transparent 100%)`,
        }}
      />
    </div>
  );
}

/**
 * Segmented stat bar — RPG/HUD style. Splits the bar into 10 ticks
 * and lights them up proportionally with a soft glow on the active
 * segments. Falls back gracefully if `value` exceeds `max`.
 */
function SegmentedStatBar({
  label,
  value,
  max,
  tone,
  valueLabel,
}: {
  label: string;
  value: number;
  max: number;
  tone: 'good' | 'warn' | 'neutral' | 'info';
  valueLabel?: string;
}) {
  const SEGMENTS = 12;
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(pct * SEGMENTS);
  const toneColor =
    tone === 'good'
      ? '#10b981'
      : tone === 'warn'
        ? '#ef4444'
        : tone === 'info'
          ? '#6366f1'
          : '#a855f7';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--text-muted)]">
          {label}
        </span>
        <span
          className="text-[11px] font-bold"
          style={{
            color: toneColor,
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            textShadow: `0 0 6px ${toneColor}40`,
          }}
        >
          {valueLabel ?? `${(pct * 100).toFixed(0)}%`}
        </span>
      </div>
      <div className="flex gap-[2px]">
        {Array.from({ length: SEGMENTS }).map((_, i) => {
          const active = i < filled;
          return (
            <div
              key={i}
              className="flex-1 h-[6px] rounded-[1px] transition-colors duration-200"
              style={{
                background: active ? toneColor : 'var(--bg-tertiary, rgba(0,0,0,0.10))',
                boxShadow: active ? `0 0 4px ${toneColor}66` : 'none',
                opacity: active ? 1 : 0.45,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
