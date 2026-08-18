/**
 * Knowledge Graph 전용 타입 정의
 *
 * 기존 MemoryGraphNode / MemoryGraphEdge와 하위 호환.
 * 백엔드가 확장 필드(tags, connectionCount, summary, type, weight)를
 * 아직 보내지 않더라도 optional 처리로 안전하게 동작한다.
 */

import type { MemoryGraphNode, MemoryGraphEdge } from '@/types';

// ── Edge 타입 ───────────────────────────────────────────
export type EdgeType = 'wikilink' | 'tag' | 'backlink' | 'semantic';

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
export type GraphStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UnifiedGraphViewProps {
  /** Why the node list looks the way it does. An empty list means three
   *  different things — not asked yet, asking now, asked and genuinely
   *  empty — and this view used to render all three identically, so a
   *  seed that matched nothing was indistinguishable from a vault with
   *  no memories. Optional: callers that load synchronously omit it. */
  status?: GraphStatus;
  /** The view is bounded and there was more. */
  truncated?: boolean;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  onSelectFile: (filename: string) => void;
}
