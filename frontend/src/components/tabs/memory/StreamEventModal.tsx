'use client';

/**
 * Cycle 20260430_3 Stage D — InteractionEvent detail modal.
 *
 * Loads via GET /api/agents/{sid}/transcripts/{event_id}, then lets
 * the user:
 *
 *   - inspect every metadata field;
 *   - expand the structured payload;
 *   - read each file in payload.files_written inline (lazy fetch
 *     via the artifact endpoint);
 *   - jump to the linked parent event (chains stay in the same
 *     modal — onOpenLinked switches event_id state).
 *
 * Read-only: no writes.
 */

import { useCallback, useEffect, useState } from 'react';
import { transcriptsApi } from '@/lib/api';
import type {
  InteractionEventDetail,
  TranscriptDetailLinked,
} from '@/types';
import {
  X, ArrowUpRight, FileText, ChevronRight, ChevronDown,
  Loader2, AlertCircle,
} from 'lucide-react';
import { twMerge } from 'tailwind-merge';

function cn(...classes: (string | boolean | undefined | null)[]) {
  return twMerge(classes.filter(Boolean).join(' '));
}

function formatTs(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('ko-KR'); }
  catch { return iso; }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface ArtifactState {
  loading: boolean;
  error: string | null;
  content: string | null;
  truncated: boolean;
  size: number;
}

