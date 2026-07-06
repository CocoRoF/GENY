'use client';

/**
 * UnifiedGraphView — Knowledge Graph 통합 뷰 (graphier 기반)
 *
 * OpsidianHub의 세 가지 모드(sessions/user/curator) 모두에서
 * 동일한 고품질 그래프를 렌더링한다.
 *
 * - @cocorof/graphier — WebGL InstancedMesh 렌더링 (노드 수천 개 = 드로우콜 2회)
 * - Web Worker 3D 포스 레이아웃 — 메인 스레드 블로킹 없음
 * - 리히트 없는 필터 — visibleNodeIds/linkVisibility로 노드/엣지 토글 시
 *   시뮬레이션을 다시 돌리지 않고 위치가 그대로 유지된다
 * - N-hop 하이라이트(클릭, 2-hop) + 호버 이웃 하이라이트(1-hop)
 * - 카테고리 클러스터 force + 클릭 가능한 범례 + 미니맵
 * - 내비게이션: 좌드래그 팬 / 우드래그 3D 틸트 / 휠 줌 / 화살표·WASD 팬 /
 *   z·x 줌 (enableNodeDrag=false — 밀집 그래프에서 팬 우선)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NetworkGraph3D,
  GraphMinimap,
  type NetworkGraph3DRef,
  type GraphData,
  type GraphLink,
  type ThemeConfig,
  type StyleConfig,
  type LayoutConfig,
  type RendererConfig,
} from '@cocorof/graphier';
import { GitGraph, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

import type {
  UnifiedGraphViewProps,
  KnowledgeGraphNode,
  GraphFilterState,
  EdgeType,
} from './graphTypes';
import {
  CATEGORY_COLORS,
  DEFAULT_NODE_COLOR,
  computeNodeSize,
} from './graphConstants';
import GraphControls from './GraphControls';

const ALL_EDGE_TYPES: EdgeType[] = ['wikilink', 'tag', 'backlink', 'semantic'];
const ALL_IMPORTANCE = ['critical', 'high', 'medium', 'low'];

// ── graphier 테마 (opsidian.css의 --obs-* 팔레트와 정합) ──
const GRAPH_THEME_DARK: ThemeConfig = {
  nodeColors: CATEGORY_COLORS,
  linkColors: {
    wikilink: '#58a6ff',
    backlink: '#8b949e',
    tag: '#d29922',
    semantic: '#a371f7',
  },
  defaultNodeColor: DEFAULT_NODE_COLOR,
  defaultLinkColor: '#58a6ff',
  backgroundColor: '#0c0c0f', // --obs-bg-deep (dark)
};

const GRAPH_THEME_LIGHT: ThemeConfig = {
  nodeColors: CATEGORY_COLORS,
  linkColors: {
    wikilink: '#2563eb',
    backlink: '#94a3b8',
    tag: '#b45309',
    semantic: '#7c3aed',
  },
  defaultNodeColor: DEFAULT_NODE_COLOR,
  defaultLinkColor: '#2563eb',
  backgroundColor: '#f8fafc', // --obs-bg-deep (light)
  blending: 'normal',
};

const GRAPH_LAYOUT: LayoutConfig = {
  dimensions: 3,
  clusterBy: 'type',
  clusterStrength: 0.04,
};

// 좌드래그=팬, 우드래그=회전, 키보드=팬 스킴 (화살표/WASD 팬, z/x 줌)
const GRAPH_RENDERER: RendererConfig = {
  navigation: { leftButton: 'pan', rightButton: 'rotate', keyboard: 'pan' },
};

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

// ── 줌 컨트롤 버튼 스택 ─────────────────────────────────
function ZoomButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 28,
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--obs-border-subtle)',
        color: 'var(--obs-text-dim)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

export default function UnifiedGraphView({
  nodes: rawNodes,
  edges: rawEdges,
  onSelectFile,
}: UnifiedGraphViewProps) {
  const graphRef = useRef<NetworkGraph3DRef | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<KnowledgeGraphNode | null>(null);

  // 라이트/다크 테마 감지 (html.light 클래스 — 전환 시 그래프 리마운트)
  const [isLight, setIsLight] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setIsLight(el.classList.contains('light'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // 사용 가능한 카테고리 목록
  const availableCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const n of rawNodes) cats.add(n.category);
    return Array.from(cats).sort();
  }, [rawNodes]);

  // 필터 상태 — 초기값: 모두 활성 (카테고리는 데이터에서 파생)
  const [filter, setFilter] = useState<GraphFilterState>(() => ({
    categories: new Set<string>(),
    importance: new Set(ALL_IMPORTANCE),
    searchQuery: '',
    showOrphans: true,
    edgeTypes: new Set<EdgeType>(ALL_EDGE_TYPES),
    selectedNodeId: null,
    highlightDepth: 2,
  }));

  // 노드 원본 맵 (호버 툴팁용)
  const nodeMap = useMemo(() => {
    const map = new Map<string, KnowledgeGraphNode>();
    for (const n of rawNodes) map.set(n.id, n);
    return map;
  }, [rawNodes]);

  // graphier 데이터 — 전체 데이터를 한 번만 넘기고(레이아웃 1회),
  // 이후 필터는 visibleNodeIds/linkVisibility로만 처리한다.
  const graphData: GraphData = useMemo(() => {
    const connCount = new Map<string, number>();
    for (const e of rawEdges) {
      connCount.set(e.source, (connCount.get(e.source) ?? 0) + 1);
      connCount.set(e.target, (connCount.get(e.target) ?? 0) + 1);
    }
    return {
      nodes: rawNodes.map((n) => ({
        id: n.id,
        label: n.label,
        type: n.category,
        val: computeNodeSize(n.importance, n.connectionCount ?? connCount.get(n.id) ?? 0),
      })),
      links: rawEdges.map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type ?? 'wikilink',
      })),
    };
  }, [rawNodes, rawEdges]);

  // 노드 필터 → visibleNodeIds (null = 전체 표시, 리히트 없음)
  const visibleNodeIds = useMemo<Set<string> | null>(() => {
    const noCategoryFilter = filter.categories.size === 0;
    const allImportance = ALL_IMPORTANCE.every((i) => filter.importance.has(i));
    const query = filter.searchQuery.trim().toLowerCase();
    if (noCategoryFilter && allImportance && !query && filter.showOrphans) return null;

    const visible = new Set<string>();
    for (const n of rawNodes) {
      if (!noCategoryFilter && !filter.categories.has(n.category)) continue;
      if (!filter.importance.has(n.importance)) continue;
      if (query && !n.label.toLowerCase().includes(query)) continue;
      visible.add(n.id);
    }

    if (!filter.showOrphans) {
      const connected = new Set<string>();
      for (const e of rawEdges) {
        const et = e.type ?? 'wikilink';
        if (!filter.edgeTypes.has(et)) continue;
        if (visible.has(e.source) && visible.has(e.target)) {
          connected.add(e.source);
          connected.add(e.target);
        }
      }
      for (const id of visible) if (!connected.has(id)) visible.delete(id);
    }
    return visible;
  }, [rawNodes, rawEdges, filter]);

  // 엣지 타입 필터 → linkVisibility (null = 전체 표시)
  const linkVisibility = useMemo<((link: GraphLink) => boolean) | null>(() => {
    if (ALL_EDGE_TYPES.every((t) => filter.edgeTypes.has(t))) return null;
    const active = filter.edgeTypes;
    return (link) => active.has((link.type ?? 'wikilink') as EdgeType);
  }, [filter.edgeTypes]);

  // 필터로 선택 노드가 숨겨지면 선택도 숨김 (필터 복귀 시 선택 유지)
  const effectiveSelectedId =
    selectedNodeId && (!visibleNodeIds || visibleNodeIds.has(selectedNodeId))
      ? selectedNodeId
      : null;

  // 노드 클릭 → 하이라이트 토글 + 파일 열기 / 배경 클릭 → 해제
  const handleNodeClick = useCallback(
    (node: { id: string } | null) => {
      if (!node) {
        setSelectedNodeId(null);
        return;
      }
      setSelectedNodeId((prev) => (prev === node.id ? null : node.id));
      onSelectFile(node.id);
    },
    [onSelectFile],
  );

  const handleNodeHover = useCallback(
    (node: { id: string } | null) => {
      setHoveredNode(node ? (nodeMap.get(node.id) ?? null) : null);
    },
    [nodeMap],
  );

  // 범례 칩 클릭 → 카테고리 필터 토글 (GraphControls와 동일한 상태 공유)
  const toggleLegendCategory = useCallback((cat: string) => {
    setFilter((f) => {
      const next = new Set(f.categories);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return { ...f, categories: next };
    });
  }, []);

  const graphStyle = useMemo<StyleConfig>(
    () => ({
      starField: false,
      fogDensity: 0,
      bloomStrength: isLight ? 0 : 0.45,
      bloomRadius: 0.15,
      bloomThreshold: 0.1,
      nodeMinSize: 3.5,
      nodeMaxSize: 13,
      edgeOpacity: isLight ? 0.55 : 0.3,
      showLabels: true,
      maxLabels: 90,
      labelScale: 1.1,
      labelThreshold: 0.85,
    }),
    [isLight],
  );

  const labelFormatter = useCallback((node: { label?: string; id: string }) => {
    const label = node.label ?? node.id;
    return label.length > 24 ? label.slice(0, 23) + '…' : label;
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
      {/* 범례 (클릭으로 카테고리 필터 토글) */}
      <div className="obs-graph-legend">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => {
          const filtered = filter.categories.size > 0 && !filter.categories.has(cat);
          return (
            <button
              key={cat}
              className="obs-graph-legend-item"
              onClick={() => toggleLegendCategory(cat)}
              title={`${cat} 카테고리만 보기 (토글)`}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                font: 'inherit',
                color: 'inherit',
                cursor: 'pointer',
                opacity: filtered ? 0.35 : 1,
                transition: 'opacity 150ms ease',
              }}
            >
              <span className="obs-graph-legend-dot" style={{ background: color }} />
              {cat}
            </button>
          );
        })}
      </div>

      {/* 필터 컨트롤 */}
      <GraphControls
        filter={filter}
        onFilterChange={setFilter}
        availableCategories={availableCategories}
      />

      {/* 줌 컨트롤 */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          left: 12,
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--obs-bg-surface)',
          border: '1px solid var(--obs-border-subtle)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <ZoomButton title="확대" onClick={() => graphRef.current?.zoomIn()}>
          <ZoomIn size={14} />
        </ZoomButton>
        <ZoomButton title="축소" onClick={() => graphRef.current?.zoomOut()}>
          <ZoomOut size={14} />
        </ZoomButton>
        <ZoomButton title="전체 보기" onClick={() => graphRef.current?.zoomToFit(600, 150)}>
          <Maximize2 size={14} />
        </ZoomButton>
      </div>

      {/* 미니맵 */}
      <div
        style={{
          position: 'absolute',
          bottom: 12,
          right: 12,
          zIndex: 10,
          background: 'var(--obs-bg-panel)',
          border: '1px solid var(--obs-border-subtle)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <GraphMinimap
          graphRef={graphRef}
          width={180}
          height={120}
          viewportColor={isLight ? '#64748b' : '#94a3b8'}
        />
      </div>

      {/* 호버 툴팁 — 줌 컨트롤 위 좌측 하단 */}
      {hoveredNode && (
        <div style={{ position: 'absolute', bottom: 116, left: 12, zIndex: 10 }}>
          <GraphTooltip node={hoveredNode} />
        </div>
      )}

      <NetworkGraph3D
        key={isLight ? 'light' : 'dark'}
        ref={graphRef}
        data={graphData}
        layout={GRAPH_LAYOUT}
        renderer={GRAPH_RENDERER}
        theme={isLight ? GRAPH_THEME_LIGHT : GRAPH_THEME_DARK}
        style={graphStyle}
        visibleNodeIds={visibleNodeIds}
        linkVisibility={linkVisibility}
        selectedNodeId={effectiveSelectedId}
        highlightHops={2}
        clickToFocus={false}
        enableNodeDrag={false}
        hoverHighlight
        hoverHighlightHops={1}
        labelFormatter={labelFormatter}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        onLayoutSettled={() => graphRef.current?.zoomToFit(600, 150)}
      />
    </div>
  );
}
