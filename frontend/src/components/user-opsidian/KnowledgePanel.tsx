'use client';

/**
 * KnowledgePanel — 지식 저장소 뷰 (user vault의 knowledge 카테고리).
 *
 * - 드래그드롭/클릭 업로드 → /api/opsidian/knowledge/upload (fire-and-forget)
 * - 문서 목록: 카드 노트의 status(processing→ready/failed)를 폴링으로 반영
 * - 시맨틱 검색 미리보기 (qdrant, title/page/heading 출처 포함)
 * - OpenAI 키 미설정/무효(409 openai_key_missing|invalid) → 설정 화면 이동 배너
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BookOpenText,
  Database,
  FileUp,
  Globe,
  KeyRound,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Webhook,
} from 'lucide-react';
import {
  knowledgeApi,
  type KnowledgeDoc,
  type KnowledgeHit,
  type KnowledgeSource,
} from '@/lib/api';

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  ready: { color: '#22c55e', label: 'ready' },
  processing: { color: '#f59e0b', label: 'processing' },
  failed: { color: '#ef4444', label: 'failed' },
};

const SOURCE_ICON: Record<string, typeof Globe> = {
  api: Webhook,
  web: Globe,
  db: Database,
};

const SOURCE_CONFIG_HINT: Record<string, string> = {
  api: '{"url": "https://…", "method": "GET", "headers": {}}',
  web: '{"url": "https://…", "render_js": false, "sitemap": false, "max_pages": 20}',
  db: '{"dsn": "postgresql://user:pw@host/db", "query": "select …", "key_column": "id"}',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 9px', fontSize: 12,
  borderRadius: 6, border: '1px solid var(--obs-border, #2c2c2e)',
  background: 'transparent', color: 'inherit', outline: 'none',
};

/** 커넥터 추가/수정 폼 — config는 JSON 텍스트로 편집한다. */
function SourceForm({
  onSaved,
  onCancel,
}: {
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'api' | 'web' | 'db'>('web');
  const [schedule, setSchedule] = useState('0 * * * *');
  const [configText, setConfigText] = useState(SOURCE_CONFIG_HINT.web);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const save = async () => {
    setFormError(null);
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configText);
    } catch {
      setFormError('config가 유효한 JSON이 아닙니다');
      return;
    }
    if (!name.trim()) {
      setFormError('이름을 입력하세요');
      return;
    }
    setSaving(true);
    try {
      await knowledgeApi.saveSource({ name: name.trim(), type, schedule, config });
      onSaved();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--obs-border, #2c2c2e)', borderRadius: 8,
        padding: 12, marginBottom: 10, display: 'flex',
        flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="소스 이름 (예: 사내 위키)"
          style={{ ...inputStyle, flex: 1 }}
        />
        <select
          value={type}
          onChange={(e) => {
            const t = e.target.value as 'api' | 'web' | 'db';
            setType(t);
            setConfigText(SOURCE_CONFIG_HINT[t]);
          }}
          style={{ ...inputStyle, width: 80 }}
        >
          <option value="web">web</option>
          <option value="api">api</option>
          <option value="db">db</option>
        </select>
        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="cron"
          title="cron 표현식 (예: 0 * * * * = 매시)"
          style={{ ...inputStyle, width: 110 }}
        />
      </div>
      <textarea
        value={configText}
        onChange={(e) => setConfigText(e.target.value)}
        rows={3}
        spellCheck={false}
        style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 11.5, resize: 'vertical' }}
      />
      {formError && <div style={{ color: '#ef4444', fontSize: 11.5 }}>{formError}</div>}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button className="obs-sb-icon-btn" style={{ width: 'auto', padding: '4px 12px', fontSize: 12 }} onClick={onCancel}>
          취소
        </button>
        <button
          className="obs-sb-icon-btn"
          style={{
            width: 'auto', padding: '4px 12px', fontSize: 12, fontWeight: 600,
            background: 'var(--obs-purple, #8b5cf6)', color: '#fff',
          }}
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}

