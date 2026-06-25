'use client';

/**
 * /sandbox-tool-packs — standalone Sandbox Tool Packs manager.
 *
 * Thin wrapper over the shared SandboxToolPacksManager, which is ALSO embedded
 * as the environment editor's "Sandbox Tool Packs" section (?tab=sandbox_packs).
 * Packs are a first-class Agent Environment component, so both surfaces share
 * one localized implementation.
 */

import SandboxToolPacksManager from '@/components/sandbox_tool_packs/SandboxToolPacksManager';

export default function SandboxToolPacksPage() {
  return <SandboxToolPacksManager />;
}
