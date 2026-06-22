'use client';

/**
 * DigestPanel — the session's COMPRESSED-FIRST memory view.
 *
 * Surfaces the two always-injected compressed tiers that otherwise aren't
 * visible in the note tree:
 *   - the rolling DIGEST (Stage-2 L1; lives at transcripts/summary.md), and
 *   - the durable EVERGREEN (pinned `critical`; what the agent carries across
 *     sessions).
 * These are exactly what the agent is served before any raw memory — the
 * "압축본 선행" view. Raw notes remain explorable in the editor/graph tabs.
 */

import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RefreshCw, Sparkles, BookMarked } from 'lucide-react';
import { memoryApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function DigestPanel({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<{
    digest: string;
    evergreen: string;
    has_digest: boolean;
    has_evergreen: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      setData(await memoryApi.getSummary(sessionId));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="obs-digest">
      <div className="obs-digest-head">
        <Sparkles size={14} />
        <span className="obs-digest-title">{t('opsidian.digestTitle')}</span>
        <span className="obs-digest-sub">{t('opsidian.digestSub')}</span>
        <button
          className="obs-digest-refresh"
          onClick={() => void load()}
          disabled={loading}
          aria-label="refresh"
        >
          <RefreshCw size={12} className={loading ? 'obs-spin' : ''} />
        </button>
      </div>

      <div className="obs-digest-body">
        {/* Evergreen — durable, always loaded */}
        <section className="obs-digest-section">
          <h3 className="obs-digest-h">
            <BookMarked size={13} /> {t('opsidian.digestEvergreen')}
          </h3>
          {data?.has_evergreen ? (
            <div className="obs-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {data.evergreen}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="obs-digest-empty">{t('opsidian.digestEmpty')}</p>
          )}
        </section>

        {/* Rolling digest — recent compressed view */}
        <section className="obs-digest-section">
          <h3 className="obs-digest-h">
            <Sparkles size={13} /> {t('opsidian.digestRolling')}
          </h3>
          {data?.has_digest ? (
            <div className="obs-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {data.digest}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="obs-digest-empty">{t('opsidian.digestEmpty')}</p>
          )}
        </section>
      </div>
    </div>
  );
}
