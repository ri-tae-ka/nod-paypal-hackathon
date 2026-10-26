/** The "nod" wordmark: serif n and d, with the o drawn as a head mid-nod. */
export function NodLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="18 54 168 94" className={className} role="img" aria-label="nod">
      <defs>
        <filter id="nod-logo-rough" x="-10%" y="-30%" width="120%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="9" />
          <feDisplacementMap in="SourceGraphic" scale="1.6" />
        </filter>
      </defs>
      <path
        d="M24 136c40 10 110 12 154-4"
        stroke="#ffc439"
        strokeWidth="12"
        fill="none"
        strokeLinecap="round"
        filter="url(#nod-logo-rough)"
      />
      <g fontFamily="Georgia, 'Times New Roman', serif" fontWeight="700" fontSize="74" fill="#003087">
        <text x="28" y="122">n</text>
        <text x="128" y="122">d</text>
      </g>
      <circle cx="106" cy="104" r="20" fill="#0070e0" />
      <g stroke="#003087" strokeWidth="2.5" fill="none" strokeLinecap="round" filter="url(#nod-logo-rough)">
        <path d="M96 72q10-6 20 0" />
        <path d="M100 63q6-3 12 0" />
      </g>
      <path d="M98 104l6 6 10-11" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
