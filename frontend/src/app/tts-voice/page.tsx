import { redirect } from 'next/navigation';

/**
 * Legacy ``/tts-voice`` route. All functionality moved to
 * ``/voice-studio/*`` (see ``docs/voice-upgrade-plan/``). Kept as a
 * permanent server-side redirect so old bookmarks / external links
 * keep working.
 */
export default function LegacyTtsVoicePage() {
  redirect('/voice-studio/clone-design');
}
