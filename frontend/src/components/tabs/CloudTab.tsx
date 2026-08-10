// 클라우드 — GenyCloud, the storage that sits ABOVE the agents.
//
// THE MODEL THIS VIEW MAKES VISIBLE
//
//   [folder] ── [computer] ── [GENY CLOUD] ── [agent]
//
// The cloud is the ONLY connection point. A computer attaches to the cloud;
// an agent attaches to the cloud; a folder attaches through the computer
// that holds it. There is deliberately no computer→agent edge: that was the
// old model, where one shared folder became a copy inside every agent's
// workspace with an engine per copy.
//
// The rail is that graph, read outward from the hub:
//   · 클라우드 전체  — the hub itself
//   · 연결된 PC      — the user's machines, each with the folders it shares
//                      nested beneath it (a folder lives ON a machine, so it
//                      is shown there rather than in a list of its own)
//   · 에이전트       — the agents, each connectable to the hub
//
// A machine stays listed while it is asleep. Dropping it on disconnect would
// read as "unpaired" rather than "offline", and its folders would lose the
// machine they belong to.
//
// Browsing is the SAME explorer the session storage tab uses (it takes a
// scope), so there is one implementation of "what a folder looks like"
// instead of two that drift.
import { useCallback, useEffect, useState } from 'react';
import {
  Cloud, Bot, Folder, History, Monitor, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { agentApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import StorageTab from '@/components/tabs/StorageTab';
import CloudHistoryView from '@/components/tabs/CloudHistoryView';

const CLOUD_SCOPE = '_cloud';

interface Device {
  device_id: string;
  device_name: string;
  online: boolean;
  last_seen: number | null;
  links: Array<{ name: string }>;
}

type Source =
  | { kind: 'history' }
  | { kind: 'cloud' }
  | { kind: 'device'; id: string; name: string }
  | { kind: 'agent'; id: string; name: string }
  | { kind: 'link'; name: string; device: string };

// ── One pill, one geometry ───────────────────────────────────────────
//
// The status badges used to be written twice: a <span> on machines, a
// <button> on agents, with the same utility classes. The classes were
// the same and the boxes were NOT — an inline <span> renders vertical
// padding without it counting toward the line box, while a <button> is
// inline-block and lays out as a real box. Same markup intent, two
// different heights sitting next to each other in one rail.
//
// So the geometry lives in exactly one place, stated explicitly (fixed
// height + leading-none rather than inherited line-height), and the two
// call sites differ only in what they are: a label, or a control.
const PILL_BOX =
  'inline-flex h-[18px] shrink-0 items-center justify-center rounded-full ' +
  'px-2 text-[10.5px] leading-none whitespace-nowrap';
const PILL_ON = 'bg-[#2fbf71]/12 text-[#2fbf71]';
const PILL_OFF = 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]';

function Pill({ on, children }: { on: boolean; children: React.ReactNode }) {
  return <span className={`${PILL_BOX} ${on ? PILL_ON : PILL_OFF}`}>{children}</span>;
}

export default function CloudTab() {
  const { t } = useI18n();
  const { sessions } = useAppStore();
  const [source, setSource] = useState<Source>({ kind: 'cloud' });
  const [members, setMembers] = useState<string[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [orphanLinks, setOrphanLinks] = useState<Array<{ name: string }>>([]);
  const [busy, setBusy] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    const [m, d] = await Promise.all([
      agentApi.cloudMembers().catch(() => ({ sessions: [] as string[] })),
      agentApi.cloudDevices().catch(() => ({ devices: [], unassigned_links: [] })),
    ]);
    setMembers(m.sessions || []);
    setDevices(d.devices || []);
    setOrphanLinks(d.unassigned_links || []);
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

  // A row that carries a trailing pill can't be a single <button>: the
  // agent's pill is itself a control, and a button inside a button is
  // invalid and unclickable. So the padding lives on a wrapper and the
  // label is a full-height button beside the pill — which also makes
  // every pill in the rail end at the same right edge. Previously the
  // agent pill sat OUTSIDE the padded row and the machine pill INSIDE
  // it, so the two columns of badges did not line up.
  const rowShell = 'flex items-center gap-2 px-2.5 rounded-lg transition-colors';
  const rowLabel =
    'flex flex-1 min-w-0 items-center gap-2 py-[7px] text-[13px] text-left bg-transparent';

  const scopeId =
    source.kind === 'agent' ? source.id : CLOUD_SCOPE;
  const initialPath = source.kind === 'link' ? source.name : '';
  // Remount the explorer when the source changes: it keeps cwd/selection
  // state, and carrying those across scopes would show a path that does
  // not exist in the new one.
  const explorerKey = `${source.kind}:${scopeId}:${initialPath}`;

  // A machine has no storage of its own — it mirrors the cloud — so
  // selecting one browses the cloud and the hint carries what is
  // actually specific to that machine: whether it is awake, and which
  // of its folders are in here.
  const selectedDevice =
    source.kind === 'device'
      ? devices.find((d) => d.device_id === source.id)
      : undefined;
  const deviceHint = selectedDevice && source.kind === 'device'
    ? t(selectedDevice.online ? 'cloudTab.hintDeviceOn' : 'cloudTab.hintDeviceOff', {
        name: source.name,
        folders: selectedDevice.links.length
          ? selectedDevice.links.map((l) => l.name).join(', ')
          : t('cloudTab.deviceNoFolders'),
      })
    : t('cloudTab.hintCloud');

  const hint =
    source.kind === 'cloud' || source.kind === 'history' ? t('cloudTab.hintCloud')
    : source.kind === 'device' ? deviceHint
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
          {/* History sits above the sources, and outside them: it is not a
              place to browse but the record of what happened — hence the
              separator rather than another source row. It reports the CLOUD,
              which is where machines and agents actually meet; an agent's
              private workspace keeps its own history under its own scope. */}
          <button
            className={`${rowBase} ${source.kind === 'history' ? rowOn : rowOff}`}
            onClick={() => setSource({ kind: 'history' })}
          >
            <History size={15} className="text-[#e8a13c]" />
            <span className="flex-1 truncate">{t('cloudHistory.title')}</span>
          </button>
          <div className="my-1.5 border-t border-[var(--border-color)]" />

          <button
            className={`${rowBase} ${source.kind === 'cloud' ? rowOn : rowOff}`}
            onClick={() => setSource({ kind: 'cloud' })}
          >
            <Cloud size={15} className="text-[#4f9cf7]" />
            <span className="flex-1 truncate">{t('cloudTab.wholeCloud')}</span>
          </button>

          {/* ── 연결된 PC ── each machine, with the folders it shares.
              A machine has no storage of its own to browse: it mirrors the
              cloud. So the row states the attachment and its folders are
              what you navigate into. */}
          <div className="mt-3 mb-1 px-2.5 text-[11px] text-[var(--text-muted)]">
            {t('cloudTab.computers')}
          </div>
          {devices.length === 0 && (
            <p className="px-2.5 text-[12px] text-[var(--text-muted)] leading-snug">
              {t('cloudTab.noComputers')}
            </p>
          )}
          {devices.map((d) => {
            const label = d.device_name || d.device_id.slice(0, 8);
            const deviceActive = source.kind === 'device' && source.id === d.device_id;
            // Collapsed state is opt-in: everything stays open as before
            // unless the operator folds it away.
            const open = !collapsed[d.device_id];
            return (
              <div key={d.device_id}>
                <div
                  className={`${rowShell} ${deviceActive ? rowOn : rowOff}`}
                  title={t(d.online ? 'cloudTab.computerOnlineHint' : 'cloudTab.computerOfflineHint', { name: label })}
                >
                  {/* The machine row used to be a plain <div>: clicking it
                      did nothing at all, and repeated clicks just selected
                      the text. It is a source like any other now. */}
                  <button
                    className={rowLabel}
                    onClick={() => {
                      setSource({ kind: 'device', id: d.device_id, name: label });
                      setCollapsed((prev) => ({ ...prev, [d.device_id]: false }));
                    }}
                  >
                    <Monitor size={15} className={d.online ? 'text-[#2fbf71]' : 'text-[var(--text-muted)]'} />
                    <span className="flex-1 truncate">{label}</span>
                  </button>
                  <Pill on={d.online}>
                    {t(d.online ? 'cloudTab.online' : 'cloudTab.offline')}
                  </Pill>
                  {d.links.length > 0 && (
                    <button
                      className="shrink-0 -mr-1 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      title={t(open ? 'cloudTab.collapseFolders' : 'cloudTab.expandFolders', { name: label })}
                      aria-expanded={open}
                      onClick={() =>
                        setCollapsed((prev) => ({ ...prev, [d.device_id]: open }))
                      }
                    >
                      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </button>
                  )}
                </div>
                {open && d.links.map((l) => {
                  const active = source.kind === 'link' && source.name === l.name;
                  return (
                    <button
                      key={l.name}
                      className={`${rowBase} ${active ? rowOn : rowOff} pl-7`}
                      onClick={() => setSource({ kind: 'link', name: l.name, device: label })}
                      title={t('cloudTab.linkHint', { device: label })}
                    >
                      <Folder size={14} className="text-[#8b5cf6]" />
                      <span className="flex-1 truncate">{l.name}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {/* Folders whose machine could not be identified — shown rather
              than dropped, so a link never silently disappears. */}
          {orphanLinks.length > 0 && (
            <>
              <div className="mt-3 mb-1 px-2.5 text-[11px] text-[var(--text-muted)]">
                {t('cloudTab.otherLinks')}
              </div>
              {orphanLinks.map((l) => {
                const active = source.kind === 'link' && source.name === l.name;
                return (
                  <button
                    key={l.name}
                    className={`${rowBase} ${active ? rowOn : rowOff}`}
                    onClick={() => setSource({ kind: 'link', name: l.name, device: '' })}
                  >
                    <Folder size={14} className="text-[#8b5cf6]" />
                    <span className="flex-1 truncate">{l.name}</span>
                  </button>
                );
              })}
            </>
          )}

          {/* ── 에이전트 ── each attaches to the cloud, never to a machine. */}
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
              <div
                key={s.session_id}
                className={`${rowShell} ${active ? rowOn : rowOff}`}
              >
                <button
                  className={rowLabel}
                  onClick={() =>
                    setSource({ kind: 'agent', id: s.session_id, name: s.session_name || s.session_id })
                  }
                >
                  <Bot size={15} className={connected ? 'text-[#2fbf71]' : 'text-[var(--text-muted)]'} />
                  <span className="flex-1 truncate">{s.session_name || s.session_id.slice(0, 8)}</span>
                </button>
                {/* Same pill box as the machines' — this one is a control
                    as well as a state, so it is a <button>, but its
                    geometry comes from the same constant. */}
                <button
                  disabled={busy === s.session_id}
                  title={connected ? t('cloudTab.disconnectHint') : t('cloudTab.connectHint')}
                  className={`${PILL_BOX} transition-colors disabled:opacity-60 ${
                    connected ? PILL_ON : PILL_OFF
                  }`}
                  onClick={() => void toggleAgent(s.session_id, !connected)}
                >
                  {connected ? t('cloudTab.connected') : t('cloudTab.connect')}
                </button>
              </div>
            );
          })}

        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0">
            {source.kind === 'history' ? (
              <CloudHistoryView scopeId={CLOUD_SCOPE} />
            ) : (
              <StorageTab
                key={explorerKey}
                scopeId={scopeId}
                initialPath={initialPath}
                embedded
                hint={hint}
                onRefresh={() => void refresh()}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
