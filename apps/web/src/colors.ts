// Colour maths for the kiosk palette.
//
// Member colours arrive from the database as arbitrary hex, so nothing in here
// may assume a well-formed — or a dark — value. Every function degrades to a
// sane default rather than rendering an invisible tile on the wall iPad.

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Used when a member's colour is missing or malformed. Matches the shell. */
const FALLBACK: Rgb = { r: 109, g: 40, b: 217 }

/** The darkest ink in the palette. ~16:1 on white — readable from six feet. */
export const INK = '#1f1436'
/** "Done" green. 5.0:1 against white text, 4.6:1 as text on white. */
export const GREEN = '#15803d'

export function parseHex(hex: string): Rgb {
  const raw = hex.trim().replace(/^#/, '')
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  if (!/^[0-9a-f]{6}$/i.test(full)) return FALLBACK
  const n = Number.parseInt(full, 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

function toHex(c: Rgb): string {
  const part = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(c.r)}${part(c.g)}${part(c.b)}`
}

/** Blend `hex` toward `toward`. amount 0 = unchanged, 1 = fully `toward`. */
export function mix(hex: string, toward: string, amount: number): string {
  const a = parseHex(hex)
  const b = parseHex(toward)
  const t = Math.min(1, Math.max(0, amount))
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  })
}

export function tint(hex: string, amount: number): string {
  return mix(hex, '#ffffff', amount)
}

export function shade(hex: string, amount: number): string {
  return mix(hex, '#000000', amount)
}

function channel(value: number): number {
  const s = value / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return la >= lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05)
}

/**
 * Whichever of white / INK reads better on `background`. Seed colours are
 * chosen by a human and could be pale yellow just as easily as navy; picking
 * the foreground by measurement is the only way the label stays legible.
 */
export function inkOn(background: string): string {
  return contrastRatio('#ffffff', background) >= contrastRatio(INK, background) ? '#ffffff' : INK
}
