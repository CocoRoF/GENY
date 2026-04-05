/**
 * Knowledge Graph 레이아웃 엔진
 *
 * d3-force 기반 Barnes-Hut O(n log n) 시뮬레이션.
 * 기존 커스텀 O(n²) 120-iteration 루프를 대체한다.
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { KnowledgeGraphNode, KnowledgeGraphEdge, SimNode, SimLink } from './graphTypes';
import { IMPORTANCE_BASE_SIZE, DEFAULT_NODE_SIZE } from './graphConstants';

// ── 노드 수별 시뮬레이션 파라미터 ────────────────────────
function getSimParams(nodeCount: number) {
  if (nodeCount <= 100) {
    return { ticks: 300, chargeStrength: -150, alphaDecay: 0.02 };
  }
  if (nodeCount <= 500) {
    return { ticks: 200, chargeStrength: -120, alphaDecay: 0.025 };
  }
  return { ticks: 150, chargeStrength: -80, alphaDecay: 0.03 };
}

// ── 메인 레이아웃 함수 ───────────────────────────────────
export function computeForceLayout(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
): { positions: Record<string, { x: number; y: number }>; } {
  if (nodes.length === 0) return { positions: {} };

  const params = getSimParams(nodes.length);

  // SimNode 생성 — 초기 위치는 원형 배치
  const simNodes: SimNode[] = nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const radius = Math.min(400, 60 * Math.sqrt(nodes.length));
    return {
      id: n.id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      category: n.category,
      importance: n.importance,
      connectionCount: n.connectionCount ?? 0,
    };
  });

  // 노드 ID를 빠르게 찾기 위한 Set
  const nodeIdSet = new Set(simNodes.map((n) => n.id));

  // SimLink 생성 — 존재하지 않는 노드를 참조하는 엣지 제거
  const simLinks: SimLink[] = edges
    .filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type ?? 'wikilink',
      weight: e.weight ?? 1.0,
    }));

  // d3-force 시뮬레이션 구성
  const sim: Simulation<SimulationNodeDatum, SimulationLinkDatum<SimulationNodeDatum>> =
    forceSimulation(simNodes as unknown as SimulationNodeDatum[])
      .force(
        'charge',
        forceManyBody()
          .strength((d) => {
            const sn = d as unknown as SimNode;
            return params.chargeStrength - sn.connectionCount * 10;
          })
          .distanceMax(500),
      )
      .force(
        'link',
        forceLink(simLinks as unknown as SimulationLinkDatum<SimulationNodeDatum>[])
          .id((d) => (d as unknown as SimNode).id)
          .distance((d) => {
            const sl = d as unknown as SimLink;
            return sl.type === 'wikilink' ? 100 : 200;
          })
          .strength((d) => {
            const sl = d as unknown as SimLink;
            return (sl.weight ?? 1.0) * 0.5;
          }),
      )
      .force('center', forceCenter(0, 0))
      .force(
        'collide',
        forceCollide()
          .radius((d) => {
            const sn = d as unknown as SimNode;
            const base = IMPORTANCE_BASE_SIZE[sn.importance] ?? DEFAULT_NODE_SIZE;
            return base / 2 + 10;
          })
          .strength(0.7),
      )
      .alphaDecay(params.alphaDecay)
      .velocityDecay(0.4);

  // 동기 Tick
  sim.tick(params.ticks);
  sim.stop();

  // 결과 위치 맵
  const positions: Record<string, { x: number; y: number }> = {};
  for (const sn of simNodes) {
    positions[sn.id] = { x: sn.x, y: sn.y };
  }

  return { positions };
}
