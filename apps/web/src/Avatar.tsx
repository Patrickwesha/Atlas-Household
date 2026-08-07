// Inline SVG avatars and the progress ring that wraps them.
//
// Inline on purpose: a face must appear on the wall iPad even with the network
// down, so there is no image file, icon font, or sprite sheet to fetch. The art
// is monochrome — every shape derives from the member's own colour — which
// keeps each person identifiable from across the kitchen and avoids encoding
// anything about a real person's appearance.

import { GREEN, shade, tint } from './colors'

/** Five hair silhouettes. Distinct in outline, so they read at six feet. */
function Hair({ variant, hair }: { variant: number; hair: string }) {
  switch (variant % 5) {
    case 0: // cropped
      return <circle cx="50" cy="36" r="27" fill={hair} />
    case 1: // long
      return (
        <>
          <rect x="21" y="30" width="58" height="52" rx="22" fill={hair} />
          <circle cx="50" cy="36" r="27" fill={hair} />
        </>
      )
    case 2: // top bun
      return (
        <>
          <circle cx="50" cy="12" r="9" fill={hair} />
          <circle cx="50" cy="36" r="27" fill={hair} />
        </>
      )
    case 3: // curls
      return (
        <>
          <circle cx="50" cy="34" r="27" fill={hair} />
          <circle cx="30" cy="28" r="12" fill={hair} />
          <circle cx="50" cy="19" r="13" fill={hair} />
          <circle cx="70" cy="28" r="12" fill={hair} />
        </>
      )
    default: // beanie
      return (
        <>
          <path d="M27 34a23 23 0 0 1 46 0z" fill={hair} />
          <rect x="21" y="29" width="58" height="8" rx="4" fill={hair} />
        </>
      )
  }
}

/** Sized entirely by CSS (see .avatar-* rules) so the art scales with the
 *  viewport instead of being pinned to a pixel count in JS. */
export function Avatar({
  color,
  variant,
  className = 'avatar',
}: {
  color: string
  variant: number
  className?: string
}) {
  const face = tint(color, 0.62)
  const feature = shade(color, 0.35)
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false">
      <circle cx="50" cy="50" r="50" fill={tint(color, 0.87)} />
      <Hair variant={variant} hair={color} />
      <path d="M14 100c0-17 16-27 36-27s36 10 36 27z" fill={color} />
      <rect x="43" y="56" width="14" height="16" rx="6" fill={face} />
      <circle cx="50" cy="42" r="23" fill={face} />
      <circle cx="42" cy="41" r="3.2" fill={feature} />
      <circle cx="58" cy="41" r="3.2" fill={feature} />
      <path
        d="M42 50q8 7 16 0"
        stroke={feature}
        strokeWidth="3.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

/**
 * Avatar inside a today's-progress ring. `done` / `total` come straight off the
 * board response — no other source of truth, and nothing is claimed about days
 * other than today.
 */
export function AvatarRing({
  color,
  variant,
  done,
  total,
}: {
  color: string
  variant: number
  done: number
  total: number
}) {
  const STROKE = 8
  const RADIUS = (100 - STROKE) / 2
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS
  const complete = total > 0 && done >= total
  const progress = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0

  return (
    <div className="ring">
      <svg viewBox="0 0 100 100" className="ring-svg" aria-hidden="true" focusable="false">
        <circle
          cx="50"
          cy="50"
          r={RADIUS}
          fill="none"
          stroke={tint(color, 0.82)}
          strokeWidth={STROKE}
        />
        {progress > 0 && (
          <circle
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            stroke={complete ? GREEN : color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${CIRCUMFERENCE * progress} ${CIRCUMFERENCE}`}
            transform="rotate(-90 50 50)"
          />
        )}
      </svg>
      <Avatar color={color} variant={variant} className="avatar avatar-in-ring" />
      {complete && (
        <span className="ring-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="60%" height="60%">
            <path
              d="M5 13l4.5 4.5L19 7"
              fill="none"
              stroke="#fff"
              strokeWidth="3.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </div>
  )
}
