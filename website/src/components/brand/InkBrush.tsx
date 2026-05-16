/**
 * Thin section divider — a sweeping ink stroke. Use between sections
 * where the standard 1px border feels too generic.
 */
export default function InkBrush() {
  return (
    <svg
      viewBox="0 0 1200 40"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      class="ink-brush"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="brush-g" x1="0" y1="0" x2="1200" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="var(--tg-grad-from)" stop-opacity="0" />
          <stop offset="0.15" stop-color="var(--tg-grad-from)" stop-opacity="0.7" />
          <stop offset="0.5" stop-color="var(--tg-grad-mid)" stop-opacity="0.9" />
          <stop offset="0.85" stop-color="var(--tg-grad-to)" stop-opacity="0.7" />
          <stop offset="1" stop-color="var(--tg-grad-to)" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path
        d="M0 24 C 200 6, 400 32, 600 18 S 1000 30, 1200 12"
        stroke="url(#brush-g)"
        stroke-width="2.5"
        fill="none"
        stroke-linecap="round"
      />
      <path
        d="M40 28 C 240 14, 440 32, 640 22 S 1040 28, 1180 18"
        stroke="url(#brush-g)"
        stroke-width="1"
        fill="none"
        opacity="0.5"
      />
    </svg>
  );
}
