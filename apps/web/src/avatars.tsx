// Inline SVG faces. Deliberately not image files: the kiosk has no service
// worker, so anything fetched separately can fail to arrive on a flaky wall
// iPad and leave a hole where a person should be.
//
// The face is the member's own color with features in guaranteed-contrast ink,
// rather than a drawn skin tone. That keeps every tile visually tied to the
// `members.color` the family chose, avoids assigning anyone an appearance they
// didn't pick, and stays legible for any hex in sRGB.

import { pickInk, shade } from './ink'

// Arc across the top of the head, cut off at height `y`.
// Head is a circle at (50, 54) r 32; hair is r 34 so it reads as hair, not a hat.
function crown(y: number): string {
  const dx = Math.sqrt(34 * 34 - (54 - y) * (54 - y))
  return `M${(50 - dx).toFixed(1)} ${y} A34 34 0 0 1 ${(50 + dx).toFixed(1)} ${y} Z`
}

const FACES = ['fringe', 'short', 'curls', 'ponytail', 'beanie', 'long'] as const

// Stable per person: the same member id always draws the same face, so nobody's
// avatar changes between polls, reboots, or a re-seed.
function faceFor(seed: string): (typeof FACES)[number] {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return FACES[h % FACES.length]
}

export function Avatar({ color, seed }: { color: string; seed: string }) {
  // Two different jobs, two different colors. Features sit ON the face, so they
  // use guaranteed-contrast ink against it. Hair sits on the white SHEET, so it
  // uses a darker cut of the member's own color — drawing hair in `ink` meant a
  // white-ink face got white hair on a white sheet and the head looked sliced
  // flat across the top.
  const ink = pickInk(color)
  const hair = shade(color)
  const face = faceFor(seed)

  return (
    <svg className="avatar" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      {/* The outline keeps a pale member color from dissolving into the sheet. */}
      <circle cx="50" cy="54" r="32" fill={color} stroke={hair} strokeWidth="2" />

      {face === 'long' && (
        <>
          <rect x="16" y="42" width="14" height="38" rx="7" fill={hair} />
          <rect x="70" y="42" width="14" height="38" rx="7" fill={hair} />
        </>
      )}
      {face === 'ponytail' && <circle cx="80" cy="40" r="10" fill={hair} />}

      <path
        d={crown(face === 'short' ? 36 : face === 'fringe' || face === 'beanie' ? 44 : 40)}
        fill={hair}
      />

      {face === 'curls' && (
        <>
          <circle cx="28" cy="34" r="8" fill={hair} />
          <circle cx="50" cy="26" r="9" fill={hair} />
          <circle cx="72" cy="34" r="8" fill={hair} />
        </>
      )}
      {face === 'beanie' && <circle cx="50" cy="15" r="7" fill={hair} />}

      <circle cx="39" cy="52" r="3.8" fill={ink} />
      <circle cx="61" cy="52" r="3.8" fill={ink} />
      <path
        d="M38 64 Q50 74 62 64"
        fill="none"
        stroke={ink}
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}
