'use client';

/**
 * OverlayOptions — the gear-icon settings panel for the avatar overlay.
 *
 * Exposes the three live capabilities' tuning, all persisted in
 * useVTuberStore (→ localStorage), read by the hidden driver components:
 *
 *   TTS  — output volume.
 *   STT  — mic sensitivity, end-of-speech wait, and the getUserMedia
 *          "sound correction" constraints (echo / noise / auto-gain).
 *   화면 — auto-capture cadence + which screen/window is captured
 *          (connector.capture.listSources(); browser falls back to the
 *          getDisplayMedia picker so the source select is connector-only).
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useVTuberStore } from '@/store/useVTuberStore';

type CaptureSource = { id: string; name: string; display_id: string };

const INTERVAL_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 60_000, label: '1분' },
  { ms: 180_000, label: '3분' },
  { ms: 300_000, label: '5분' },
  { ms: 600_000, label: '10분' },
];

export default function OverlayOptions() {
  // TTS
  const ttsEnabled = useVTuberStore((s) => s.ttsEnabled);
  const ttsVolume = useVTuberStore((s) => s.ttsVolume);
  const setTTSVolume = useVTuberStore((s) => s.setTTSVolume);

  // STT
  const sttEnabled = useVTuberStore((s) => s.sttEnabled);
  const sttSensitivity = useVTuberStore((s) => s.sttSensitivity);
  const sttSilenceMs = useVTuberStore((s) => s.sttSilenceMs);
  const sttEcho = useVTuberStore((s) => s.sttEchoCancellation);
  const sttNoise = useVTuberStore((s) => s.sttNoiseSuppression);
  const sttGain = useVTuberStore((s) => s.sttAutoGain);
  const setSttSettings = useVTuberStore((s) => s.setSttSettings);

  // Screen
  const screenIntervalMs = useVTuberStore((s) => s.screenIntervalMs);
  const screenSourceId = useVTuberStore((s) => s.screenSourceId);
  const setScreenSettings = useVTuberStore((s) => s.setScreenSettings);

  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourcesErr, setSourcesErr] = useState<string | null>(null);

  // Capture-source list comes from the connector (Electron desktopCapturer).
  // A plain browser has no such bridge → the picker is hidden and the
  // getDisplayMedia prompt handles source selection at toggle time.
  useEffect(() => {
    const conn = (window as unknown as {
      connector?: { capture?: { listSources?: () => Promise<CaptureSource[]> } };
    }).connector;
    if (!conn?.capture?.listSources) return;
    conn.capture
      .listSources()
      .then((list) => setSources(Array.isArray(list) ? list : []))
      .catch((e) => setSourcesErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div style={CARD}>
      {/* TTS ───────────────────────────────────────────────── */}
      <Section title="TTS · 음성 출력">
        <Row label="볼륨" value={`${Math.round(ttsVolume * 100)}%`}>
          <input
            type="range" min={0} max={1} step={0.05} value={ttsVolume}
            onChange={(e) => setTTSVolume(Number(e.target.value))}
            style={SLIDER}
          />
        </Row>
        {!ttsEnabled && <Hint>TTS가 꺼져 있어요 — 하단 바의 TTS를 켜면 적용됩니다.</Hint>}
      </Section>

      {/* STT ───────────────────────────────────────────────── */}
      <Section title="STT · 음성 입력">
        <Row label="민감도" value={sttSensitivity.toFixed(3)}>
          {/* Lower threshold = picks up quieter speech. Slider right = more sensitive. */}
          <input
            type="range" min={0.01} max={0.1} step={0.005}
            value={0.11 - sttSensitivity}
            onChange={(e) => setSttSettings({ sttSensitivity: Number((0.11 - Number(e.target.value)).toFixed(3)) })}
            style={SLIDER}
          />
        </Row>
        <Row label="발화 종료 대기" value={`${(sttSilenceMs / 1000).toFixed(1)}s`}>
          <input
            type="range" min={400} max={3000} step={100} value={sttSilenceMs}
            onChange={(e) => setSttSettings({ sttSilenceMs: Number(e.target.value) })}
            style={SLIDER}
          />
        </Row>
        <div style={{ fontSize: 11, color: '#9a9bb0', margin: '2px 0 4px' }}>사운드 보정</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip active={sttEcho} onClick={() => setSttSettings({ sttEchoCancellation: !sttEcho })}>에코 제거</Chip>
          <Chip active={sttNoise} onClick={() => setSttSettings({ sttNoiseSuppression: !sttNoise })}>노이즈 억제</Chip>
          <Chip active={sttGain} onClick={() => setSttSettings({ sttAutoGain: !sttGain })}>자동 게인</Chip>
        </div>
        {sttEnabled && <Hint>변경하면 마이크를 다시 엽니다(권한 재확인 가능).</Hint>}
      </Section>

      {/* 화면 ───────────────────────────────────────────────── */}
      <Section title="화면 · 캡처 관찰">
        <Row label="캡처 주기">
          <select
            value={screenIntervalMs}
            onChange={(e) => setScreenSettings({ screenIntervalMs: Number(e.target.value) })}
            style={SELECT}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>{o.label}</option>
            ))}
          </select>
        </Row>
        {sources.length > 0 ? (
          <Row label="볼 화면/창">
            <select
              value={screenSourceId ?? ''}
              onChange={(e) => setScreenSettings({ screenSourceId: e.target.value || null })}
              style={SELECT}
            >
              <option value="">자동 (첫 번째 화면)</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {(s.id.startsWith('screen:') ? '🖥 ' : '🪟 ') + (s.name || s.id)}
                </option>
              ))}
            </select>
          </Row>
        ) : (
          <Hint>
            {sourcesErr
              ? `화면 목록을 못 불러왔어요: ${sourcesErr}`
              : '브라우저에서는 화면 선택 창이 캡처 시점에 떠요 (데스크톱 접속기에서 목록 선택 가능).'}
          </Hint>
        )}
        <Hint>캡처는 16:9 · 약 1600×900으로 축소되어 업로드됩니다.</Hint>
      </Section>
    </div>
  );
}

// ── pieces ─────────────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={SECTION}>
      <div style={SECTION_TITLE}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <div style={ROW}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12, color: '#cfd0e0' }}>{label}</span>
        {value && <span style={{ fontSize: 11, color: '#8b8ca0', fontVariantNumeric: 'tabular-nums' }}>{value}</span>}
      </div>
      {children}
    </div>
  );
}
function Hint({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 10.5, color: '#76778c', lineHeight: 1.45, marginTop: 4 }}>{children}</div>;
}
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button" onClick={onClick}
      style={{
        padding: '4px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer',
        border: '1px solid ' + (active ? 'transparent' : 'rgba(255,255,255,0.14)'),
        color: active ? '#0c0c10' : '#cfd0e0',
        background: active ? '#5be39a' : 'rgba(255,255,255,0.06)',
      }}
    >
      {children}
    </button>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────
const CARD: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10,
  padding: 14, maxHeight: '52vh', overflowY: 'auto',
  color: '#e8e8f0',
};
const SECTION: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.08)',
};
const SECTION_TITLE: CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: '#a9aac0',
};
const ROW: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
const SLIDER: CSSProperties = { width: '100%', accentColor: '#5be39a', cursor: 'pointer' };
const SELECT: CSSProperties = {
  width: '100%', padding: '5px 8px', borderRadius: 8, fontSize: 12,
  background: 'rgba(255,255,255,0.06)', color: '#e8e8f0',
  border: '1px solid rgba(255,255,255,0.14)', cursor: 'pointer',
};
