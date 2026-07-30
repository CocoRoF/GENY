'use client';

/**
 * Cycle 20260430_3 Stage D — Stream sub-tab.
 *
 * Renders the InteractionEvent stream from the backend transcripts
 * API as a timeline:
 *
 *   ┌───────────────┬──────────────────────────────────────────┐
 *   │ Counterparts  │  Events (newest first, paginated)        │
 *   │  cards        │   ─ ts ─ kind ─ direction ─ summary  ▶  │
 *   │  (filter)     │   ─ ts ─ kind ─ direction ─ summary  ▶  │
 *   │               │   ...                                    │
 *   └───────────────┴──────────────────────────────────────────┘
 *
 * Clicking an event row opens StreamEventModal with the full payload
 * + linked parent + inline artifact reader.
 *
 * Read-only: never writes to STM (cycle 20260430_3 invariant 5).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { transcriptsApi } from '@/lib/api';
import type {
  CounterpartCard,
  InteractionEventSummary,
} from '@/types';
import {
  ArrowDown, ArrowUp, ArrowDownUp, RefreshCw, FileText,
  MessageSquare, Activity, User, Bot, Sparkles, AlertCircle,
} from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { IconButton } from '@/components/common/layout';
import StreamEventModal from './StreamEventModal';

function cn(...classes: (string | boolean | undefined | null)[]) {
  return twMerge(classes.filter(Boolean).join(' '));
}

const KIND_LABEL: Record<string, string> = {
  user_chat: 'user chat',
  dm: 'dm',
  task_request: 'task request',
  task_result: 'task result',
  tool_run_summary: 'tool run',
  reflection: 'reflection',
  system_note: 'system',
};

const KIND_ORDER = [
  'user_chat',
  'task_request',
  'task_result',
  'tool_run_summary',
  'dm',
  'reflection',
  'system_note',
] as const;

const KIND_COLOR: Record<string, string> = {
  user_chat: 'text-[#60a5fa] bg-[rgba(96,165,250,0.12)] border-[rgba(96,165,250,0.4)]',
  dm: 'text-[#a78bfa] bg-[rgba(167,139,250,0.12)] border-[rgba(167,139,250,0.4)]',
  task_request: 'text-[#f59e0b] bg-[rgba(245,158,11,0.12)] border-[rgba(245,158,11,0.4)]',
  task_result: 'text-[#10b981] bg-[rgba(16,185,129,0.12)] border-[rgba(16,185,129,0.4)]',
  tool_run_summary: 'text-[#34d399] bg-[rgba(52,211,153,0.12)] border-[rgba(52,211,153,0.4)]',
  reflection: 'text-[#94a3b8] bg-[rgba(148,163,184,0.12)] border-[rgba(148,163,184,0.4)]',
  system_note: 'text-[#fb7185] bg-[rgba(251,113,133,0.12)] border-[rgba(251,113,133,0.4)]',
};

const ROLE_ICON = (role: string | null | undefined) => {
  switch ((role || '').toLowerCase()) {
    case 'user': return User;
    case 'paired_subworker': return Bot;
    case 'paired_vtuber': return Bot;
    case 'self': return Sparkles;
    case 'system': return AlertCircle;
    case 'peer': return Activity;
    default: return MessageSquare;
  }
};

function formatTs(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return iso; }
}

function counterpartLabel(card: CounterpartCard): string {
  if (card.id === 'self') return '나 (reflection)';
  if (card.id === 'system') return '시스템';
  if (card.id.startsWith('owner:')) return `사용자 (${card.id.slice(6)})`;
  if (card.role === 'paired_subworker') return `페어드 워커 (${card.id})`;
  if (card.role === 'paired_vtuber') return `페어드 VTuber (${card.id})`;
  return card.id;
}

const PAGE_LIMIT = 50;

export default function StreamTab({ sessionId }: { sessionId: string }) {
  const [counterparts, setCounterparts] = useState<CounterpartCard[]>([]);
  const [selectedCounterpart, setSelectedCounterpart] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set());
  const [directionFilter, setDirectionFilter] = useState<'all' | 'in' | 'out' | 'internal'>('all');
  const [events, setEvents] = useState<InteractionEventSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [totalEstimate, setTotalEstimate] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);

  const loadCounterparts = useCallback(async () => {
    try {
      const res = await transcriptsApi.counterparts(sessionId);
      setCounterparts(res.counterparts);
    } catch (err) {
      console.error('Failed to load counterparts:', err);
    }
  }, [sessionId]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await transcriptsApi.list(sessionId, {
        limit: PAGE_LIMIT,
        counterpart: selectedCounterpart || undefined,
        kinds: kindFilter.size ? Array.from(kindFilter) : undefined,
        direction: directionFilter === 'all' ? undefined : directionFilter,
      });
      setEvents(res.events);
      setNextCursor(res.next_cursor);
      setHasMore(res.has_more);
      setTotalEstimate(res.total_estimate);
    } catch (err) {
      console.error('Failed to load events:', err);
      setError('이벤트를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [sessionId, selectedCounterpart, kindFilter, directionFilter]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await transcriptsApi.list(sessionId, {
        limit: PAGE_LIMIT,
        cursor: nextCursor,
        counterpart: selectedCounterpart || undefined,
        kinds: kindFilter.size ? Array.from(kindFilter) : undefined,
        direction: directionFilter === 'all' ? undefined : directionFilter,
      });
      setEvents(prev => [...prev, ...res.events]);
      setNextCursor(res.next_cursor);
      setHasMore(res.has_more);
    } catch (err) {
      console.error('Failed to load more events:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [sessionId, nextCursor, hasMore, loadingMore, selectedCounterpart, kindFilter, directionFilter]);

  // Initial + reload on session change
  useEffect(() => {
    loadCounterparts();
    loadEvents();
  }, [loadCounterparts, loadEvents]);

  // Re-fetch when filters change (counterpart/kind/direction)
  useEffect(() => {
    loadEvents();
  }, [selectedCounterpart, kindFilter, directionFilter, loadEvents]);

  const refresh = useCallback(() => {
    loadCounterparts();
    loadEvents();
  }, [loadCounterparts, loadEvents]);

  const handleEventClick = useCallback((eventId: string) => {
    setOpenEventId(eventId);
  }, []);

  const closeEvent = useCallback(() => setOpenEventId(null), []);

  const distinctKindsInPage = useMemo(() => {
    const seen = new Set<string>();
    for (const e of events) if (e.kind) seen.add(e.kind);
    return Array.from(seen);
  }, [events]);

  const allKnownKinds = useMemo(() => {
    const set = new Set<string>(KIND_ORDER as readonly string[]);
    for (const k of distinctKindsInPage) set.add(k);
    return Array.from(set);
  }, [distinctKindsInPage]);

  return (
    // ``h-full`` is the operator-facing fix from cycle 20260503_8:
    // before, this row collapsed to its taller child's content
    // height when used inside a non-flex parent (the legacy
    // ``.opsidian-content`` block). Now both panels fill the
    // viewport and scroll independently.
    <div className="flex flex-col md:flex-row gap-3 md:gap-4 flex-1 min-h-0 h-full">
      {/* Counterpart sidebar — fixed-width column on desktop, stacked
          row on mobile. Self-scrolls; sticky header keeps the
          ``COUNTERPARTS`` label + refresh button visible. */}
      <div className="md:w-[280px] shrink-0 md:h-full md:min-h-0 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--border-radius)] overflow-y-auto max-h-[200px] md:max-h-none p-2">
        <div className="sticky top-0 z-10 -mx-2 -mt-2 px-3 py-1.5 mb-1 flex items-center justify-between bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
          <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wide">
            Counterparts
          </span>
          <IconButton variant="ghost" icon={RefreshCw} title="Refresh" onClick={refresh} />
        </div>

        {/* "All" pseudo-card */}
        <button
          onClick={() => setSelectedCounterpart(null)}
          className={cn(
            'w-full flex items-center gap-2 px-2 py-2 rounded text-[12px] transition-colors text-left',
            selectedCounterpart === null
              ? 'bg-[rgba(59,130,246,0.1)] text-[var(--primary-color)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
          )}
        >
          <ArrowDownUp size={14} />
          <span className="flex-1 truncate">전체</span>
          <span className="text-[10px] text-[var(--text-muted)]">{totalEstimate}</span>
        </button>

        <div className="my-2 border-t border-[var(--border-color)]" />

        {counterparts.length === 0 ? (
          <div className="px-2 py-3 text-[11px] text-[var(--text-muted)]">
            아직 누구와도 상호작용하지 않았어요.
          </div>
        ) : counterparts.map(card => {
          const Icon = ROLE_ICON(card.role);
          const active = selectedCounterpart === card.id;
          return (
            <button
              key={card.id}
              onClick={() => setSelectedCounterpart(card.id)}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-2 rounded text-[12px] transition-colors text-left',
                active
                  ? 'bg-[rgba(59,130,246,0.1)] text-[var(--primary-color)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              )}
              title={`${card.id}\nlast: ${formatTs(card.last_ts)}`}
            >
              <Icon size={14} className="shrink-0" />
              <div className="flex-1 truncate">
                <div className="truncate">{counterpartLabel(card)}</div>
                {card.role && (
                  <div className="text-[10px] text-[var(--text-muted)] truncate">
                    {card.role}
                  </div>
                )}
              </div>
              <span className="text-[10px] text-[var(--text-muted)]">{card.events}</span>
            </button>
          );
        })}
      </div>

      {/* Events panel — flexible width, self-scrolls. ``min-h-0``
          chains down so the event list inside actually scrolls
          instead of pushing the filter row off-screen. */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-[var(--border-radius)] overflow-hidden">
        {/* Filters row */}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] shrink-0">
          {/* Kind chips */}
          <div className="flex flex-wrap gap-1.5">
            {allKnownKinds.map(k => {
              const active = kindFilter.has(k);
              return (
                <button
                  key={k}
                  onClick={() => {
                    setKindFilter(prev => {
                      const next = new Set(prev);
                      if (active) next.delete(k); else next.add(k);
                      return next;
                    });
                  }}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10.5px] border transition-colors cursor-pointer',
                    active
                      ? KIND_COLOR[k] || 'bg-[rgba(59,130,246,0.12)] border-[rgba(59,130,246,0.4)] text-[var(--primary-color)]'
                      : 'border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--text-secondary)]',
                  )}
                >
                  {KIND_LABEL[k] || k}
                </button>
              );
            })}
          </div>

          <div className="flex-1" />

          {/* Direction toggle */}
          <div className="flex items-center rounded border border-[var(--border-color)] overflow-hidden text-[10.5px]">
            {(['all', 'in', 'out', 'internal'] as const).map(d => (
              <button
                key={d}
                onClick={() => setDirectionFilter(d)}
                className={cn(
                  'px-2 py-0.5 transition-colors',
                  d !== 'all' && 'border-l border-[var(--border-color)]',
                  directionFilter === d
                    ? 'bg-[var(--primary-color)] text-white'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
                )}
              >
                {d === 'all' ? '모두' : d}
              </button>
            ))}
          </div>
        </div>

        {/* Events list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-[12px] text-[var(--text-muted)]">
              불러오는 중…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-10 text-[12px] text-[#fb7185]">
              {error}
            </div>
          ) : events.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-[12px] text-[var(--text-muted)]">
              <FileText size={28} className="opacity-40" />
              <span>해당 조건의 이벤트가 아직 없어요.</span>
            </div>
          ) : (
            <ul>
              {events.map(ev => (
                <EventRow
                  key={ev.event_id}
                  event={ev}
                  onClick={() => handleEventClick(ev.event_id)}
                />
              ))}
              {hasMore && (
                <li className="p-3">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full py-2 rounded text-[12px] text-[var(--text-secondary)] border border-[var(--border-color)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                  >
                    {loadingMore ? '불러오는 중…' : '더 불러오기'}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      {/* Event detail modal */}
      {openEventId && (
        <StreamEventModal
          sessionId={sessionId}
          eventId={openEventId}
          onClose={closeEvent}
          onOpenLinked={(eid) => setOpenEventId(eid)}
        />
      )}
    </div>
  );
}

