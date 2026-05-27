'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play, Upload } from 'lucide-react';
import { ttsApi, type VoiceProfile } from '@/lib/api';
import {
  voiceStudioApi,
  type BatchLine,
  type BatchStartParams,
  type PreviewMode,
} from '@/lib/voiceStudioApi';
import { useI18n } from '@/lib/i18n';

const EMOTIONS = [
  'neutral', 'joy', 'anger', 'sadness', 'fear', 'surprise', 'disgust', 'smirk',
] as const;
type Emotion = (typeof EMOTIONS)[number];

const MAX_LINES = 500;

type ParseMode = 'txt' | 'json' | 'csv';

interface BatchUploaderProps {
  onStarted: (jobId: string) => void;
}

export default function BatchUploader({ onStarted }: BatchUploaderProps) {
  const { t } = useI18n();
  const [raw, setRaw] = useState('');
  const [parseMode, setParseMode] = useState<ParseMode>('txt');
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);

  const [profile, setProfile] = useState<string>('');
  const [emotion, setEmotion] = useState<Emotion>('neutral');
  const [mode, setMode] = useState<PreviewMode>('clone');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    ttsApi
      .listProfiles()
      .then((res) => {
        const list = res.profiles || [];
        setProfiles(list);
        if (!profile) {
          const active = list.find((p) => p.active);
          setProfile((active || list[0])?.name || '');
        }
      })
      .catch(() => {
        // page still works; profile dropdown just stays empty
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed: { lines: BatchLine[]; error: string | null } = useMemo(() => {
    return parseRaw(raw, parseMode);
  }, [raw, parseMode]);

  const tooMany = parsed.lines.length > MAX_LINES;

  const onFile = useCallback((file: File) => {
    const ext = file.name.toLowerCase().split('.').pop() || '';
    if (ext === 'json') setParseMode('json');
    else if (ext === 'csv') setParseMode('csv');
    else setParseMode('txt');
    if (!label) setLabel(file.name);
    const reader = new FileReader();
    reader.onload = () => setRaw(String(reader.result || ''));
    reader.readAsText(file);
  }, [label]);

  const start = useCallback(async () => {
    if (!parsed.lines.length) {
      setError(t('voiceStudio.batch.errors.emptyLines'));
      return;
    }
    if (tooMany) {
      setError(t('voiceStudio.batch.errors.tooMany', { max: MAX_LINES }));
      return;
    }
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: BatchStartParams = {
        label: label || undefined,
        profile: profile || undefined,
        emotion,
        mode,
        lines: parsed.lines,
      };
      const res = await voiceStudioApi.startBatch(body);
      onStarted(res.job_id);
      setRaw('');
      setLabel('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [parsed, label, profile, emotion, mode, tooMany, t, onStarted]);

  const preview = parsed.lines.slice(0, 3);

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-[0.9375rem] font-semibold">{t('voiceStudio.batch.title')}</h2>
        <span className="ml-2 text-[0.6875rem] text-[var(--text-muted)]">
          {t('voiceStudio.batch.maxLines', { n: MAX_LINES })}
        </span>
      </div>

      {/* Upload + format toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.json,.txt,text/plain,text/csv,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[0.75rem] hover:text-[var(--primary-color)] hover:border-[var(--primary-color)] cursor-pointer transition-colors"
        >
          <Upload size={12} />
          {t('voiceStudio.batch.uploadFile')}
        </button>
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
          {(['txt', 'csv', 'json'] as ParseMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setParseMode(m)}
              className={`px-2 py-0.5 text-[0.6875rem] font-medium rounded transition-all duration-150 border-none cursor-pointer ${
                parseMode === m
                  ? 'bg-[var(--primary-color)] text-white shadow-sm'
                  : 'bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('voiceStudio.batch.labelPlaceholder')}
          className="flex-1 min-w-[180px] px-2.5 py-1.5 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[0.75rem] text-[var(--text-primary)] outline-none focus:border-[var(--primary-color)]"
        />
      </div>

      {/* Paste textarea */}
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={6}
        placeholder={t('voiceStudio.batch.pastePlaceholder', { mode: parseMode.toUpperCase() })}
        className="w-full px-3 py-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.8125rem] outline-none focus:border-[var(--primary-color)] resize-y font-mono"
      />

      <div className="flex items-center gap-3 flex-wrap text-[0.75rem]">
        <span className={tooMany ? 'text-[var(--danger-color)]' : 'text-[var(--text-muted)]'}>
          {t('voiceStudio.batch.detectedLines', { n: parsed.lines.length })}
        </span>
        {parsed.error && (
          <span className="text-[var(--danger-color)]">{parsed.error}</span>
        )}
        {preview.length > 0 && (
          <span className="text-[var(--text-muted)] truncate">
            {t('voiceStudio.batch.firstLines')} {preview.map((l) => `"${l.text.slice(0, 30)}…"`).join(' / ')}
          </span>
        )}
      </div>

      {/* Shared defaults */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Field label={t('voiceStudio.batch.profile')}>
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className="w-full px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.75rem] outline-none focus:border-[var(--primary-color)]"
          >
            {profiles.length === 0 && <option value="">—</option>}
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.display_name || p.name}{p.active ? ' ★' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('voiceStudio.batch.emotion')}>
          <select
            value={emotion}
            onChange={(e) => setEmotion(e.target.value as Emotion)}
            className="w-full px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.75rem] outline-none focus:border-[var(--primary-color)]"
          >
            {EMOTIONS.map((e) => (
              <option key={e} value={e}>
                {t(`voiceStudio.cloneDesign.emotion.${e}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('voiceStudio.cloneDesign.mode.clone')}>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as PreviewMode)}
            className="w-full px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[0.75rem] outline-none focus:border-[var(--primary-color)]"
          >
            <option value="clone">Clone</option>
            <option value="design">Design</option>
            <option value="auto">Auto</option>
          </select>
        </Field>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg text-[0.8125rem] bg-[rgba(239,68,68,0.1)] text-[var(--danger-color)] border border-[rgba(239,68,68,0.2)]">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={start}
          disabled={busy || !parsed.lines.length || tooMany}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-[var(--primary-color)] text-white text-[0.8125rem] font-medium border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {busy ? t('voiceStudio.batch.starting') : t('voiceStudio.batch.start')}
        </button>
        <span className="text-[0.6875rem] text-[var(--text-muted)]">
          {t('voiceStudio.batch.hint')}
        </span>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[0.6875rem] font-medium text-[var(--text-muted)] mb-1">{label}</label>
      {children}
    </div>
  );
}

// ── Parsing helpers ───────────────────────────────────────────────────

function parseRaw(raw: string, mode: ParseMode): { lines: BatchLine[]; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { lines: [], error: null };

  if (mode === 'json') {
    try {
      const data = JSON.parse(trimmed);
      if (!Array.isArray(data)) {
        return { lines: [], error: 'JSON root must be an array of {text, ...}.' };
      }
      const lines = data
        .filter((x) => x && typeof x === 'object' && typeof x.text === 'string')
        .map((x: Record<string, unknown>) => ({
          text: String(x.text),
          profile: x.profile ? String(x.profile) : undefined,
          emotion: x.emotion ? String(x.emotion) : undefined,
          seed: typeof x.seed === 'number' ? x.seed : undefined,
          instruct: x.instruct ? String(x.instruct) : undefined,
          language: x.language ? String(x.language) : undefined,
        }));
      return { lines, error: lines.length ? null : 'JSON had no {text:...} entries.' };
    } catch (e) {
      return { lines: [], error: `JSON parse: ${(e as Error).message}` };
    }
  }

  if (mode === 'csv') {
    const rows = trimmed.split(/\r?\n/).filter((l) => l.trim().length);
    if (rows.length === 0) return { lines: [], error: null };
    const headerRaw = rows[0];
    const headers = headerRaw.split(',').map((s) => s.trim().toLowerCase());
    const hasHeader = headers.includes('text');
    const dataRows = hasHeader ? rows.slice(1) : rows;
    if (!hasHeader) {
      // First column is text; ignore extras silently.
      const lines = dataRows.map((row) => ({ text: row.split(',')[0] }));
      return { lines, error: null };
    }
    const idx: Record<string, number> = {};
    headers.forEach((h, i) => { idx[h] = i; });
    const lines: BatchLine[] = dataRows.map((row) => {
      const cells = row.split(',');
      const text = cells[idx.text] ?? '';
      const out: BatchLine = { text: text.trim() };
      if (idx.profile !== undefined && cells[idx.profile]) out.profile = cells[idx.profile].trim();
      if (idx.emotion !== undefined && cells[idx.emotion]) out.emotion = cells[idx.emotion].trim();
      if (idx.seed !== undefined && cells[idx.seed]) {
        const n = parseInt(cells[idx.seed], 10);
        if (Number.isFinite(n)) out.seed = n;
      }
      if (idx.language !== undefined && cells[idx.language]) out.language = cells[idx.language].trim();
      if (idx.instruct !== undefined && cells[idx.instruct]) out.instruct = cells[idx.instruct].trim();
      return out;
    }).filter((l) => l.text);
    return { lines, error: null };
  }

  // TXT default — one line per synthesis.
  const lines: BatchLine[] = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
  return { lines, error: null };
}
