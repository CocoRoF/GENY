/**
 * Audio device routing — send TTS output and mic input to a chosen device
 * (e.g. a VoiceMeeter virtual cable), remembered by LABEL and re-applied
 * whenever the device set changes.
 *
 * Why LABEL, not deviceId: `deviceId` is scoped to the origin that enumerated
 * it, so an id chosen in the desktop settings window (a different origin) is
 * meaningless here. The device *label* ("VoiceMeeter Input (VB-Audio …)") is
 * the only stable cross-origin key. Matching by label also fixes the startup
 * race the user hit — Geny launches before VoiceMeeter, so the target device
 * isn't present yet; we listen for `devicechange` and re-resolve + re-apply the
 * moment its label appears.
 *
 * Output is seamless (`AudioContext.setSinkId` / `HTMLAudioElement.setSinkId`).
 * Input requires re-opening the mic, so this module just resolves + broadcasts
 * the target input deviceId; the mic owners (RealtimeVoiceDriver / VAD
 * recorder) subscribe and restart their stream.
 */

import { getAudioManager } from '@/lib/audioManager';

export type AudioKind = 'audiooutput' | 'audioinput';

export interface AudioDeviceInfo {
  deviceId: string;
  label: string;
}

const _hasMedia = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.enumerateDevices;

/** List audio devices for UI. Labels are blank until a media-permission grant
 * exists for this origin (the connector grants it to the overlay; a browser
 * gets it once the mic is used). */
export async function listAudioDevices(): Promise<{ outputs: AudioDeviceInfo[]; inputs: AudioDeviceInfo[] }> {
  if (!_hasMedia()) return { outputs: [], inputs: [] };
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return { outputs: [], inputs: [] };
  }
  const pick = (kind: AudioKind) =>
    devices
      .filter((d) => d.kind === kind && d.deviceId)
      .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId }));
  return { outputs: pick('audiooutput'), inputs: pick('audioinput') };
}

/** Resolve a saved LABEL to a current deviceId in THIS origin.
 *  - ''  (empty label)  → ''   : use the system default.
 *  - matched            → id
 *  - present but no match → null: the device isn't here yet (retry on change). */
export async function resolveDeviceIdByLabel(kind: AudioKind, label: string): Promise<string | null> {
  if (!label) return '';
  if (!_hasMedia()) return null;
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return null;
  }
  // Exact label match first; then a forgiving prefix match (some drivers append
  // a changing suffix like " (2)" across reconnects).
  const same = devices.filter((d) => d.kind === kind && d.deviceId && d.label);
  const exact = same.find((d) => d.label === label);
  if (exact) return exact.deviceId;
  const loose = same.find((d) => d.label.startsWith(label) || label.startsWith(d.label));
  return loose ? loose.deviceId : null;
}

type InputListener = (deviceId: string | null) => void;

class AudioRouting {
  private _outputLabel = '';
  private _inputLabel = '';
  private _inputListeners = new Set<InputListener>();
  private _wired = false;

  private _ensureWired(): void {
    if (this._wired || !_hasMedia()) return;
    this._wired = true;
    // Re-apply both routes whenever devices appear/disappear (VoiceMeeter race).
    navigator.mediaDevices.addEventListener('devicechange', () => {
      void this._applyOutput();
      void this._applyInput();
    });
  }

  /** Desired TTS output device, by label. '' = system default. */
  setOutputLabel(label: string): void {
    this._ensureWired();
    if (label === this._outputLabel) return;
    this._outputLabel = label || '';
    void this._applyOutput();
  }

  /** Desired mic input device, by label. '' = system default. */
  setInputLabel(label: string): void {
    this._ensureWired();
    if (label === this._inputLabel) return;
    this._inputLabel = label || '';
    void this._applyInput();
  }

  /** Current resolved input deviceId ('' default, null not-present). Mic owners
   * call this before opening the stream. */
  async currentInputDeviceId(): Promise<string | null> {
    return resolveDeviceIdByLabel('audioinput', this._inputLabel);
  }

  /** Subscribe to input-device changes → restart the mic stream. */
  onInputChange(cb: InputListener): () => void {
    this._ensureWired();
    this._inputListeners.add(cb);
    return () => this._inputListeners.delete(cb);
  }

  private async _applyOutput(): Promise<void> {
    const id = await resolveDeviceIdByLabel('audiooutput', this._outputLabel);
    if (id === null) return; // not present yet — a later devicechange will retry
    try {
      await getAudioManager().setOutputSinkId(id);
    } catch {
      /* setSinkId unsupported / device busy — stay on default */
    }
  }

  private async _applyInput(): Promise<void> {
    const id = await resolveDeviceIdByLabel('audioinput', this._inputLabel);
    if (id === null) return; // not present yet
    for (const cb of this._inputListeners) {
      try {
        cb(id);
      } catch {
        /* ignore a bad subscriber */
      }
    }
  }
}

export const audioRouting = new AudioRouting();
