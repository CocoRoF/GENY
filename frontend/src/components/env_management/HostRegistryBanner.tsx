'use client';

/**
 * HostRegistryBanner — slim disclaimer rendered at the top of the
 * MCP / SKILLS / HOOK / 권한 tabs in /environments.
 *
 * The four host registries live one-per-machine — every env on
 * this Geny instance sees the same set of hooks/skills/MCPs/
 * permission rules. Edits here propagate to every environment by
 * design. The env-side picker (in 환경관리 → Globals → 훅 etc.)
 * is where the operator narrows what each env actually uses.
 *
 * The banner exists so an operator opening the tab the first time
 * understands the blast radius of their edits without having to
 * read CHANGELOG entries. Cycle 20260429 made the four tabs
 * top-level (PR #553); the disclaimer is the cheapest way to keep
 * the new "MCP" tab from reading like a per-env config surface.
 *
 * Visual: amber, single-row, borderless inside the TabShell body.
 * Dense — matches the operator's preference for no decorative
 * chrome, and reads as a warning chip rather than a card.
 */

import { Info } from 'lucide-react';

export interface HostRegistryBannerProps {
  /** Optional second line — e.g. category-specific note. Kept
   *  short; long-form details belong in the per-tab help modal. */
  note?: string;
}

export default function HostRegistryBanner({ note }: HostRegistryBannerProps) {
  return (
    <div className="px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-[0.7rem] text-amber-800 dark:text-amber-300 leading-relaxed flex items-start gap-2">
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-semibold uppercase tracking-wider mr-2">
          호스트 공용
        </span>
        여기서 등록·수정하는 항목은 이 호스트의 <strong>모든 환경</strong>에
        영향을 줍니다. 환경별로 일부만 사용하려면 각 환경의 Globals 패널에서
        picker로 좁히거나, 행 우측의 ★ 토글로 새 환경의 기본 포함 여부를
        지정하세요.
        {note ? <span className="ml-1 opacity-90">— {note}</span> : null}
      </div>
    </div>
  );
}
