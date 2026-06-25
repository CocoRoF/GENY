'use client';

/**
 * AvatarSettingsPanel — manage a connected geny-avatar instance from Geny.
 *
 * Rendered as the "Avatar" virtual Settings category (only when avatar is
 * running). The image-gen provider keys are Geny-owned (LLM/Media credentials,
 * auto-synced); this panel shows the avatar's LIVE key status, a one-click
 * re-sync from Geny, and direct edit of the avatar-only keys (fal/replicate).
 */

import { useCallback, useEffect, useState } from 'react';
import { avatarApi, syncApi } from '@/lib/api';
import { RefreshCw, Image as ImageIcon, CheckCircle2, XCircle } from 'lucide-react';

type AnyObj = Record<string, any>;

const btnCls =
  'inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50';

export default function AvatarSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [status, setStatus] = useState<{ configured: boolean; running: boolean; base_url: string } | null>(null);
  const [keys, setKeys] = useState<AnyObj[]>([]);

  const flash = (tone: 'ok' | 'err', text: string) => {
    setMsg({ tone, text });
    setTimeout(() => setMsg(null), 6000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await avatarApi.status().catch(() => null);
      setStatus(s);
      if (s?.running) {
        const k = await avatarApi.getKeys().catch(() => null);
        // The avatar returns { configPath, keys: [{id,label,configured,inEffect,preview,...}] }
        setKeys(Array.isArray(k?.keys) ? k.keys : []);
      } else {
        setKeys([]);
      }
    } catch (e: any) {
      flash('err', e?.message || 'avatar 상태를 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSync = async () => {
    setSyncing(true);
    try {
      const r = await syncApi.providerKeysNow();
      const av = Object.entries(r.results || {})
        .map(([k, v]) => (v && typeof v === 'object' && 'avatar' in v ? `${k.replace(/_API_KEY|_API_TOKEN|_KEY/g, '')}=${(v as AnyObj).avatar}` : null))
        .filter(Boolean);
      flash('ok', av.length ? `avatar 동기화: ${av.join(', ')}` : '동기화 완료');
      await load();
    } catch (e: any) {
      flash('err', e?.message || '동기화 실패');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 w-full">
      <div className="flex items-center gap-2">
        <ImageIcon className="w-5 h-5 text-[var(--primary-color)]" />
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Avatar — 이미지 생성 키</h2>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onSync} className={btnCls} disabled={syncing || !status?.running}>
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> Geny 키로 동기화
          </button>
          <button onClick={() => void load()} className={btnCls} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>
      </div>

      {msg && (
        <div className={`rounded-md px-3 py-2 text-sm border ${msg.tone === 'ok' ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10' : 'border-rose-500/30 text-rose-300 bg-rose-500/10'}`}>
          {msg.text}
        </div>
      )}

      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">연결</h3>
          <span className={`text-xs px-2 py-0.5 rounded-md border ${status?.running ? 'border-emerald-500/30 text-emerald-300' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}>
            {status?.running ? '연결됨' : status?.configured ? '구성됨(미응답)' : '미구성'}
          </span>
          {status?.base_url && <span className="ml-auto text-xs text-[var(--text-muted)] font-mono">{status.base_url}</span>}
        </div>
        <p className="text-xs text-[var(--text-secondary)]">
          이미지 생성 키(OpenAI/Gemini/fal/Replicate)는 Geny가 소유합니다. OpenAI/Gemini는 <b>LLM 백엔드</b>,
          fal/Replicate는 <b>General → Image Generation Keys</b>에서 설정하면 avatar로 자동 전파됩니다.
        </p>
      </section>

      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">avatar 키 상태</h3>
        {loading ? (
          <p className="text-sm text-[var(--text-muted)]">불러오는 중…</p>
        ) : keys.length ? (
          <div className="overflow-auto rounded-md border border-[var(--border-color)]">
            <table className="min-w-full text-sm">
              <thead className="bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                <tr>
                  <th className="text-left font-medium px-3 py-2 text-xs uppercase tracking-wide">Provider</th>
                  <th className="text-left font-medium px-3 py-2 text-xs uppercase tracking-wide">상태</th>
                  <th className="text-left font-medium px-3 py-2 text-xs uppercase tracking-wide">미리보기</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k, i) => {
                  const set = !!(k.configured ?? k.inEffect ?? k.preview);
                  return (
                    <tr key={k.id || i} className="border-t border-[var(--border-color)]">
                      <td className="px-3 py-2 text-[var(--text-primary)]">{k.label || k.id}</td>
                      <td className="px-3 py-2">
                        {set ? <span className="inline-flex items-center gap-1 text-emerald-400 text-xs"><CheckCircle2 className="w-3.5 h-3.5" /> 설정됨</span>
                             : <span className="inline-flex items-center gap-1 text-[var(--text-muted)] text-xs"><XCircle className="w-3.5 h-3.5" /> 없음</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-[var(--text-muted)]">{k.preview || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">{status?.running ? '키 정보를 가져오지 못했습니다.' : 'avatar가 연결되지 않았습니다.'}</p>
        )}
      </section>
    </div>
  );
}
