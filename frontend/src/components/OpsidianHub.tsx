'use client';

import { useState, useMemo, useRef } from 'react';
import { HubContext, type HubMode } from './OpsidianHubContext';
import UserOpsidianView from './user-opsidian/UserOpsidianView';
import OpsidianView from './opsidian/OpsidianView';
import CuratedKnowledgeView from './curated-knowledge/CuratedKnowledgeView';
import StatusBar from './opsidian/StatusBar';
import './opsidian/opsidian.css';

export default function OpsidianHub() {
  const [mode, setMode] = useState<HubMode>('user');
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
