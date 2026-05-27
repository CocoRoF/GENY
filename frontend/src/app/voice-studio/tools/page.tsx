'use client';

import LanguageDetectTool from '@/components/voice-studio/tools/LanguageDetectTool';
import CompareTool from '@/components/voice-studio/tools/CompareTool';
import SeedSearchTool from '@/components/voice-studio/tools/SeedSearchTool';
import RefAnalyzerTool from '@/components/voice-studio/tools/RefAnalyzerTool';
import { useI18n } from '@/lib/i18n';

export default function ToolsPage() {
  const { t } = useI18n();
  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-3">
      <p className="text-[0.8125rem] text-[var(--text-muted)] pb-2">
        {t('voiceStudio.tools.pageHint')}
      </p>
      <LanguageDetectTool />
      <CompareTool />
      <SeedSearchTool />
      <RefAnalyzerTool />
    </div>
  );
}