export default function StreamEventModal({
  sessionId, eventId, onClose, onOpenLinked,
}: {
  sessionId: string;
  eventId: string;
  onClose: () => void;
  onOpenLinked: (eventId: string) => void;
}) {
  const [event, setEvent] = useState<InteractionEventDetail | null>(null);
  const [linked, setLinked] = useState<TranscriptDetailLinked>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await transcriptsApi.get(sessionId, eventId);
      setEvent(res.event);
      setLinked(res.linked || {});
    } catch (err) {
      console.error('Failed to load event:', err);
      setError('이벤트를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [sessionId, eventId]);

  useEffect(() => {
    setArtifacts({});
    setShowRaw(false);
    load();
  }, [load]);

  const fetchArtifact = useCallback(async (path: string) => {
    setArtifacts(prev => ({
      ...prev,
      [path]: { loading: true, error: null, content: null, truncated: false, size: 0 },
    }));
    try {
      const res = await transcriptsApi.artifact(sessionId, eventId, path);
      setArtifacts(prev => ({
        ...prev,
        [path]: {
          loading: false, error: null,
          content: res.content,
          truncated: res.truncated,
          size: res.size_bytes,
        },
      }));
    } catch (err) {
      console.error('Failed to load artifact:', err);
      setArtifacts(prev => ({
        ...prev,
        [path]: {
          loading: false,
          error: '파일을 불러오지 못했습니다.',
          content: null, truncated: false, size: 0,
        },
      }));
    }
  }, [sessionId, eventId]);

  const filesWritten: string[] = (() => {
    if (!event) return [];
    const fw = (event.payload as Record<string, unknown>).files_written;
    return Array.isArray(fw) ? fw.filter((p): p is string => typeof p === 'string') : [];
  })();

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-[var(--border-radius)] w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-color)] shrink-0">
          <FileText size={16} className="text-[var(--text-muted)]" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium truncate">
              {event?.kind || '—'} · {event?.direction || '—'}
            </div>
            <div className="text-[10.5px] text-[var(--text-muted)] truncate font-mono">
              {eventId}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded hover:bg-[var(--bg-hover)]"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-[12.5px]">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-[var(--text-muted)] gap-2">
              <Loader2 size={16} className="animate-spin" />
              <span>불러오는 중…</span>
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 py-6 text-[#fb7185]">
              <AlertCircle size={16} /> {error}
            </div>
          ) : event ? (
            <>
              {/* Metadata grid */}
              <section>
                <h3 className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                  Metadata
                </h3>
                <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-[12px]">
                  <dt className="text-[var(--text-muted)]">Timestamp</dt>
                  <dd>{formatTs(event.ts)}</dd>

                  <dt className="text-[var(--text-muted)]">Kind</dt>
                  <dd className="font-mono">{event.kind || '—'}</dd>

                  <dt className="text-[var(--text-muted)]">Direction</dt>
                  <dd className="font-mono">{event.direction || '—'}</dd>

                  <dt className="text-[var(--text-muted)]">Counterpart</dt>
                  <dd className="font-mono">
                    {event.counterpart_id || '—'}
                    {event.counterpart_role && (
                      <span className="ml-2 text-[var(--text-muted)]">({event.counterpart_role})</span>
                    )}
                  </dd>

                  {event.linked_event_id && (
                    <>
                      <dt className="text-[var(--text-muted)]">Linked parent</dt>
                      <dd>
                        <button
                          onClick={() => onOpenLinked(event.linked_event_id!)}
                          className="inline-flex items-center gap-1 text-[var(--primary-color)] hover:underline"
                        >
                          <ArrowUpRight size={11} />
                          <span className="font-mono">{event.linked_event_id}</span>
                        </button>
                        {linked.parent && 'kind' in linked.parent && (
                          <span className="ml-2 text-[var(--text-muted)]">
                            {linked.parent.kind} — {linked.parent.summary || ''}
                          </span>
                        )}
                        {linked.parent && 'missing' in linked.parent && (
                          <span className="ml-2 text-[#fb7185]">(이전 STM 에서 사라짐)</span>
                        )}
                      </dd>
                    </>
                  )}
                </dl>
              </section>

              {/* Content */}
              <section>
                <h3 className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                  Content
                </h3>
                <pre className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded p-2 text-[12px] whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto">
                  {event.content || <span className="text-[var(--text-muted)]">(empty)</span>}
                </pre>
              </section>

              {/* Payload — categorised pretty view */}
              {event.payload && Object.keys(event.payload).length > 0 && (
                <section>
                  <div className="flex items-center justify-between mb-1.5">
                    <h3 className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)]">
                      Payload
                    </h3>
                    <button
                      onClick={() => setShowRaw(v => !v)}
                      className="text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] inline-flex items-center gap-1"
                    >
                      {showRaw ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      raw JSON
                    </button>
                  </div>
                  <PayloadView payload={event.payload} />
                  {showRaw && (
                    <pre className="mt-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded p-2 text-[11.5px] whitespace-pre-wrap font-mono max-h-72 overflow-y-auto">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  )}
                </section>
              )}

              {/* Files written — inline read */}
              {filesWritten.length > 0 && (
                <section>
                  <h3 className="text-[10.5px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                    Files written
                  </h3>
                  <ul className="space-y-2">
                    {filesWritten.map(p => (
                      <li
                        key={p}
                        className="border border-[var(--border-color)] rounded p-2"
                      >
                        <div className="flex items-center gap-2 text-[12px]">
                          <FileText size={12} className="text-[var(--text-muted)]" />
                          <span className="font-mono flex-1 truncate">{p}</span>
                          <button
                            onClick={() => fetchArtifact(p)}
                            disabled={artifacts[p]?.loading}
                            className="text-[10.5px] text-[var(--primary-color)] hover:underline disabled:opacity-50"
                          >
                            {artifacts[p]?.content !== undefined && artifacts[p]?.content !== null
                              ? '다시 읽기'
                              : '본문 보기'}
                          </button>
                        </div>
                        {artifacts[p]?.error && (
                          <div className="mt-1.5 text-[11px] text-[#fb7185]">
                            {artifacts[p]!.error}
                          </div>
                        )}
                        {artifacts[p]?.content !== null && artifacts[p]?.content !== undefined && (
                          <>
                            <div className="mt-1.5 text-[10.5px] text-[var(--text-muted)] flex items-center gap-2">
                              <span>{formatBytes(artifacts[p]!.size)}</span>
                              {artifacts[p]!.truncated && (
                                <span className="text-[#f59e0b]">
                                  (size cap reached — 전체 본문이 아님)
                                </span>
                              )}
                            </div>
                            <pre className="mt-1.5 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded p-2 text-[11.5px] whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto">
                              {artifacts[p]!.content}
                            </pre>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Payload structured view ─────────────────────────────────────────


function PayloadView({ payload }: { payload: Record<string, unknown> }) {
  // Render the well-known SubWorkerRun payload shape nicely; fall back
  // to a key/value list for everything else.
  const known = (
    'tools_used' in payload || 'files_written' in payload ||
    'bash_commands' in payload || 'errors' in payload ||
    'duration_ms' in payload
  );

  if (!known) {
    return (
      <pre className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded p-2 text-[11.5px] whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
        {JSON.stringify(payload, null, 2)}
      </pre>
    );
  }

  const tools = Array.isArray(payload.tools_used) ? payload.tools_used as string[] : [];
  const files = Array.isArray(payload.files_written) ? payload.files_written as string[] : [];
  const reads = Array.isArray(payload.files_read) ? payload.files_read as string[] : [];
  const bash = Array.isArray(payload.bash_commands) ? payload.bash_commands as Array<Record<string, unknown>> : [];
  const errors = Array.isArray(payload.errors) ? payload.errors as Array<Record<string, unknown>> : [];
  const status = typeof payload.status === 'string' ? payload.status : null;
  const dur = typeof payload.duration_ms === 'number' ? payload.duration_ms : null;
  const cost = typeof payload.cost_usd === 'number' ? payload.cost_usd : null;

  return (
    <div className="space-y-2 text-[12px]">
      {(status || dur !== null || cost !== null) && (
        <div className="flex flex-wrap gap-3 text-[11px]">
          {status && <span>status: <code>{status}</code></span>}
          {dur !== null && <span>duration: {(dur / 1000).toFixed(1)}s</span>}
          {cost !== null && <span>cost: ${cost.toFixed(4)}</span>}
        </div>
      )}
      {tools.length > 0 && (
        <div>
          <span className="text-[var(--text-muted)] text-[10.5px] mr-1">tools_used:</span>
          {tools.map(t => (
            <span key={t} className="inline-block px-1.5 py-0.5 mr-1 mb-1 rounded bg-[var(--bg-secondary)] text-[10.5px] font-mono">{t}</span>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div>
          <span className="text-[var(--text-muted)] text-[10.5px] block mb-0.5">files_written</span>
          <ul className="ml-2 list-disc list-inside text-[11.5px] font-mono">
            {files.map(f => <li key={f}>{f}</li>)}
          </ul>
        </div>
      )}
      {reads.length > 0 && (
        <div>
          <span className="text-[var(--text-muted)] text-[10.5px] block mb-0.5">files_read</span>
          <ul className="ml-2 list-disc list-inside text-[11.5px] font-mono">
            {reads.map(f => <li key={f}>{f}</li>)}
          </ul>
        </div>
      )}
      {bash.length > 0 && (
        <div>
          <span className="text-[var(--text-muted)] text-[10.5px] block mb-0.5">bash_commands</span>
          <ul className="ml-2 list-disc list-inside text-[11.5px] font-mono">
            {bash.map((c, i) => {
              const cmd = typeof c.command === 'string' ? c.command : '';
              const ok = c.ok !== false;
              return <li key={i}>{ok ? '✓' : '✗'} <code>{cmd}</code></li>;
            })}
          </ul>
        </div>
      )}
      {errors.length > 0 && (
        <div>
          <span className="text-[#fb7185] text-[10.5px] block mb-0.5">errors</span>
          <ul className="ml-2 list-disc list-inside text-[11.5px] font-mono text-[#fb7185]">
            {errors.map((e, i) => {
              const name = typeof e.name === 'string' ? e.name : '?';
              return <li key={i}>{name}</li>;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