// ─── Event row ───────────────────────────────────────────────────────────


function DirectionIcon({ direction }: { direction: string | null }) {
  if (direction === 'in') return <ArrowDown size={11} className="text-[#60a5fa]" />;
  if (direction === 'out') return <ArrowUp size={11} className="text-[#f59e0b]" />;
  if (direction === 'internal') return <Activity size={11} className="text-[#94a3b8]" />;
  return <span className="w-2.5 h-2.5 inline-block" />;
}

function EventRow({
  event, onClick,
}: { event: InteractionEventSummary; onClick: () => void }) {
  const kindClass = KIND_COLOR[event.kind || ''] || 'border-[var(--border-color)] text-[var(--text-muted)]';
  return (
    <li
      onClick={onClick}
      className="px-3 py-2.5 border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)] cursor-pointer transition-colors"
    >
      <div className="flex items-center gap-2 mb-1">
        <DirectionIcon direction={event.direction} />
        <span className={cn(
          'px-1.5 py-0.5 rounded text-[10px] border',
          kindClass,
        )}>
          {KIND_LABEL[event.kind || ''] || event.kind || '—'}
        </span>
        <span className="text-[10.5px] text-[var(--text-muted)]">
          {formatTs(event.ts)}
        </span>
        {event.counterpart_id && (
          <span className="text-[10.5px] text-[var(--text-muted)] truncate">
            ↔ {event.counterpart_id}
          </span>
        )}
        <div className="flex-1" />
        {event.status && (
          <span className={cn(
            'text-[10px] px-1.5 py-0.5 rounded',
            event.status === 'ok' && 'bg-[rgba(16,185,129,0.15)] text-[#10b981]',
            event.status === 'partial' && 'bg-[rgba(245,158,11,0.15)] text-[#f59e0b]',
            event.status === 'failed' && 'bg-[rgba(251,113,133,0.15)] text-[#fb7185]',
          )}>{event.status}</span>
        )}
        {event.files_written_count !== undefined && event.files_written_count > 0 && (
          <span className="text-[10px] text-[var(--text-muted)]">
            📝 {event.files_written_count}
          </span>
        )}
        {event.tools_used_count !== undefined && event.tools_used_count > 0 && (
          <span className="text-[10px] text-[var(--text-muted)]">
            ⚙️ {event.tools_used_count}
          </span>
        )}
      </div>
      <div className="text-[12.5px] text-[var(--text-primary)] line-clamp-2 ml-5">
        {event.summary || <em className="text-[var(--text-muted)]">(empty)</em>}
      </div>
    </li>
  );
}
