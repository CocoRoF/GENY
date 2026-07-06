/**
 * Knowledge Graph 시각화 상수
 *
 * 카테고리 색상, 중요도별 노드 크기, 엣지 스타일 등
 * 모든 Knowledge Graph 컴포넌트에서 공유한다.
 */

import type { EdgeType } from './graphTypes';

// ── 카테고리 색상 ────────────────────────────────────────
export const CATEGORY_COLORS: Record<string, string> = {
  daily: '#f59e0b',
  topics: '#3b82f6',
  projects: '#8b5cf6',
  insights: '#ec4899',
  reference: '#06b6d4',
  root: '#64748b',
};

export const DEFAULT_NODE_COLOR = '#64748b';

// ── 중요도별 기본 노드 크기 ──────────────────────────────
export const IMPORTANCE_BASE_SIZE: Record<string, number> = {
  critical: 28,
  high: 22,
  medium: 16,
  low: 12,
};

export const DEFAULT_NODE_SIZE = 16;

// ── 엣지 스타일 ──────────────────────────────────────────
export const EDGE_STYLES: Record<EdgeType, { color: string; width: number; dash?: string }> = {
  wikilink: { color: '#58a6ff', width: 2 },
  backlink: { color: '#8b949e', width: 1.5 },
  tag: { color: '#d29922', width: 1, dash: '4 2' },
  // soft, derived similarity link (lexical/semantic k-NN) — subtle violet, dotted
  semantic: { color: '#a371f7', width: 1, dash: '2 3' },
};

// ── 노드 크기 계산 ──────────────────────────────────────
export function computeNodeSize(importance: string, connectionCount: number): number {
  const base = IMPORTANCE_BASE_SIZE[importance] ?? DEFAULT_NODE_SIZE;
  return base + Math.log2(1 + connectionCount) * 3;
}
