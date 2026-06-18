'use client';

/**
 * Sparkle — the ✦ four-point star motif from the Bold (nesy.app) design
 * language. Pure SVG, inherits `currentColor`; pair with the `.geny-sparkle`
 * class for the twinkle animation, or use plain for a static accent.
 */
export default function Sparkle({
  size = 16,
  className = '',
  style,
}: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
      style={style}
    >
      <path d="M12 0c.9 6.6 4.4 10.1 11 12 -6.6 1.9 -10.1 5.4 -11 12 -.9 -6.6 -4.4 -10.1 -11 -12 6.6 -1.9 10.1 -5.4 11 -12Z" />
    </svg>
  );
}
