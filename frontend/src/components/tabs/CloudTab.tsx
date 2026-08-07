// 클라우드 — GenyCloud, the storage that sits ABOVE the agents.
//
// The model this view makes visible:
//
//   [user's folders] ↔ [local GenyCloud] ↔ [SERVER CLOUD] ↔ [agent workspace]
//
// The left rail is the source picker for those three places:
//   · 클라우드 전체     — the cloud itself, the hub everything gathers in
//   · 에이전트          — a connected agent's own workspace (private space)
//   · 연결된 폴더       — a folder on one of the user's computers, shared
//                        into the cloud by the connector
//
// Browsing is the SAME explorer the session storage tab uses (it takes a
// scope), so there is one implementation of "what a folder looks like"
// instead of two that drift.
import { useCallback, useEffect, useState } from 'react';
import { Cloud, Bot, Link2 } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { agentApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import StorageTab from '@/components/tabs/StorageTab';

const CLOUD_SCOPE = '_cloud';

type Source =
  | { kind: 'cloud' }
  | { kind: 'agent'; id: string; name: string }
  | { kind: 'link'; name: string; device: string };

export default function CloudTab() {
  const { t } = useI18n();
  const { sessions } = useAppStore();
  const [source, setSource] = useState<Source>({ kind: 'cloud' });
  const [members, setMembers] = useState<string[]>([]);
  const [links, setLinks] = useState<Array<{ name: string; device: string }>>([]);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    const [m, l] = await Promise.all([
      agentApi.cloudMembers().catch(() => ({ sessions: [] as string[] })),
      agentApi.storageLinks(CLOUD_SCOPE).catch(() => ({ links: [] })),
    ]);
    setMembers(m.sessions || []);
    setLinks(l.links || []);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggleAgent = async (id: string, connected: boolean) => {
    setBusy(id);
    try {
      await agentApi.setCloudConnection(id, connected);
      await refresh();
      // A disconnected agent's workspace is still browsable; only its
      // access to the cloud ended. Fall back to the cloud so the view
      // never sits on a source the user just switched off.
      if (!connected && source.kind === 'agent' && source.id === id) {
        setSource({ kind: 'cloud' });
      }
    } finally {
      setBusy('');
    }
  };

  const rowBase =
    'w-full flex items-center gap-2 px-2.5 py-[7px] rounded-lg text-[13px] text-left transition-colors';
  const rowOn = 'bg-[var(--accent-color)]/12 text-[var(--text-primary)]';
  const rowOff = 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]';

  const scopeId =
    source.kind === 'agent' ? source.id : CLOUD_SCOPE;
  const initialPath = source.kind === 'link' ? source.name : '';
  // Remount the explorer when the source changes: it keeps cwd/selection
  // state, and carrying those across scopes would show a path that does
  // not exist in the new one.
  const explorerKey = `${source.kind}:${scopeId}:${initialPath}`;

  const hint =
    source.kind === 'cloud' ? t('cloudTab.hintCloud')
    : source.kind === 'agent'
      ? (members.includes(source.id) ? t('cloudTab.hintAgentOn') : t('cloudTab.hintAgentOff'))
      : t('cloudTab.hintLink', { device: source.device });

  // No header of its own: the tab strip above already names this view, so a
  // title row carrying one refresh button was a whole row of chrome for
  // nothing. The description moves into the explorer's toolbar (left slot)
  // and the refresh moves into its refresh button — one bar, nothing lost.
  return (
    <div className="flex flex-col h-full min-h-0 bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <div className="flex h-full min-h-0">
        <aside className="w-[210px] shrink-0 border-r border-[var(--border-color)] overflow-y-auto p-1.5">
          <button
            className={`${rowBase} ${source.kind === 'cloud' ? rowOn : rowOff}`}
            onClick={() => setSource({ kind: 'cloud' })}
          >
            <Cloud size={15} className="text-[#4f9cf7]" />
            <span className="flex-1 truncate">{t('cloudTab.wholeCloud')}</span>
          </button>

          <div className="mt-3 mb-1 px-2.5 text-[11px] text-[var(--text-muted)]">
            {t('cloudTab.agents')}
          </div>
          {sessions.length === 0 && (
            <p className="px-2.5 text-[12px] text-[var(--text-muted)]">{t('cloudTab.noAgents')}</p>
          )}
          {sessions.map((s) => {
            const connected = members.includes(s.session_id);
            const active = source.kind === 'agent' && source.id === s.session_id;
            return (
              <div key={s.session_id} className="flex items-center gap-1">
                <button
                  className={`${rowBase} ${active ? rowOn : rowOff} flex-1 min-w-0`}
                  onClick={() =>
                    setSource({ kind: 'agent', id: s.session_id, name: s.session_name || s.session_id })
                  }
                >
                  <Bot size={15} className={connected ? 'text-[#2fbf71]' : 'text-[var(--text-muted)]'} />
                  <span className="flex-1 truncate">{s.session_name || s.session_id.slice(0, 8)}</span>
                </button>
                <button
                  disabled={busy === s.session_id}
                  title={connected ? t('cloudTab.disconnectHint') : t('cloudTab.connectHint')}
                  className={`shrink-0 text-[10.5px] px-1.5 py-[2px] rounded-full transition-colors ${
                    connected
                      ? 'bg-[#2fbf71]/12 text-[#2fbf71]'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                  }`}
                  onClick={() => void toggleAgent(s.session_id, !connected)}
                >
                  {connected ? t('cloudTab.connected') : t('cloudTab.connect')}
                </button>
              </div>
            );
          })}

          <div className="mt-3 mb-1 px-2.5 text-[11px] text-[var(--text-muted)]">
            {t('cloudTab.linkedFolders')}
          </div>
          {links.length === 0 && (
            <p className="px-2.5 text-[12px] text-[var(--text-muted)]">{t('cloudTab.noLinks')}</p>
          )}
          {links.map((l) => {
            const active = source.kind === 'link' && source.name === l.name;
            return (
              <button
                key={l.name}
                className={`${rowBase} ${active ? rowOn : rowOff}`}
                onClick={() => setSource({ kind: 'link', name: l.name, device: l.device })}
                title={t('cloudTab.linkHint', { device: l.device })}
              >
                <Link2 size={15} className="text-[#8b5cf6]" />
                <span className="flex-1 truncate">{l.name}</span>
              </button>
            );
          })}
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0">
            <StorageTab
              key={explorerKey}
              scopeId={scopeId}
              initialPath={initialPath}
              embedded
              hint={hint}
              onRefresh={() => void refresh()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
