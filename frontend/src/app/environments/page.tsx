'use client';

/**
 * /environments — dedicated page for the visual 21-stage environment
 * builder.
 *
 * Cycle 20260427_2 PR-1 split the surface from the dev-mode tab system;
 * PR-2 redesigned the layout to be canvas-first. The page wrapper is
 * minimal: it only owns the post-save redirect. All header chrome (back
 * link, page title, env metadata, actions) is consolidated into the
 * shell's single-row CompactMetaBar — there is no separate page header
 * row competing for vertical space.
 */

import { useRouter } from 'next/navigation';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import EnvManagementShell from '@/components/env_management/EnvManagementShell';

export default function EnvironmentManagementPage() {
  const router = useRouter();
  const requestOpenEnvDrawer = useEnvironmentStore(
    (s) => s.requestOpenEnvDrawer,
  );

  const handleSaved = (newEnvId: string) => {
    requestOpenEnvDrawer(newEnvId);
    router.push('/');
  };

  return (
    <div className="min-h-screen h-screen bg-[hsl(var(--background))] text-[hsl(var(--foreground))] flex flex-col overflow-hidden">
      <EnvManagementShell onSaved={handleSaved} />
    </div>
  );
}
