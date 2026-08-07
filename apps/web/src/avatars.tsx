// Inline SVG avatars, ported from the design prototype
// (docs/design/kiosk-prototype.html, its `avatar()` + `HAIR` functions). The
// path data is unchanged.
//
// Inline on purpose: no <img>, no icon font, no external request. The kiosk
// hangs on a wall and has to look right when the network is down, so the faces
// are part of the bundle.

import type { AvatarLook, HairStyle } from './avatar-looks'

const HAIR: Record<HairStyle, (c: string) => React.ReactNode> = {
  short: (c) => (
    <path d="M24 44c0-17 12-27 26-27s26 10 26 27c0-9-10-13-26-13S24 35 24 44z" fill={c} />
  ),
  fade: (c) => (
    <path d="M25 42c1-16 12-25 25-25s24 9 25 25c-4-6-13-9-25-9s-21 3-25 9z" fill={c} />
  ),
  curls: (c) => (
    <>
      <path
        d="M24 43c0-18 12-26 26-26s26 8 26 26c-3-7-8-10-13-8-4-6-22-6-26 0-5-2-10 1-13 8z"
        fill={c}
      />
      <circle cx="30" cy="30" r="8" fill={c} />
      <circle cx="50" cy="22" r="9" fill={c} />
      <circle cx="70" cy="30" r="8" fill={c} />
    </>
  ),
  long: (c) => (
    <path
      d="M22 46c0-19 13-29 28-29s28 10 28 29v30h-9V44c0-8-8-12-19-12s-19 4-19 12v32h-9z"
      fill={c}
    />
  ),
  tuft: (c) => (
    <>
      <path d="M28 42c2-14 11-22 22-22s20 8 22 22c-5-7-13-10-22-10s-17 3-22 10z" fill={c} />
      <path d="M52 20c4-6 10-6 12-2-5 0-8 2-9 5z" fill={c} />
    </>
  ),
}

export function Avatar({ look }: { look: AvatarLook }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <rect width="100" height="100" fill={look.bg} />
      <circle cx="50" cy="112" r="46" fill={look.shirt} />
      <path d="M38 66h24v18H38z" fill={look.skin} />
      <ellipse cx="50" cy="46" rx="26" ry="29" fill={look.skin} />
      {HAIR[look.hair](look.hairColor)}
      <ellipse cx="40" cy="47" rx="6.4" ry="7.4" fill="#fff" />
      <ellipse cx="60" cy="47" rx="6.4" ry="7.4" fill="#fff" />
      <circle cx="40.6" cy="48" r="4.2" fill={look.eye} />
      <circle cx="60.6" cy="48" r="4.2" fill={look.eye} />
      <circle cx="42" cy="46.4" r="1.5" fill="#fff" />
      <circle cx="62" cy="46.4" r="1.5" fill="#fff" />
      <path
        d="M43 60q7 6 14 0"
        stroke="#8A4A38"
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}
