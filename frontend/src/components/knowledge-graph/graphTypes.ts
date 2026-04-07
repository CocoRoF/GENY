/**
 * Knowledge Graph 전용 타입 정의
 *
 * 기존 MemoryGraphNode / MemoryGraphEdge와 하위 호환.
 * 백엔드가 확장 필드(tags, connectionCount, summary, type, weight)를
 * 아직 보내지 않더라도 optional 처리로 안전하게 동작한다.
 */

import type { MemoryGraphNode, MemoryGraphEdge } from '@/types';

// ── Edge 타입 ───────────────────────────────────────────
export type EdgeType = 'wikilink' | 'tag' | 'backlink';

// ── 확장 노드 (기존 필드 + optional 확장) ────────────────
export interface KnowledgeGraphNode extends MemoryGraphNode {
  tags?: string[];
  connectionCount?: number;
  summary?: string;
  charCount?: number;
}

// ── 확장 엣지 (기존 필드 + optional 확장) ────────────────
export interface KnowledgeGraphEdge extends MemoryGraphEdge {
  type?: EdgeType;
  weight?: number;
  label?: string;
}

// ── 그래프 필터 상태 ─────────────────────────────────────
export interface GraphFilterState {
  categories: Set<string>;
  importance: Set<string>;
  searchQuery: string;
  showOrphans: boolean;
  edgeTypes: Set<EdgeType>;
  selectedNodeId: string | null;
  highlightDepth: number;
}

// ── UnifiedGraphView props ───────────────────────────────
export interface UnifiedGraphViewProps {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  onSelectFile: (filename: string) => void;
}

// ── d3-force 내부용 시뮬레이션 노드 ──────────────────────
export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  category: string;
  importance: string;
  connectionCount: number;
}

export interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  type: EdgeType;
  weight: number;
}
