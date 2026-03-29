'use client';

import { useRef, useEffect, useMemo } from 'react';
import { useVTuberStore } from '@/store/useVTuberStore';
import type { VTuberLogEntry } from '@/types';

const EMPTY_LOGS: VTuberLogEntry[] = [];

/**
 * VTuberLogPanel — CLI-style scrollable log panel for the VTuber tab.
 *
 * Displays all avatar state changes, SSE events, model assignments,
 * emotion overrides, and errors in real-time.
 */

interface VTuberLogPanelProps {
  sessionId: string;
}

const LEVEL_COLORS: Record<VTuberLogEntry['level'], string> = {
  info: 'text-blue-400',
  state: 'text-green-400',
  error: 'text-red-400',
  warn: 'text-yellow-400',
  debug: 'text-gray-500',
};

const LEVEL_LABELS: Record<VTuberLogEntry['level'], string> = {
  info: 'INFO',
  state: 'STATE',
  error: 'ERROR',
  warn: 'WARN',
  debug: 'DEBUG',
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
      + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch {
    return '??:??:??';
  }
}

export default function VTuberLogPanel({ sessionId }: VTuberLogPanelProps) {
  const logs = useVTuberStore((s) => s.logs[sessionId] ?? EMPTY_LOGS);
  const clearLogs = useVTuberStore((s) => s.clearLogs);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  return (
    <div className="flex flex-col h-full bg-[#0d1117] text-[0.75rem] font-mono">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-[#30363d] shrink-0">
        <span className="text-[0.6875rem] text-gray-400 font-medium tracking-wider uppercase">
          VTuber Logs
          <span className="ml-2 text-gray-600">({logs.length})</span>
        </span>
        <button
          onClick={() => clearLogs(sessionId)}
          className="text-[0.625rem] text-gray-500 hover:text-gray-300 px-2 py-0.5 rounded hover:bg-[#21262d] transition-colors cursor-pointer"
        >
          Clear
        </button>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-1 min-h-0">
        {logs.length === 0 ? (
          <div className="text-gray-600 text-center py-4">No logs yet</div>
        ) : (
          logs.map((entry) => (
            <div key={entry.id} className="flex gap-2 py-[1px] leading-5 hover:bg-[#161b22]">
              <span className="text-gray-600 shrink-0 select-none">
                {formatTime(entry.timestamp)}
              </span>
              <span className={`shrink-0 w-[3.25rem] text-right select-none ${LEVEL_COLORS[entry.level]}`}>
                {LEVEL_LABELS[entry.level]}
              </span>
              <span className="text-purple-400 shrink-0 w-[3.5rem] text-right select-none">
                {entry.source}
              </span>
              <span className="text-gray-300 break-all">
                {entry.message}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
