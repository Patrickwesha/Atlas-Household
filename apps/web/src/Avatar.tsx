// Inline SVG avatars + the per-person progress ring.
//
// Inline on purpose: no external assets, nothing to fetch, nothing to fail on a
// wall iPad with flaky wifi. The face is derived deterministically from the
// member's id, so the same person always gets the same face without storing an
// avatar column or committing any real likeness to a public repo.

const SKINS = ['#F5D0B0', '#EDB68C', '#D19A66', '#A96B3C', '#7A4A28']
const HAIRS = ['#2E1F1B', '#5A3825', '#A65E2E', '#D9A441', '#15151A', '#6B4423']
const FEATURE = '#2B2440'

/** Stable 32-bit hash of the member id — the only input to face selection. */
function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

/** Hair mass + one accessory shape, drawn behind and around the face circle. */
function Hair({ variant, color }: { variant: number; color: string }) {
  return (
    <>
      {variant === 1 && (
        <>
          <rect x="19" y="48" width="11" height="34" rx="5.5" fill={color} />
          <rect x="70" y="48" width="11" height="34" rx="5.5" fill={color} />
        </>
      )}
      {variant === 2 && <circle cx="50" cy="18" r="11" fill={color} />}
      {variant === 3 && <circle cx="83" cy="44" r="10" fill={color} />}
      {variant === 4 && (
        <>
          <circle cx="28" cy="40" r="11" fill={color} />
          <circle cx="50" cy="32" r="12" fill={color} />
          <circle cx="72" cy="40" r="11" fill={color} />
        </>
      )}
      {/* Hair mass. Variant 5 is a tight buzz: smaller radius, no accessory. */}
      <circle cx="50" cy="50" r={variant === 5 ? 27 : 30} fill={color} />
    </>
  )
}

function Face({ id }: { id: string }) {
  const h = hashId(id)
  const skin = SKINS[h % SKINS.length]
  const hair = HAIRS[(h >>> 3) % HAIRS.length]
  const variant = (h >>> 7) % 6

  return (
    <g transform="translate(10, 4)">
      <Hair variant={variant} color={hair} />
      {/* Face sits below the hair mass, so the overlap becomes the hairline. */}
      <circle cx="24" cy="60" r="4.5" fill={skin} />
      <circle cx="76" cy="60" r="4.5" fill={skin} />
      <circle cx="50" cy="58" r="26" fill={skin} />
      {variant === 0 && <rect x="27" y="36" width="46" height="11" rx="5.5" fill={hair} />}
      <circle cx="41" cy="56" r="3.4" fill={FEATURE} />
      <circle cx="59" cy="56" r="3.4" fill={FEATURE} />
      <path
        d="M41 68 Q50 76 59 68"
        stroke={FEATURE}
        strokeWidth="3.4"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  )
}

const R = 54
const CIRC = 2 * Math.PI * R

export default function Avatar({
  id,
  color,
  size = 132,
  ring,
}: {
  id: string
  color: string
  size?: number
  /** Omit entirely to draw a face with no ring — the dependent tile. */
  ring?: { done: number; total: number }
}) {
  const clipId = `clip-${id}`
  // total === 0 draws a full ring: "nothing to do" is complete, not empty.
  const pct = ring ? (ring.total === 0 ? 1 : ring.done / ring.total) : 0

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="presentation"
      focusable="false"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="60" cy="60" r="46" />
        </clipPath>
      </defs>

      {/* 8-digit hex = the member's colour at ~14% over the white sheet. */}
      <circle cx="60" cy="60" r="46" fill={`${color}24`} />
      <g clipPath={`url(#${clipId})`}>
        <Face id={id} />
      </g>

      {ring && (
        <>
          <circle cx="60" cy="60" r={R} fill="none" stroke="#E9E5F7" strokeWidth="8" />
          <circle
            cx="60"
            cy="60"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - pct)}
            transform="rotate(-90 60 60)"
          />
        </>
      )}
    </svg>
  )
}
