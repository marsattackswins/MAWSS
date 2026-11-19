/**
 * A stylized trade-journal icon: a small notebook with a pencil overlay.
 * Replaces the generic BookOpen glyph with a purpose-built mark.
 */
export function JournalIcon({ size = 15, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 15 15"
      fill="none"
      aria-hidden="true"
      className={className ? `shrink-0 ${className}` : "shrink-0"}
    >
      {/* Notebook body */}
      <rect x="2" y="1.5" width="9" height="12" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
      {/* Spine binding marks */}
      <path d="M2 4.5h-1M2 7.5h-1M2 10.5h-1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      {/* Three ruled lines */}
      <path d="M4.5 5h4.5M4.5 7.5h4.5M4.5 10h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      {/* Pencil nib (bottom-right corner) */}
      <path
        d="M9.8 9.8l1.6-1.6.8.8-1.6 1.6-.8-.8z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M9.8 9.8l-.3 1.1 1.1-.3" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}