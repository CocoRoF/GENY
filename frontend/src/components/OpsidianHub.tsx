'use client';

import { useState, useMemo, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { HubContext, type HubMode } from './OpsidianHubContext';
import UserOpsidianView from './user-opsidian/UserOpsidianView';
import OpsidianView from './opsidian/OpsidianView';
import CuratedKnowledgeView from './curated-knowledge/CuratedKnowledgeView';
import StatusBar from './opsidian/StatusBar';
import './opsidian/opsidian.css';

const VALID_MODES: ReadonlyArray<HubMode> = ['user', 'sessions', 'curator'];

function isValidMode(value: string | null): value is HubMode {
  return value !== null && (VALID_MODES as ReadonlyArray<string>).includes(value);
}

export default function OpsidianHub() {
  // Initial mode resolution (cycle 20260503_4):
  //
  //   1. ``?mode=<user|sessions|curator>`` — explicit override,
  //      so external links (Geny tab strip, deep-links from
  //      docs / chat) can land users on whatever scope they
  //      actually want.
  //   2. ``?sessionId=<id>`` present (without ``mode``) — the
  //      caller plainly wants the per-session vault, so default
  //      to ``sessions`` instead of ``user``. This is what makes
  //      the in-Geny ``메모리`` tab shortcut land on the right
  //      bottom-bar tab without an extra click.
  //   3. Otherwise — keep the historical default of ``user``.
  //
  // ``useSearchParams`` is read once for the initial state; we
  // do not subscribe to changes because the bottom-bar buttons
  // already drive ``setMode`` for in-app navigation. A follow-up
  // could sync mode↔URL, but that's deferred — scope is just
  // "open with the right tab pre-selected".
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<HubMode>(() => {
    const explicit = searchParams.get('mode');
    if (isValidMode(explicit)) return explicit;
    if (searchParams.get('sessionId')) return 'sessions';
    return 'user';
  });
  const refreshRef = useRef<() => void>(() => {});

  const ctx = useMemo(() => ({ mode, setMode, refreshRef }), [mode]);

  const renderView = () => {
    switch (mode) {
      case 'user':
        return <UserOpsidianView />;
      case 'curator':
        return <CuratedKnowledgeView />;
      case 'sessions':
      default:
        return <OpsidianView />;
    }
  };

  return (
    <HubContext.Provider value={ctx}>
      <div className="opsidian-hub">
        <div className="opsidian-hub-content">
          {renderView()}
        </div>
        <StatusBar onRefresh={() => refreshRef.current()} />
      </div>
    </HubContext.Provider>
  );
}
