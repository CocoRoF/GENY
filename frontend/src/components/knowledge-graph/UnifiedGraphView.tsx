'use client';

/**
 * UnifiedGraphView — Knowledge Graph 통합 뷰
 *
 * OpsidianHub의 세 가지 모드(sessions/user/curator) 모두에서
 * 동일한 고품질 그래프를 렌더링한다.
 *
 * - ReactFlow (@xyflow/react) 기반 — Zoom, Pan, Drag, MiniMap 내장
 * - d3-force 레이아웃 — O(n log n) Barnes-Hut 근사
 * - N-hop 하이라이트 — 노드 클릭 시 이웃 밝기 차등
 * - 카테고리 색상 + 중요도 크기 + 엣지 타입 구분
 */

import { useCallback, useMemo, useEffect, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
  MarkerType,
  ConnectionLineType,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { UnifiedGraphViewProps, KnowledgeGraphNode, GraphFilterState, EdgeType } from './graphTypes';
import {
  CATEGORY_COLORS,
  DEFAULT_NODE_COLOR,
  EDGE_STYLES,
  DEFAULT_EDGE_STYLE,
  computeNodeSize,
  HOP_OPACITY,
  HOP_EDGE_OPACITY,
} from './graphConstants';
import { computeForceLayout } from './graphLayout';
import { computeHighlightSet, isEdgeHighlighted } from './graphHighlight';
import GraphControls from './GraphControls';
import { GitGraph } from 'lucide-react';

// ── 커스텀 노드 레이블 (원 아래 텍스트) ─────────────────
function NodeLabel({ label, size }: { label: string; size: number }) {
  const maxLen = size > 24 ? 30 : 18;
  const display = label.length > maxLen ? label.slice(0, maxLen) + '…' : label;
  return (
    <div
      style={{
        position: 'absolute',
        top: size + 4,
        left: '50%',
        transform: 'translateX(-50%)',
        fontSize: 10,
        fontWeight: 500,
        color: 'var(--obs-text-dim)',
        whiteSpace: 'nowrap',
        textAlign: 'center',
        pointerEvents: 'none',
        textShadow: '0 0 4px var(--obs-bg-deep), 0 0 8px var(--obs-bg-deep)',
        maxWidth: 120,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {display}
    </div>
  );
}

// ── 호버 노드 상세 툴팁 ─────────────────────────────────
function GraphTooltip({ node }: { node: KnowledgeGraphNode | null }) {
  if (!node) return null;
  const color = CATEGORY_COLORS[node.category] ?? DEFAULT_NODE_COLOR;
  return (
    <div
      style={{
        background: 'var(--obs-bg-panel)',
        border: '1px solid var(--obs-border-subtle)',
        borderRadius: 8,
        padding: '10px 14px',
        maxWidth: 260,
        minWidth: 180,
        backdropFilter: 'blur(8px)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      }}
    >
      <div className="obs-graph-tooltip-title">{node.label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 4px ${color}`,
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--obs-text-muted)', textTransform: 'capitalize' }}>
          {node.category}
        </span>
        <span style={{ fontSize: 11, color: 'var(--obs-text-muted)', marginLeft: 'auto' }}>
          {node.importance}
        </span>
      </div>
      {node.tags && node.tags.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--obs-text-muted)', marginTop: 2 }}>
          {node.tags.map((t) => `#${t}`).join(' ')}
        </div>
      )}
      {node.summary && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--obs-text-dim)',
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid var(--obs-border-subtle)',
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {node.summary}
        </div>
      )}
      {node.connectionCount != null && (
        <div style={{ fontSize: 10, color: 'var(--obs-text-muted)', marginTop: 4 }}>
          연결: {node.connectionCount}개
        </div>
      )}
    </div>
  );
}

// ── 메인 그래프 내부 컴포넌트 (ReactFlowProvider 내부) ───
function GraphInner({ nodes: rawNodes, edges: rawEdges, onSelectFile }: UnifiedGraphViewProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<KnowledgeGraphNode | null>(null);
  const highlightDepth = 2;

  // 사용 가능한 카테고리 목록
  const availableCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const n of rawNodes) cats.add(n.category);
    return Array.from(cats).sort();
  }, [rawNodes]);

  // 필터 상태 — 초기값: 모두 활성 (카테고리는 데이터에서 파생)
  const [filter, setFilter] = useState<GraphFilterState>(() => ({
    categories: new Set<string>(),
    importance: new Set(['critical', 'high', 'medium', 'low']),
    searchQuery: '',
    showOrphans: true,
    edgeTypes: new Set<EdgeType>(['wikilink', 'tag', 'backlink']),
    selectedNodeId: null,
    highlightDepth: 2,
  }));

  // 필터링된 노드/엣지
  const { filteredNodes, filteredEdges } = useMemo(() => {
    const searchLower = filter.searchQuery.toLowerCase();

    // 노드 필터링
    let fNodes = rawNodes.filter((n) => {
      // 필터에 카테고리가 하나도 없으면 → 모두 표시 (초기 상태)
      if (filter.categories.size > 0 && !filter.categories.has(n.category)) return false;
      if (!filter.importance.has(n.importance)) return false;
      if (searchLower && !n.label.toLowerCase().includes(searchLower)) return false;
      return true;
    });

    const nodeIdSet = new Set(fNodes.map((n) => n.id));

    // 엣지 필터링
    const fEdges = rawEdges.filter((e) => {
      if (!nodeIdSet.has(e.source) || !nodeIdSet.has(e.target)) return false;
      const et = e.type ?? 'wikilink';
      if (!filter.edgeTypes.has(et)) return false;
      return true;
    });

    // 고아 노드 필터
    if (!filter.showOrphans) {
      const connectedIds = new Set<string>();
      for (const e of fEdges) {
        connectedIds.add(e.source);
        connectedIds.add(e.target);
      }
      fNodes = fNodes.filter((n) => connectedIds.has(n.id));
    }

    return { filteredNodes: fNodes, filteredEdges: fEdges };
  }, [rawNodes, rawEdges, filter]);

  // d3-force 레이아웃 계산 (필터링된 데이터 기반)
  const { positions } = useMemo(
    () => computeForceLayout(filteredNodes, filteredEdges),
    [filteredNodes, filteredEdges],
  );

  // N-hop 하이라이트 셋
  const highlightSet = useMemo(
    () => (selectedNodeId ? computeHighlightSet(selectedNodeId, filteredEdges, highlightDepth) : null),
    [selectedNodeId, filteredEdges, highlightDepth],
  );

  // 연결 수 맵 (백엔드에서 보내지 않을 때 대비)
  const connectionCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of filteredNodes) map.set(n.id, n.connectionCount ?? 0);
    for (const e of filteredEdges) {
      map.set(e.source, (map.get(e.source) ?? 0) + 1);
      map.set(e.target, (map.get(e.target) ?? 0) + 1);
    }
    return map;
  }, [filteredNodes, filteredEdges]);

  // ReactFlow 노드 변환
  const initialNodes: Node[] = useMemo(() => {
    return filteredNodes.map((gn) => {
      const pos = positions[gn.id] ?? { x: 0, y: 0 };
      const connCount = connectionCountMap.get(gn.id) ?? 0;
      const size = computeNodeSize(gn.importance, connCount);
      const color = CATEGORY_COLORS[gn.category] ?? DEFAULT_NODE_COLOR;

      // 하이라이트 투명도
      let opacity = 1.0;
      if (highlightSet) {
        const hop = highlightSet.get(gn.id);
        if (hop === 0) opacity = HOP_OPACITY.selected;
        else if (hop === 1) opacity = HOP_OPACITY.hop1;
        else if (hop === 2) opacity = HOP_OPACITY.hop2;
        else opacity = HOP_OPACITY.dimmed;
      }

      const isSelected = gn.id === selectedNodeId;

      return {
        id: gn.id,
        position: { x: pos.x - size / 2, y: pos.y - size / 2 },
        data: {
          label: (
            <div style={{ position: 'relative', width: size, height: size }}>
              <div
                style={{
                  width: size,
                  height: size,
                  borderRadius: '50%',
                  background: color,
                  boxShadow: isSelected
                    ? `0 0 0 3px #fff, 0 0 ${size}px ${color}80`
                    : `0 0 ${size / 3}px ${color}40`,
                  transition: 'box-shadow 200ms ease, opacity 200ms ease',
                }}
              />
              <NodeLabel label={gn.label} size={size} />
            </div>
          ),
        },
        style: {
          background: 'transparent',
          border: 'none',
          width: size,
          height: size,
          padding: 0,
          opacity,
          cursor: 'pointer',
          transition: 'opacity 200ms ease',
        },
        type: 'default',
      };
    });
  }, [filteredNodes, positions, connectionCountMap, highlightSet, selectedNodeId]);

  // ReactFlow 엣지 변환
  const initialEdges: Edge[] = useMemo(() => {
    return filteredEdges.map((ge, i) => {
      const edgeType = ge.type ?? 'wikilink';
      const style = EDGE_STYLES[edgeType] ?? DEFAULT_EDGE_STYLE;

      let opacity = 0.6;
      let width = style.width;
      if (highlightSet) {
        if (isEdgeHighlighted(ge.source, ge.target, highlightSet)) {
          const srcHop = highlightSet.get(ge.source) ?? 999;
          const tgtHop = highlightSet.get(ge.target) ?? 999;
          const maxHop = Math.max(srcHop, tgtHop);
          opacity = maxHop <= 1 ? HOP_EDGE_OPACITY.active : HOP_EDGE_OPACITY.secondary;
          width = maxHop <= 1 ? style.width * 2 : style.width * 1.2;
        } else {
          opacity = HOP_EDGE_OPACITY.dimmed;
        }
      }

      return {
        id: `ke-${i}`,
        source: ge.source,
        target: ge.target,
        animated: false,
        style: {
          stroke: style.color,
          strokeWidth: width,
          opacity,
          strokeDasharray: style.dash,
          transition: 'opacity 200ms ease, stroke-width 200ms ease',
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 10,
          height: 10,
          color: style.color,
        },
        type: 'default',
      };
    });
  }, [filteredEdges, highlightSet]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // 노드 클릭 → N-hop 하이라이트 토글 + 파일 열기
  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
      onSelectFile(node.id);
    },
    [onSelectFile],
  );

  // 호버 처리
  const nodeMap = useMemo(() => {
    const map = new Map<string, KnowledgeGraphNode>();
    for (const n of rawNodes) map.set(n.id, n);  // rawNodes 전체로 맵 유지 (호버 시 필터밖 정보도 필요)
    return map;
  }, [rawNodes]);

  const onNodeMouseEnter: NodeMouseHandler = useCallback(
    (_, node) => {
      const gn = nodeMap.get(node.id) ?? null;
      setHoveredNode(gn);
    },
    [nodeMap],
  );

  const onNodeMouseLeave = useCallback(() => {
    setHoveredNode(null);
  }, []);

  // 배경 클릭 → 하이라이트 해제
  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // 빈 상태
  if (rawNodes.length === 0) {
    return (
      <div className="obs-graph-empty">
        <GitGraph size={40} strokeWidth={1.2} style={{ opacity: 0.5 }} />
        <p>No knowledge graph data available.</p>
        <p style={{ fontSize: 12, color: 'var(--obs-text-muted)' }}>
          Memory notes with [[wikilinks]] will appear as connected nodes.
        </p>
      </div>
    );
  }

  return (
    <div className="obs-graph" style={{ position: 'relative' }}>
      {/* 범례 */}
      <div className="obs-graph-legend">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="obs-graph-legend-item">
            <span className="obs-graph-legend-dot" style={{ background: color }} />
            {cat}
          </span>
        ))}
      </div>

      {/* 필터 컨트롤 */}
      <GraphControls
        filter={filter}
        onFilterChange={setFilter}
        availableCategories={availableCategories}
      />

      {/* 호버 툴팁 — 필터 컨트롤이 우측에 있으므로 좌측 하단에 배치 */}
      {hoveredNode && (
        <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10 }}>
          <GraphTooltip node={hoveredNode} />
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={onPaneClick}
        connectionLineType={ConnectionLineType.SmoothStep}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.1}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--obs-border-subtle)" gap={20} size={1} />
        <Controls
          showInteractive={false}
          style={{
            background: 'var(--obs-bg-surface)',
            border: '1px solid var(--obs-border-subtle)',
            borderRadius: 8,
          }}
        />
        <MiniMap
          nodeColor={(n) => {
            // 노드 data.label은 JSX이므로 직접 category를 찾아야 함
            const gn = nodeMap.get(n.id);
            return CATEGORY_COLORS[gn?.category ?? ''] ?? DEFAULT_NODE_COLOR;
          }}
          maskColor="rgba(0,0,0,0.4)"
          style={{
            background: 'var(--obs-bg-panel)',
            border: '1px solid var(--obs-border-subtle)',
            borderRadius: 8,
          }}
        />
      </ReactFlow>
    </div>
  );
}

// ── 외부 export (ReactFlowProvider 래핑) ─────────────────
export default function UnifiedGraphView(props: UnifiedGraphViewProps) {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  );
}
