'use client';

/**
 * StageArtifactPicker — compact artifact dropdown for the stage
 * header. Renders as a self-contained pill: a small Layers icon + the
 * current artifact name + chevron. The "ARTIFACT" label is dropped
 * from the surrounding chrome — the icon carries the affordance and
 * the tooltip names the field for screen readers / hover discovery.
 *
 * Hydrates the available artifact list via
 * `catalogApi.listArtifacts(order)`; until the response lands, falls
 * back to the entry's current pick + 'default' so the control stays
 * interactive.
 */

import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import { catalogApi } from '@/lib/environmentApi';
import { useI18n } from '@/lib/i18n';
import { useEnvironmentDraftStore } from '@/store/useEnvironmentDraftStore';
import type {
  ArtifactInfo,
  StageManifestEntry,
} from '@/types/environment';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  order: number;
  entry: StageManifestEntry;
}

export default function StageArtifactPicker({ order, entry }: Props) {
  const { t } = useI18n();
  const patchStage = useEnvironmentDraftStore((s) => s.patchStage);
  const [artifacts, setArtifacts] = useState<ArtifactInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    catalogApi
      .listArtifacts(order)
      .then((res) => {
        if (!cancelled) setArtifacts(res.artifacts);
      })
      .catch(() => {
        /* falls back to current + default below */
      });
    return () => {
      cancelled = true;
    };
  }, [order]);

  const current = entry.artifact || 'default';
  const options = (() => {
    if (artifacts && artifacts.length > 0) {
      const names = artifacts.map((a) => a.name);
      if (!names.includes(current)) names.unshift(current);
      return names;
    }
    return Array.from(new Set([current, 'default']));
  })();

  return (
    <Select
      value={current}
      onValueChange={(v) => patchStage(order, { artifact: v })}
    >
      <SelectTrigger
        className="h-8 px-3 min-w-[170px] text-[0.75rem] font-medium shrink-0"
        title={t('envManagement.stageArtifact')}
        aria-label={t('envManagement.stageArtifact')}
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          <Layers className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] shrink-0" />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((name) => (
          <SelectItem key={name} value={name} className="text-[0.75rem]">
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