export default function KnowledgePanel({
  onSelectFile,
}: {
  onSelectFile: (filename: string) => void;
}) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [keyMissing, setKeyMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await knowledgeApi.listDocuments();
      setDocs(res.documents);
    } catch {
      /* transient */
    }
  }, []);

  const refreshSources = useCallback(async () => {
    try {
      const res = await knowledgeApi.listSources();
      setSources(res.sources);
      return res.sources;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await refresh();
      await refreshSources();
      try {
        const s = await knowledgeApi.status();
        if (!cancelled) setKeyMissing(!s.embedding_ready);
      } catch {
        /* status is advisory */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refresh, refreshSources]);

  // processing 문서가 있는 동안 5초 폴링
  useEffect(() => {
    if (!docs.some((d) => d.status === 'processing')) return;
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [docs, refresh]);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      setError(null);
      setLoading(true);
      try {
        for (const file of Array.from(files)) {
          try {
            await knowledgeApi.upload(file);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/openai_key_(missing|invalid)/.test(msg)) {
              setKeyMissing(true);
            } else {
              setError(`${file.name}: ${msg}`);
            }
          }
        }
        await refresh();
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  const runNow = useCallback(
    async (source: KnowledgeSource) => {
      setRunningIds((prev) => new Set(prev).add(source.id));
      const prevRunAt = source.last_run_at;
      try {
        await knowledgeApi.runSource(source.id);
        // 실행 완료(북키핑 반영)까지 폴링 — 최대 60초
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const rows = await refreshSources();
          const updated = rows?.find((x) => x.id === source.id);
          if (updated && updated.last_run_at !== prevRunAt) break;
        }
        await refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/openai_key_(missing|invalid)/.test(msg)) setKeyMissing(true);
        else setError(`${source.name}: ${msg}`);
      } finally {
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(source.id);
          return next;
        });
      }
    },
    [refresh, refreshSources],
  );

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const res = await knowledgeApi.search(q);
      setHits(res.hits);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/openai_key_(missing|invalid)/.test(msg)) setKeyMissing(true);
      setHits([]);
    } finally {
      setSearching(false);
    }
  }, [query]);

  return (
    <div style={{ padding: 20, overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <BookOpenText size={18} style={{ color: 'var(--obs-purple, #8b5cf6)' }} />
        <h2 style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>
          지식 저장소 <span style={{ fontWeight: 400, opacity: 0.6 }}>{docs.length} documents</span>
        </h2>
        <button className="obs-sb-icon-btn" onClick={() => void refresh()} title="새로고침">
          <RefreshCw size={14} />
        </button>
      </div>

      {keyMissing && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
            borderRadius: 8, marginBottom: 14,
            background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)',
            fontSize: 12.5,
          }}
        >
          <KeyRound size={15} style={{ color: '#f59e0b', flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            문서 임베딩(text-embedding-3-large)에 유효한 OpenAI API 키가 필요합니다 —
            키가 없거나 거부(401)되었습니다.
          </span>
          <Link
            href="/setup"
            style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              background: '#f59e0b', color: '#fff', textDecoration: 'none', flexShrink: 0,
            }}
          >
            설정으로 이동
          </Link>
        </div>
      )}

      {/* 업로드 존 */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${dragOver ? 'var(--obs-purple, #8b5cf6)' : 'var(--obs-border, #2c2c2e)'}`,
          borderRadius: 10, padding: '26px 16px', textAlign: 'center',
          cursor: 'pointer', marginBottom: 16,
          background: dragOver ? 'rgba(139,92,246,0.06)' : 'transparent',
          transition: 'border-color 150ms ease, background 150ms ease',
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
        />
        {loading ? (
          <Loader2 size={20} className="animate-spin" style={{ margin: '0 auto 6px' }} />
        ) : (
          <FileUp size={20} style={{ margin: '0 auto 6px', opacity: 0.6 }} />
        )}
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          문서를 끌어다 놓거나 클릭해서 업로드
        </div>
        <div style={{ fontSize: 11, opacity: 0.55, marginTop: 3 }}>
          PDF · DOCX · PPTX · XLSX · HWP · MD · TXT · JSON … (50MB 이하) — 업로드 즉시
          Contextifier가 텍스트·청크로 변환하고 세션이 검색할 수 있게 됩니다
        </div>
      </div>

      {error && (
        <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 10 }}>{error}</div>
      )}

      {/* 시맨틱 검색 미리보기 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: 9, opacity: 0.5 }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
            placeholder="지식 저장소 시맨틱 검색…"
            style={{
              width: '100%', padding: '7px 10px 7px 28px', fontSize: 12.5,
              borderRadius: 7, border: '1px solid var(--obs-border, #2c2c2e)',
              background: 'transparent', color: 'inherit', outline: 'none',
            }}
          />
        </div>
        <button
          className="obs-sb-icon-btn"
          onClick={() => void runSearch()}
          disabled={searching}
          style={{ width: 34 }}
        >
          {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
        </button>
      </div>

      {hits !== null && (
        <div style={{ marginBottom: 18 }}>
          {hits.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.55, padding: '4px 2px' }}>검색 결과 없음</div>
          ) : (
            hits.map((h, i) => (
              <button
                key={i}
                onClick={() => h.filename && onSelectFile(`knowledge/${h.filename}`)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
                  borderRadius: 7, border: '1px solid var(--obs-border-subtle, #222)',
                  background: 'transparent', cursor: 'pointer', marginBottom: 6, color: 'inherit',
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
                  {h.title}
                  <span style={{ fontWeight: 400, opacity: 0.55, marginLeft: 6 }}>
                    {h.page != null && `p.${h.page}`} {h.heading && `· ${h.heading}`}
                    {' · '}score {h.score}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, opacity: 0.75, lineHeight: 1.45 }}>
                  {h.text.slice(0, 220)}
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {/* 문서 목록 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {docs.map((d) => {
          const st = STATUS_STYLE[d.status] || STATUS_STYLE.ready;
          return (
            <div
              key={d.doc_id || d.filename}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                borderRadius: 8, border: '1px solid var(--obs-border-subtle, #222)',
              }}
            >
              <span
                style={{
                  width: 8, height: 8, borderRadius: '50%', background: st.color,
                  flexShrink: 0,
                }}
                title={st.label}
              />
              <button
                onClick={() => d.filename && onSelectFile(d.filename)}
                style={{
                  flex: 1, textAlign: 'left', background: 'none', border: 'none',
                  cursor: 'pointer', color: 'inherit', minWidth: 0,
                }}
              >
                <div style={{
                  fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {d.title}
                </div>
                <div style={{ fontSize: 10.5, opacity: 0.55 }}>
                  {d.source_type}{d.source_ref ? ` · ${d.source_ref}` : ''} · {d.chunk_count} chunks
                  {d.status === 'processing' && ' · 변환 중…'}
                  {d.status === 'failed' && ' · 실패 — 카드 노트에서 원인 확인'}
                </div>
              </button>
              <button
                className="obs-sb-icon-btn"
                title="문서 삭제 (카드+원본+벡터)"
                onClick={async () => {
                  if (!d.doc_id) return;
                  await knowledgeApi.deleteDocument(d.doc_id).catch(() => {});
                  void refresh();
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
        {docs.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.5, textAlign: 'center', padding: 18 }}>
            아직 문서가 없습니다 — 위에 업로드하면 세션의 지식이 됩니다.
          </div>
        )}
      </div>

      {/* 지속 수집 소스 (api / web / db 커넥터) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '26px 0 10px' }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>
          지속 수집{' '}
          <span style={{ fontWeight: 400, opacity: 0.6 }}>{sources.length} sources</span>
        </h3>
        <button
          className="obs-sb-icon-btn"
          title="수집 소스 추가"
          onClick={() => setShowSourceForm((v) => !v)}
        >
          <Plus size={14} />
        </button>
      </div>

      {showSourceForm && (
        <SourceForm
          onSaved={() => {
            setShowSourceForm(false);
            void refreshSources();
          }}
          onCancel={() => setShowSourceForm(false)}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sources.map((s) => {
          const Icon = SOURCE_ICON[s.type] || Globe;
          const running = runningIds.has(s.id);
          const r = s.last_result;
          return (
            <div
              key={s.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                borderRadius: 8, border: '1px solid var(--obs-border-subtle, #222)',
                opacity: s.enabled ? 1 : 0.5,
              }}
            >
              <Icon size={15} style={{ flexShrink: 0, opacity: 0.7 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {s.name}
                  <span style={{ fontWeight: 400, opacity: 0.55, marginLeft: 6 }}>
                    {s.type} · {s.schedule}
                  </span>
                </div>
                <div style={{ fontSize: 10.5, opacity: 0.6 }}>
                  {running && '수집 중…'}
                  {!running && r && r.ok && (
                    <>수집 {r.ingested ?? 0} · 변경없음 {r.unchanged ?? 0}
                      {s.last_run_at && ` · ${new Date(s.last_run_at).toLocaleString()}`}</>
                  )}
                  {!running && r && !r.ok && (
                    <span style={{ color: '#ef4444' }}>실패: {r.error || 'unknown'}</span>
                  )}
                  {!running && !r && '아직 실행 안 됨 — 스케줄 대기 또는 ▶ 즉시 실행'}
                </div>
              </div>
              <button
                className="obs-sb-icon-btn"
                title="지금 수집"
                disabled={running}
                onClick={() => void runNow(s)}
              >
                {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              </button>
              <button
                className="obs-sb-icon-btn"
                title="소스 삭제 (수집된 문서는 유지)"
                onClick={async () => {
                  await knowledgeApi.deleteSource(s.id).catch(() => {});
                  void refreshSources();
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
        {sources.length === 0 && !showSourceForm && (
          <div style={{ fontSize: 11.5, opacity: 0.5, padding: '2px 2px 10px' }}>
            API·웹사이트·DB를 연결하면 스케줄에 따라 자동으로 지식이 수집됩니다.
          </div>
        )}
      </div>
    </div>
  );
}
