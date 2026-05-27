'use client';

import EngineMatrixCard from '@/components/voice-studio/EngineMatrixCard';
import OmniVoiceDefaultsCard from '@/components/voice-studio/OmniVoiceDefaultsCard';
import CacheCard from '@/components/voice-studio/CacheCard';

export default function SettingsPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-4">
      <EngineMatrixCard />
      <OmniVoiceDefaultsCard />
      <CacheCard />
    </div>
  );
}
