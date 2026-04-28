'use client';

/**
 * StageArtifactPicker — labeled artifact dropdown for the stage
 * header. Renders as a single bordered pill with two regions: a
 * left-side eyebrow label ("ARTIFACT" + Layers icon) on a tinted
 * background, and a borderless dropdown on the right showing the
 * current pick. The whole thing reads as one labeled compound
 * control instead of an unmarked pill.
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
    <div className="inline-flex items-stretch h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] shrink-0 overflow-hidden">
      <span className="inline-flex items-center gap-1.5 px-2.5 bg-[hsl(var(--accent))] border-r border-[hsl(var(--border))]">
        <Layers className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))] shrink-0" />
        <span className="text-[0.625rem] uppercase tracking-wider font-semibold text-[hsl(var(--muted-foreground))]">
          {t('envManagement.stageArtifact')}
        </span>
      </span>
      <Select
        value={current}
        onValueChange={(v) => patchStage(order, { artifact: v })}
      >
        <SelectTrigger
          className="h-9 w-[180px] border-0 rounded-none px-2.5 text-[0.75rem] font-medium focus:ring-0 focus:ring-offset-0"
          aria-label={t('envManagement.stageArtifact')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((name) => (
            <SelectItem key={name} value={name} className="text-[0.75rem]">
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
