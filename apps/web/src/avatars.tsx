// Inline SVG avatars.
//
// Inline on purpose: no image requests, nothing to 404, nothing that renders as
// a broken-image glyph when the kitchen wifi drops. The whole face is markup.
//
// Which face a person gets is a stable hash of their member id, so a face never
// migrates between people when the seed changes or a member is added — kids
// recognize their tile by the picture long before they read the name.

import { onWhite, withAlpha } from './colors'

const SKIN_TONES = ['#F7D9BC', '#F2C29A', '#DBA073', '#C68642', '#A9714B', '#7B4B2A']
const FACE_COUNT = 6
const INK = '#1F2937'

/** FNV-1a. Small, stable, and no dependency. */
function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

export function Avatar({ id, color }: { id: string; color: string }) {
  const hash = hashId(id)
  const variant = hash % FACE_COUNT
  const skin = SKIN_TONES[Math.floor(hash / FACE_COUNT) % SKIN_TONES.length]
  // Hair sits on a very pale wash of the same hue, so darken it enough to read.
  const hair = onWhite(color, 3)

  return (
    <svg
      className="avatar"
      viewBox="0 0 100 100"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="50" cy="50" r="50" fill={withAlpha(color, 0.16)} />

      {/* Behind-the-head hair shapes, per variant. */}
      {variant === 1 && (
        <>
          <rect x="21" y="48" width="12" height="36" rx="6" fill={hair} />
          <rect x="67" y="48" width="12" height="36" rx="6" fill={hair} />
        </>
      )}
      {variant === 4 && <ellipse cx="79" cy="60" rx="8" ry="13" fill={hair} />}
      {variant === 5 && (
        <>
          <circle cx="28" cy="70" r="9" fill={hair} />
          <circle cx="72" cy="70" r="9" fill={hair} />
        </>
      )}

      {/* Hair cap: a disc the face partly covers, leaving a crescent on top. */}
      <circle cx="50" cy="50" r="26" fill={hair} />
      {variant === 2 && (
        <>
          <circle cx="30" cy="36" r="10" fill={hair} />
          <circle cx="50" cy="27" r="11" fill={hair} />
          <circle cx="70" cy="36" r="10" fill={hair} />
        </>
      )}
      {variant === 3 && <circle cx="50" cy="21" r="10" fill={hair} />}

      {/* Face. */}
      <circle cx="50" cy="56" r="23" fill={skin} />

      {/* Fringe, drawn over the face so it reads as bangs. */}
      {variant === 0 && (
        <path d="M28 52a23 23 0 0 1 44 0 34 34 0 0 0-44 0Z" fill={hair} />
      )}

      <circle cx="42" cy="56" r="2.8" fill={INK} />
      <circle cx="58" cy="56" r="2.8" fill={INK} />
      <path
        d="M42 66q8 7 16 0"
        stroke={INK}
        strokeWidth="2.8"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
