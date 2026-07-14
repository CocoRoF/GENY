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
import { GitGraph, ZoomIn, ZoomOut, Maximize2, Minimize2, Frame, Pin, X, ArrowUpRight, Share2 } from 'lucide-react';

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

// ── graphier "Memory Cosmos" 테마 ──
// 지식 그래프를 심우주 뷰포트로 확정한다(앱 라이트/다크와 무관). 노드=행성,
// 링크=중력 필라멘트(additive), 배경=성운+별필드. 깊은 보이드 위에서만 우주가
// 제대로 읽히므로 그래프는 항상 이 코스모스 테마를 쓴다.
const GRAPH_THEME_COSMIC: ThemeConfig = {
  nodeColors: CATEGORY_COLORS,
  linkColors: {
    wikilink: '#6cb2ff',
    backlink: '#9aa6d8',
    tag: '#e3b34a',
    semantic: '#b98cff',
  },
  defaultNodeColor: DEFAULT_NODE_COLOR,
  defaultLinkColor: '#6cb2ff',
  backgroundColor: '#05060f', // deep space void
  blending: 'additive',
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
// 메모리 노트 본문에서 meta 주석(<!--meta ...-->) / frontmatter를 걷어낸 깨끗한 텍스트.
function cleanSummary(s?: string): string {
  if (!s) return '';
  return s
    .replace(/<!--[\s\S]*?-->/g, '') // HTML/meta 주석
    .replace(/^---[\s\S]*?\n---\s*/m, '') // YAML frontmatter
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 중요도 → 세맨틱 색 (카테고리 accent와 별개 축)
const IMPORTANCE_COLOR: Record<string, string> = {
  critical: '#ff6b6b',
  high: '#f5a623',
  medium: '#58a6ff',
  low: '#8b95b0',
};

// 노드 정보 패널 — 우측 상단(검색 아래) 고정 위치. 호버=미리보기, 클릭=고정.
// 고정 상태에서만 [문서로 이동] 버튼이 노출된다.
function NodeInfoPanel({
  node,
  pinned,
  onNavigate,
  onClose,
}: {
  node: KnowledgeGraphNode;
  pinned: boolean;
  onNavigate: () => void;
  onClose: () => void;
}) {
  const color = CATEGORY_COLORS[node.category] ?? DEFAULT_NODE_COLOR;
  const impColor = IMPORTANCE_COLOR[(node.importance ?? '').toLowerCase()] ?? '#8b95b0';
  const summary = cleanSummary(node.summary);
  const hasTags = !!node.tags && node.tags.length > 0;

  return (
    <div
      style={{
        background: 'var(--obs-bg-panel)',
        border: '1px solid var(--obs-border-subtle)',
        borderRadius: 12,
        backdropFilter: 'blur(16px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.2)',
        boxShadow: pinned
          ? '0 16px 44px rgba(0,0,0,0.55)'
          : '0 10px 30px rgba(0,0,0,0.45)',
        overflow: 'hidden',
      }}
    >
      {/* 카테고리 액센트 바 */}
      <div style={{ height: 3, background: `linear-gradient(90deg, ${color}, ${color}22)` }} />

      {/* 고정 헤더 */}
      {pinned && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px 0' }}>
          <Pin size={11} style={{ color, transform: 'rotate(18deg)' }} />
          <span
            style={{
              fontSize: 9.5,
              letterSpacing: 1,
              fontWeight: 700,
              textTransform: 'uppercase',
              color: 'var(--obs-text-muted)',
            }}
          >
            고정됨
          </span>
          <button
            onClick={onClose}
            title="고정 해제"
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--obs-text-muted)',
              padding: 3,
              display: 'flex',
              borderRadius: 6,
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* 본문 */}
      <div style={{ padding: pinned ? '6px 15px 13px' : '13px 15px' }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 650,
            color: 'var(--obs-text)',
            lineHeight: 1.3,
            marginBottom: 9,
            wordBreak: 'break-word',
          }}
        >
          {node.label}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: hasTags || summary || node.connectionCount != null ? 11 : 0,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--obs-text-dim)' }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, boxShadow: `0 0 7px ${color}` }} />
            <span style={{ textTransform: 'capitalize' }}>{node.category}</span>
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              padding: '2.5px 9px',
              borderRadius: 999,
              background: `${impColor}22`,
              color: impColor,
              border: `1px solid ${impColor}33`,
            }}
          >
            {node.importance}
          </span>
        </div>

        {hasTags && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: summary ? 11 : 0 }}>
            {node.tags!.map((t) => (
              <span
                key={t}
                style={{
                  fontSize: 10,
                  color: 'var(--obs-text-muted)',
                  background: 'var(--obs-bg-surface)',
                  border: '1px solid var(--obs-border-subtle)',
                  borderRadius: 6,
                  padding: '1.5px 7px',
                }}
              >
                #{t}
              </span>
            ))}
          </div>
        )}

        {summary && (
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--obs-text-dim)',
              lineHeight: 1.55,
              display: '-webkit-box',
              WebkitLineClamp: 4,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              paddingTop: 9,
              borderTop: '1px solid var(--obs-border-subtle)',
            }}
          >
            {summary}
          </div>
        )}

        {node.connectionCount != null && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              marginTop: 11,
              fontSize: 11,
              color: 'var(--obs-text-muted)',
            }}
          >
            <Share2 size={11} style={{ opacity: 0.7 }} />
            연결{' '}
            <b style={{ color: 'var(--obs-text-dim)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {node.connectionCount}
            </b>
            개
          </div>
        )}
      </div>

      {pinned && (
        <button
          onClick={onNavigate}
          style={{
            width: '100%',
            padding: '10px 12px',
            border: 'none',
            borderTop: '1px solid var(--obs-border-subtle)',
            background: `${color}1c`,
            color,
            cursor: 'pointer',
            fontSize: 12.5,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            letterSpacing: 0.2,
          }}
        >
          <ArrowUpRight size={15} /> 문서로 이동
        </button>
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Real browser fullscreen on the graph viewport. graphier's ResizeObserver
  // re-fits the canvas when the container resizes.
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.();
  }, []);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<KnowledgeGraphNode | null>(null);
  const [pinnedNode, setPinnedNode] = useState<KnowledgeGraphNode | null>(null);

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
    // Real degree from the actual edges — the backend's connectionCount is
    // often 0/absent, which made the info panel always read "연결: 0개".
    const degree = new Map<string, number>();
    for (const e of rawEdges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const map = new Map<string, KnowledgeGraphNode>();
    for (const n of rawNodes) {
      map.set(n.id, { ...n, connectionCount: degree.get(n.id) ?? n.connectionCount ?? 0 });
    }
    return map;
  }, [rawNodes, rawEdges]);

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
        val: computeNodeSize(n.importance, connCount.get(n.id) ?? n.connectionCount ?? 0),
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

  // 노드 클릭 → 문서 이동이 아니라 "해당 노드로 카메라 초점 + 정보 고정".
  // 실제 문서 이동은 고정 패널의 [문서로 이동] 버튼이 담당한다.
  // 같은 노드를 다시 클릭하거나 배경을 클릭하면 고정 해제.
  const handleNodeClick = useCallback(
    (node: { id: string } | null) => {
      if (!node || selectedNodeId === node.id) {
        setSelectedNodeId(null);
        setPinnedNode(null);
        return;
      }
      setSelectedNodeId(node.id);
      setPinnedNode(nodeMap.get(node.id) ?? null);
      graphRef.current?.focusNode?.(node.id, 700);
    },
    [nodeMap, selectedNodeId],
  );

  // 고정 패널의 [문서로 이동] → 실제 파일 열기
  const handleNavigate = useCallback(() => {
    if (pinnedNode) onSelectFile(pinnedNode.id);
  }, [pinnedNode, onSelectFile]);

  const handleUnpin = useCallback(() => {
    setPinnedNode(null);
    setSelectedNodeId(null);
  }, []);

  // 표시할 노드: 고정이 있으면 고정 우선, 없으면 호버
  const infoNode = pinnedNode ?? hoveredNode;

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

  // Cosmos style — deep-space backdrop + planetary bloom. Constant (the graph
  // is a committed cosmic viewport regardless of the app's light/dark chrome).
  const graphStyle = useMemo<StyleConfig>(
    () => ({
      starField: true,
      nebula: true,
      fogDensity: 0,
      bloomStrength: 0.95,
      bloomRadius: 0.42,
      bloomThreshold: 0.02,
      nodeMinSize: 3.5,
      nodeMaxSize: 13,
      edgeOpacity: 0.34,
      showLabels: true,
      maxLabels: 90,
      labelScale: 1.1,
      labelThreshold: 0.85,
    }),
    [],
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
    <div ref={containerRef} className="obs-graph" style={{ position: 'relative' }}>
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
        <ZoomButton title="전체 보기 (초기화)" onClick={() => graphRef.current?.zoomToFit(600, 150)}>
          <Frame size={14} />
        </ZoomButton>
        <ZoomButton title={isFullscreen ? '전체화면 종료' : '전체화면'} onClick={toggleFullscreen}>
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
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

      {/* 노드 정보 패널 — 우측 상단(검색 아래). 호버=미리보기, 클릭=고정. */}
      {infoNode && (
        <div style={{ position: 'absolute', top: 58, right: 12, zIndex: 10, width: 260 }}>
          <NodeInfoPanel
            node={infoNode}
            pinned={!!pinnedNode}
            onNavigate={handleNavigate}
            onClose={handleUnpin}
          />
        </div>
      )}

      <NetworkGraph3D
        key="cosmic"
        ref={graphRef}
        data={graphData}
        layout={GRAPH_LAYOUT}
        renderer={GRAPH_RENDERER}
        theme={GRAPH_THEME_COSMIC}
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
        onLayoutSettled={() => {
          // Frame the graph once it settles — but never if the user already
          // moved the camera during the layout (keep their viewpoint).
          if (!graphRef.current?.hasUserAdjustedCamera?.()) {
            graphRef.current?.zoomToFit(600, 150);
          }
        }}
      />
    </div>
  );
}
