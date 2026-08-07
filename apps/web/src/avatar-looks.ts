// Avatar look data, split out from avatars.tsx so that file exports only a
// component (keeps Vite fast refresh working).
//
// Values are unchanged from the design prototype
// (docs/design/kiosk-prototype.html: its SKIN array and per-person `av` blocks).

export type HairStyle = 'short' | 'fade' | 'curls' | 'long' | 'tuft'

export interface AvatarLook {
  bg: string
  skin: string
  eye: string
  shirt: string
  hair: HairStyle
  hairColor: string
}

const LOOKS: Omit<AvatarLook, 'shirt'>[] = [
  { bg: '#EDE7FF', skin: '#5C3A21', eye: '#3B2A1A', hair: 'fade', hairColor: '#1A1218' },
  { bg: '#FDE8F3', skin: '#8D5524', eye: '#3B2A1A', hair: 'long', hairColor: '#241018' },
  { bg: '#E6F6FF', skin: '#C68642', eye: '#4A3018', hair: 'curls', hairColor: '#20140E' },
  { bg: '#FFF2DE', skin: '#8D5524', eye: '#3B2A1A', hair: 'short', hairColor: '#1C1216' },
  { bg: '#E8FBF2', skin: '#C68642', eye: '#4A3018', hair: 'tuft', hairColor: '#241812' },
]

/**
 * A member's look, fixed by their position on the board.
 *
 * The board returns members ordered by created_at, so the index is stable
 * across polls and a person's face never changes under them. The shirt uses
 * the member's own colour from the database, so the avatar and their tile agree.
 */
export function avatarFor(index: number, shirt: string): AvatarLook {
  const l = LOOKS[((index % LOOKS.length) + LOOKS.length) % LOOKS.length]
  return { ...l, shirt }
}
