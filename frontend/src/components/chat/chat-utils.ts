/**
 * Shared chat utilities — color mappings, time formatting, and role helpers
 * used by Messenger, VTuber, and other chat-related components.
 */

// ── Role color helpers ──

/** Tailwind gradient class for role-based avatar backgrounds. */
export const getRoleColor = (role: string): string => {
  switch (role) {
    case 'developer': return 'from-blue-500 to-cyan-500';
    case 'researcher': return 'from-amber-500 to-orange-500';
    case 'planner': return 'from-teal-500 to-emerald-500';
    default: return 'from-emerald-500 to-green-500';
  }
};

/** CSS gradient string for role badge backgrounds. */
export const getRoleBadgeBg = (role: string): string => {
  switch (role) {
    case 'developer': return 'linear-gradient(135deg, #3b82f6, #06b6d4)';
    case 'researcher': return 'linear-gradient(135deg, #f59e0b, #ea580c)';
    case 'planner': return 'linear-gradient(135deg, #14b8a6, #10b981)';
    default: return 'linear-gradient(135deg, #10b981, #059669)';
  }
};

// ── Time formatting ──

/** Format timestamp to HH:MM (locale). */
export const formatTime = (ts: string): string => {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** Format timestamp to display-friendly date label. */
export const formatDate = (ts: string): string => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Format duration in milliseconds to human-readable string. */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

// ── Emotion parsing (VTuber) ──

export const EMOTIONS = [
  'neutral', 'joy', 'anger', 'disgust', 'fear', 'smirk', 'sadness', 'surprise',
  'warmth', 'curious', 'calm', 'excited', 'shy', 'proud', 'grateful',
  'playful', 'confident', 'thoughtful', 'concerned', 'amused', 'tender',
] as const;

/** Emotion → subtle color for inline badges */
export const EMOTION_COLORS: Record<string, string> = {
  neutral: '#8b949e',
  joy: '#e3b341',
  anger: '#f47067',
  disgust: '#57ab5a',
  fear: '#b083f0',
  smirk: '#f0a8d0',
  sadness: '#6cb6ff',
  surprise: '#39d2c0',
  warmth: '#f0883e',
  curious: '#d2a8ff',
  calm: '#7ee787',
  excited: '#f8e3a1',
  shy: '#ffb3c6',
  proud: '#ffa657',
  grateful: '#a5d6ff',
  playful: '#ff9bce',
  confident: '#79c0ff',
  thoughtful: '#b7bfc7',
  concerned: '#d29922',
  amused: '#e3b341',
  tender: '#f0a8d0',
};

const EMOTION_SET = new Set<string>(EMOTIONS);
const EMOTION_REGEX = new RegExp(`^\\[(${EMOTIONS.join('|')})\\]\\s*`);

/** Parse "[emotion] text" → [emotion, cleanText]. Returns ['neutral', text] if no tag. */
export const parseEmotion = (content: string): [string, string] => {
  const match = content.match(EMOTION_REGEX);
  if (match) {
    return [match[1], content.slice(match[0].length)];
  }
  return ['neutral', content];
};

export interface EmotionSegment {
  emotion: string | null;
  content: string;
}

/**
 * Split text by inline emotion tags into segments.
 * Each segment has an optional emotion and its following text content.
 * Tags must be from known EMOTIONS and appear at line start.
 */
export function splitEmotionSegments(text: string): EmotionSegment[] {
  // Match [emotion] at start of string or after newline
  const re = new RegExp(`(?:^|\\n)\\[(${EMOTIONS.join('|')})\\][ ]*`, 'g');
  const segments: EmotionSegment[] = [];
  let lastIndex = 0;

  for (const m of text.matchAll(re)) {
    const matchStart = m.index!;
    // Text before this emotion tag
    const before = text.slice(lastIndex, matchStart);
    if (before.trim()) {
      if (segments.length > 0) {
        segments[segments.length - 1].content += before;
      } else {
        segments.push({ emotion: null, content: before });
      }
    }
    segments.push({ emotion: m[1], content: '' });
    lastIndex = matchStart + m[0].length;
  }

  // Remaining text after last match
  const remaining = text.slice(lastIndex);
  if (remaining) {
    if (segments.length > 0) {
      segments[segments.length - 1].content += remaining;
    } else {
      segments.push({ emotion: null, content: remaining });
    }
  }

  // Fallback if no segments
  if (segments.length === 0) {
    return [{ emotion: null, content: text }];
  }

  return segments;
}

/** Check if a string is a known emotion */
export function isKnownEmotion(tag: string): boolean {
  return EMOTION_SET.has(tag);
}

// ── File path helpers ──

/** Extract just the filename from a full path. */
export const shortFileName = (fp: string): string => {
  const parts = fp.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || fp;
};
