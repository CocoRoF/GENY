'use client';

/**
 * GraphControls — Knowledge Graph 필터 + 검색 패널
 *
 * 카테고리, 중요도, 엣지 타입 토글 + 텍스트 검색.
 * 접을 수 있는 컴팩트 UI.
 */

import { useState, useCallback } from 'react';
import { Search, Filter, ChevronUp } from 'lucide-react';
import { CATEGORY_COLORS, EDGE_STYLES } from './graphConstants';
import type { EdgeType, GraphFilterState } from './graphTypes';

interface GraphControlsProps {
  filter: GraphFilterState;
  onFilterChange: (filter: GraphFilterState) => void;
  availableCategories: string[];
}

export default function GraphControls({ filter, onFilterChange, availableCategories }: GraphControlsProps) {
  const [expanded, setExpanded] = useState(false);

  const toggleCategory = useCallback(
    (cat: string) => {
      const next = new Set(filter.categories);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      onFilterChange({ ...filter, categories: next });
    },
    [filter, onFilterChange],
  );

  const toggleImportance = useCallback(
    (imp: string) => {
      const next = new Set(filter.importance);
      if (next.has(imp)) next.delete(imp);
      else next.add(imp);
      onFilterChange({ ...filter, importance: next });
    },
    [filter, onFilterChange],
  );

  const toggleEdgeType = useCallback(
    (et: EdgeType) => {
      const next = new Set(filter.edgeTypes);
      if (next.has(et)) next.delete(et);
      else next.add(et);
      onFilterChange({ ...filter, edgeTypes: next });
    },
    [filter, onFilterChange],
  );

  const setSearch = useCallback(
    (q: string) => {
      onFilterChange({ ...filter, searchQuery: q });
    },
    [filter, onFilterChange],
  );

  const toggleOrphans = useCallback(() => {
    onFilterChange({ ...filter, showOrphans: !filter.showOrphans });
  }, [filter, onFilterChange]);

  const importanceLevels = ['critical', 'high', 'medium', 'low'];
  const edgeTypes: EdgeType[] = ['wikilink', 'tag'];

  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 10,
        background: 'var(--obs-bg-panel)',
        border: '1px solid var(--obs-border-subtle)',
        borderRadius: 8,
        backdropFilter: 'blur(8px)',
        minWidth: 200,
        fontSize: 11,
        color: 'var(--obs-text-dim)',
      }}
    >
      {/* Search bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: expanded ? '1px solid var(--obs-border-subtle)' : 'none' }}>
        <Search size={13} style={{ opacity: 0.5, flexShrink: 0 }} />
        <input
          type="text"
          placeholder="Search nodes..."
          value={filter.searchQuery}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--obs-text)',
            fontSize: 11,
          }}
        />
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--obs-text-dim)', padding: 2 }}
        >
          {expanded ? <ChevronUp size={13} /> : <Filter size={13} />}
        </button>
      </div>

      {/* Expanded filters */}
      {expanded && (
        <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Categories */}
          <div>
            <div style={{ fontWeight: 600, fontSize: 10, marginBottom: 4, color: 'var(--obs-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Category
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {availableCategories.map((cat) => {
                const active = filter.categories.has(cat);
                const color = CATEGORY_COLORS[cat] ?? '#64748b';
                return (
                  <button
                    key={cat}
                    onClick={() => toggleCategory(cat)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 6px',
                      borderRadius: 4,
                      border: `1px solid ${active ? color : 'var(--obs-border-subtle)'}`,
                      background: active ? `${color}20` : 'transparent',
                      color: active ? color : 'var(--obs-text-muted)',
                      cursor: 'pointer',
                      fontSize: 10,
                      textTransform: 'capitalize',
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, opacity: active ? 1 : 0.3 }} />
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Importance */}
          <div>
            <div style={{ fontWeight: 600, fontSize: 10, marginBottom: 4, color: 'var(--obs-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Importance
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {importanceLevels.map((imp) => {
                const active = filter.importance.has(imp);
                return (
                  <button
                    key={imp}
                    onClick={() => toggleImportance(imp)}
                    style={{
                      padding: '2px 6px',
                      borderRadius: 4,
                      border: `1px solid ${active ? 'var(--obs-purple)' : 'var(--obs-border-subtle)'}`,
                      background: active ? 'var(--obs-purple-dim)' : 'transparent',
                      color: active ? 'var(--obs-purple)' : 'var(--obs-text-muted)',
                      cursor: 'pointer',
                      fontSize: 10,
                      textTransform: 'capitalize',
                    }}
                  >
                    {imp}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Edge types */}
          <div>
            <div style={{ fontWeight: 600, fontSize: 10, marginBottom: 4, color: 'var(--obs-text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Edge Type
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {edgeTypes.map((et) => {
                const active = filter.edgeTypes.has(et);
                const style = EDGE_STYLES[et];
                return (
                  <button
                    key={et}
                    onClick={() => toggleEdgeType(et)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 6px',
                      borderRadius: 4,
                      border: `1px solid ${active ? style.color : 'var(--obs-border-subtle)'}`,
                      background: active ? `${style.color}20` : 'transparent',
                      color: active ? style.color : 'var(--obs-text-muted)',
                      cursor: 'pointer',
                      fontSize: 10,
                      textTransform: 'capitalize',
                    }}
                  >
                    <span
                      style={{
                        width: 12,
                        height: 2,
                        background: style.color,
                        opacity: active ? 1 : 0.3,
                        borderRadius: 1,
                      }}
                    />
                    {et}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Orphan toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!filter.showOrphans}
              onChange={toggleOrphans}
              style={{ accentColor: 'var(--obs-purple)' }}
            />
            <span>Hide orphan nodes</span>
          </label>
        </div>
      )}
    </div>
  );
}
