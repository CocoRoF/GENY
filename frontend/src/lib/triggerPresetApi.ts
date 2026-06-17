/**
 * Trigger Preset API client.
 *
 * Wraps the Geny backend's ``/api/trigger-presets/*`` endpoints.
 * Mirrors the shape of :mod:`environmentApi` so registry-tab plumbing
 * (loading state, error surface, refresh) ports cleanly.
 */

import { getToken } from '@/lib/authApi';
import type {
  CreateTriggerPresetPayload,
  TriggerPresetDetail,
  TriggerPresetManifest,
  TriggerPresetSessionsResponse,
  TriggerPresetSummary,
  UpdateTriggerPresetPayload,
} from '@/types/triggerPreset';

async function apiCall<T = unknown>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const authHeaders: Record<string, string> = {};
  if (token) authHeaders['Authorization'] = `Bearer ${token}`;

  const res = await fetch(endpoint, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    let message: string;
    try {
      const json = JSON.parse(body);
      const raw = json.detail || json.message || json.error;
      message =
        typeof raw === 'string'
          ? raw
          : raw
            ? JSON.stringify(raw)
            : `HTTP ${res.status}`;
    } catch {
      message = body || `HTTP ${res.status}`;
    }
    throw new Error(message);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Result of `list()` / `setDefault()` — the preset summaries plus the
 *  id of the preset currently designated as the active default. Mirrors
 *  the backend's `{ presets, default_preset_id }` response. */
export interface TriggerPresetListResult {
  presets: TriggerPresetSummary[];
  defaultPresetId: string;
}

export const triggerPresetApi = {
  list: async (): Promise<TriggerPresetListResult> => {
    const res = await apiCall<{
      presets: TriggerPresetSummary[];
      default_preset_id: string;
    }>('/api/trigger-presets');
    return {
      presets: res.presets ?? [],
      defaultPresetId: res.default_preset_id ?? '',
    };
  },

  /** Designate `presetId` as the active default. Returns the refreshed
   *  list + the (now updated) default id. */
  setDefault: async (presetId: string): Promise<TriggerPresetListResult> => {
    const res = await apiCall<{
      presets: TriggerPresetSummary[];
      default_preset_id: string;
    }>(`/api/trigger-presets/${presetId}/set-default`, { method: 'POST' });
    return {
      presets: res.presets ?? [],
      defaultPresetId: res.default_preset_id ?? '',
    };
  },

  get: (presetId: string) =>
    apiCall<TriggerPresetDetail>(`/api/trigger-presets/${presetId}`),

  /** Read the bundled defaults (no real id). */
  defaults: () =>
    apiCall<TriggerPresetDetail>('/api/trigger-presets/defaults'),

  create: (payload: CreateTriggerPresetPayload) =>
    apiCall<{ id: string }>('/api/trigger-presets', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  patch: (presetId: string, changes: UpdateTriggerPresetPayload) =>
    apiCall<TriggerPresetDetail>(`/api/trigger-presets/${presetId}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),

  replaceManifest: (
    presetId: string,
    manifest: TriggerPresetManifest,
  ) =>
    apiCall<TriggerPresetDetail>(
      `/api/trigger-presets/${presetId}/manifest`,
      {
        method: 'PUT',
        body: JSON.stringify({ manifest }),
      },
    ),

  reset: (presetId: string) =>
    apiCall<TriggerPresetDetail>(`/api/trigger-presets/${presetId}/reset`, {
      method: 'POST',
    }),

  duplicate: (presetId: string, newName: string) =>
    apiCall<{ id: string }>(`/api/trigger-presets/${presetId}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ new_name: newName }),
    }),

  delete: (presetId: string) =>
    apiCall<void>(`/api/trigger-presets/${presetId}`, { method: 'DELETE' }),

  sessions: (presetId: string) =>
    apiCall<TriggerPresetSessionsResponse>(
      `/api/trigger-presets/${presetId}/sessions`,
    ),
};

export const agentTriggerPresetApi = {
  /** Attach (or detach) a trigger preset on a running VTuber session. */
  attach: (sessionId: string, triggerPresetId: string | null) =>
    apiCall<{
      success: boolean;
      session_id: string;
      trigger_preset_id: string | null;
    }>(`/api/agents/${sessionId}/trigger-preset`, {
      method: 'PUT',
      body: JSON.stringify({ trigger_preset_id: triggerPresetId }),
    }),
};
