/**
 * N-hop BFS 하이라이트
 *
 * 선택된 노드로부터 지정된 깊이까지의 이웃 노드를 탐색하여
 * hop distance 를 반환한다.
 */

import type { KnowledgeGraphEdge } from './graphTypes';

/**
 * 선택된 노드에서 maxDepth hop 내의 모든 노드를 BFS로 탐색.
 * @returns nodeId → hop distance (0 = 선택된 노드)
 */
export function computeHighlightSet(
  selectedId: string,
  edges: KnowledgeGraphEdge[],
  maxDepth: number = 2,
): Map<string, number> {
  const result = new Map<string, number>();
  result.set(selectedId, 0);

  // 인접 리스트 구축
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }

  let frontier = new Set([selectedId]);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      const neighbors = adjacency.get(nodeId);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!result.has(neighbor)) {
          result.set(neighbor, depth);
          next.add(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  return result;
}

/**
 * 엣지가 하이라이트 셋에 포함되는지 확인.
 * source와 target 모두 하이라이트 셋에 있어야 활성 엣지.
 */
export function isEdgeHighlighted(
  source: string,
  target: string,
  highlightSet: Map<string, number>,
): boolean {
  return highlightSet.has(source) && highlightSet.has(target);
}
