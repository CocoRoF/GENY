'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RefreshCw, Download, Trash2 } from 'lucide-react';
import { vtuberApi } from '@/lib/api';
import { useVTuberStore } from '@/store/useVTuberStore';

type BakedEntry = {
  filename: string;
  size_bytes: number;
  modified_iso: string;
  runtime: string | null;
  suggested_name: string | null;
  schema_version: number | null;
};

interface BakedImportsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * BakedImportsModal — Phase D.6 of the geny-avatar integration. Lists
 * pending baked-puppet zips that the avatar-editor service has dropped
 * into the shared docker volume, lets the user install or discard
 * each. Install registers the puppet in model_registry with an
 * `(Editor)` display-name suffix and refreshes the model list so it
 * appears in VTuberPanel's dropdown immediately.
 *
 * The modal also surfaces "Avatar Editor 열기" — opens /avatar-editor/
 * in a new tab so the user can run a round trip without juggling URLs.
 */
export default function BakedImportsModal({ open, onClose }: BakedImportsModalProps) {
  const fetchModels = useVTuberStore((s) => s.fetchModels);
  const [entries, setEntries] = useState<BakedEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Per-card "replace existing (Editor) entries" toggle. Keyed by
  // filename so each card tracks its own checkbox state independently.
  // Cleared on modal open.
  const [replaceMap, setReplaceMap] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await vtuberApi.listBakedImports();
      setEntries(r.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setInfo(null);
    setError(null);
    setEntries(null);
    setReplaceMap({});
    refresh();
  }, [open, refresh]);

  // Esc dismiss.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function handleInstall(filename: string) {
    setBusy(filename);
    setError(null);
    setInfo(null);
    const replaceExisting = replaceMap[filename] ?? false;
    try {
      const r = await vtuberApi.installBakedImport(filename, undefined, replaceExisting);
      const replacedNote =
        r.replaced.length > 0
          ? ` (기존 ${r.replaced.length}개 entries 정리됨: ${r.replaced
              .map((x) => x.display_name)
              .join(', ')})`
          : '';
      setInfo(`설치 완료: ${r.model.display_name}${replacedNote}`);
      // Refresh both — the inbox loses the entry (zip moved to
      // installed/) and the model list gains a new (Editor) suffix.
      await Promise.all([refresh(), fetchModels()]);
    } catch (e) {
      setError(`설치 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(filename: string) {
    if (!confirm(`이 zip 을 삭제하시겠습니까?\n${filename}`)) return;
    setBusy(filename);
    setError(null);
    setInfo(null);
    try {
      await vtuberApi.deleteBakedImport(filename);
      setInfo(`삭제 완료: ${filename}`);
      await refresh();
    } catch (e) {
      setError(`삭제 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;
  if (typeof window === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[85vh] w-[min(92vw,640px)] flex-col rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[var(--border-color)] px-4 py-3">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            Avatar 가져오기
          </span>
          <span className="text-xs text-[var(--text-muted)]">
            avatar-editor 에서 send 한 baked puppet 목록
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="ml-auto rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
            title="새로고침"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
            title="닫기 (Esc)"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {info && (
            <p className="mb-2 rounded border border-[var(--primary-color)] bg-[rgba(59,130,246,0.08)] px-3 py-2 text-xs text-[var(--primary-color)]">
              {info}
            </p>
          )}
          {error && (
            <p className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          {entries === null && (
            <p className="text-xs text-[var(--text-muted)]">불러오는 중…</p>
          )}

          {entries !== null && entries.length === 0 && (
            <div className="rounded border border-dashed border-[var(--border-color)] bg-[var(--bg-primary)] p-6 text-center text-xs text-[var(--text-muted)]">
              <p>대기 중인 puppet 이 없습니다.</p>
              <p className="mt-1">
                <a
                  href="/avatar-editor/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--primary-color)] underline"
                >
                  Avatar Editor 열기
                </a>{' '}
                에서 puppet 편집 후 "send to Geny" 클릭하면 여기에 나타납니다.
              </p>
            </div>
          )}

          {entries !== null && entries.length > 0 && (
            <ul className="space-y-2">
              {entries.map((e) => (
                <li
                  key={e.filename}
                  className="rounded border border-[var(--border-color)] bg-[var(--bg-primary)] p-3"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--primary-color)]">
                      [{e.runtime ?? '?'}]
                    </span>
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {e.suggested_name ?? e.filename.replace(/__\d{8}_\d{6}_?\d*\.zip$/, '')}
                    </span>
                    <span className="ml-auto text-[10px] text-[var(--text-muted)]">
                      {formatRelative(e.modified_iso)}
                    </span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-[var(--text-muted)]">
                    {e.filename} · {(e.size_bytes / 1024 / 1024).toFixed(1)} MB
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleInstall(e.filename)}
                      disabled={busy === e.filename}
                      className="inline-flex items-center gap-1 rounded border border-[var(--primary-color)] bg-[rgba(59,130,246,0.08)] px-2 py-0.5 text-[11px] text-[var(--primary-color)] hover:bg-[rgba(59,130,246,0.18)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Download size={11} />
                      {busy === e.filename ? '설치 중…' : 'install'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(e.filename)}
                      disabled={busy === e.filename}
                      className="inline-flex items-center gap-1 rounded border border-[var(--border-color)] px-2 py-0.5 text-[11px] text-[var(--text-muted)] hover:border-red-500/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 size={11} />
                      delete
                    </button>
                    <label
                      className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      title="기존에 같은 이름으로 install 된 (Editor) 항목들을 모두 삭제하고 새로 설치"
                    >
                      <input
                        type="checkbox"
                        checked={replaceMap[e.filename] ?? false}
                        onChange={(ev) =>
                          setReplaceMap((prev) => ({
                            ...prev,
                            [e.filename]: ev.target.checked,
                          }))
                        }
                        disabled={busy === e.filename}
                        className="h-3 w-3 cursor-pointer accent-[var(--primary-color)]"
                      />
                      기존 (Editor) 덮어쓰기
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-[var(--border-color)] px-4 py-2 text-xs">
          <a
            href="/avatar-editor/"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-[var(--border-color)] px-2 py-0.5 text-[var(--text-muted)] hover:border-[var(--primary-color)] hover:text-[var(--primary-color)]"
          >
            Avatar Editor 열기 ↗
          </a>
          <span className="ml-auto text-[10px] text-[var(--text-muted)]">
            install 후 모델 리스트에 <span className="text-[var(--text-primary)]">(Editor)</span>{' '}
            접미사로 등장
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatRelative(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diff = Math.max(0, Date.now() - t);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}초 전`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    return `${Math.floor(hr / 24)}일 전`;
  } catch {
    return iso;
  }
}
