'use client';

import { useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useOpsidianStore } from '@/store/useOpsidianStore';
import { useHubMode } from '@/components/OpsidianHubContext';
import { agentApi, memoryApi } from '@/lib/api';
import './opsidian.css';
import SessionSelector from './SessionSelector';
import OpsidianSidebar from './OpsidianSidebar';
import OpsidianTabs from './OpsidianTabs';
import NoteViewer from './NoteViewer';
import UnifiedGraphView from '../knowledge-graph/UnifiedGraphView';
import SearchPanel from './SearchPanel';
import RightPanel from './RightPanel';
import ConversationView from './ConversationView';

export default function OpsidianView() {
  const searchParams = useSearchParams();
  const {
    selectedSessionId,
    viewMode,
    sidebarCollapsed,
    rightPanelOpen,
    graphNodes,
    graphEdges,
    setLoading,
    setMemoryIndex,
    setMemoryStats,
    setFiles,
    setGraphData,
    setSessions,
    setLoadingSessions,
    setSelectedSessionId,
    openFile,
    setFileDetail,
    setViewMode,
  } = useOpsidianStore();
  const hub = useHubMode();

  // Load sessions on mount
  useEffect(() => {
    let cancelled = false;
    setLoadingSessions(true);
    agentApi.list().then((sessions) => {
      if (!cancelled) {
        setSessions(sessions);
        setLoadingSessions(false);
        // Auto-select session from URL param
        const urlSessionId = searchParams.get('sessionId');
        if (urlSessionId && !selectedSessionId) {
          const match = sessions.find((s: { session_id: string }) => s.session_id === urlSessionId);
          if (match) {
            setSelectedSessionId(urlSessionId);
          }
        }
      }
    }).catch(() => {
      if (!cancelled) setLoadingSessions(false);
    });
    return () => { cancelled = true; };
  }, [setSessions, setLoadingSessions, searchParams, setSelectedSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load memory data when session changes
  const loadSessionMemory = useCallback(async (sessionId: string) => {
    setLoading(true);
    try {
      const [indexRes, graphRes] = await Promise.all([
        memoryApi.getIndex(sessionId),
        memoryApi.getGraph(sessionId),
      ]);
      setMemoryIndex(indexRes.index);
      setMemoryStats(indexRes.stats);
      setFiles(indexRes.index.files);
      setGraphData(graphRes.nodes, graphRes.edges);
    } catch (err) {
      console.error('Failed to load session memory:', err);
    } finally {
      setLoading(false);
    }
  }, [setLoading, setMemoryIndex, setMemoryStats, setFiles, setGraphData]);

  useEffect(() => {
    if (selectedSessionId) {
      loadSessionMemory(selectedSessionId);
    }
  }, [selectedSessionId, loadSessionMemory]);

  // Register refresh callback for hub StatusBar
  useEffect(() => {
    if (hub) {
      hub.refreshRef.current = () => {
        if (selectedSessionId) loadSessionMemory(selectedSessionId);
      };
    }
  }, [hub, selectedSessionId, loadSessionMemory]);

  // Handle graph node click → open file (same behaviour as old GraphView)
  const handleSelectFile = useCallback(
    async (filename: string) => {
      openFile(filename);
      setViewMode('editor');
      if (selectedSessionId) {
        try {
          const detail = await memoryApi.readFile(selectedSessionId, filename);
          setFileDetail(detail);
        } catch (e) {
          console.error('Failed to read:', e);
        }
      }
    },
    [selectedSessionId, openFile, setFileDetail, setViewMode],
  );

  if (!selectedSessionId) {
    return <SessionSelector />;
  }

  return (
    <div className="opsidian-root">
      {/* Left sidebar: file tree / tags / backlinks */}
      <OpsidianSidebar />

      {/* Main content area */}
      <div
        className="opsidian-main"
        style={{
          marginLeft: sidebarCollapsed ? 40 : 260,
          marginRight: rightPanelOpen ? 280 : 0,
        }}
      >
        <OpsidianTabs />
        <div className="opsidian-content">
          {viewMode === 'editor' && <NoteViewer />}
          {viewMode === 'graph' && (
            <UnifiedGraphView
              nodes={graphNodes}
              edges={graphEdges}
              onSelectFile={handleSelectFile}
            />
          )}
          {viewMode === 'search' && <SearchPanel />}
          {/* Memory v2 PR 5 — Conversation view */}
          {viewMode === 'conversation' && <ConversationView />}
        </div>
      </div>

      {/* Right panel: metadata / backlinks / outline */}
      {rightPanelOpen && <RightPanel />}


    </div>
  );
}
