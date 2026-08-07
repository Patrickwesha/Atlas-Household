// Color math for tiles and pills.
//
// Member colors come out of the database (`members.color`), so nothing here may
// assume a fixed palette — a future seed could hand us `#FFE066` and a hardcoded
// white-on-color pill would become unreadable. Every foreground color on this
// screen is therefore *computed* against its actual background, to a measured
// WCAG ratio, rather than picked by eye.
//
// This is the "reads from six feet, at an angle" requirement expressed as code:
// it holds for colors nobody has seeded yet.

const NEAR_BLACK = '#111827'
const WHITE = '#FFFFFF'

/** Parse `#rgb` or `#rrggbb` into 0-255 channels. Null on anything else. */
export function parseHex(hex: string): [number, number, number] | null {
  const raw = hex.trim().replace(/^#/, '')
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function toHex(channels: [number, number, number]): string {
  return (
    '#' +
    channels
      .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio between two colors. 1 (identical) to 21 (black/white). */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return 1
  const la = relativeLuminance(ca)
  const lb = relativeLuminance(cb)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Near-black or white — whichever has more contrast against `background`.
 * Used for text sitting on a member's own color (the count pill).
 */
export function readableOn(background: string): string {
  return contrastRatio(NEAR_BLACK, background) >= contrastRatio(WHITE, background)
    ? NEAR_BLACK
    : WHITE
}

/**
 * A member's color, darkened just enough to clear `min` contrast against white.
 *
 * The person screen puts the member's name in their own color on the white
 * sheet. A light seed color (yellow, mint) would fail badly there, so we walk
 * the channels down — preserving hue — until the ratio is met.
 */
export function onWhite(color: string, min = 4.5): string {
  const rgb = parseHex(color)
  if (!rgb) return NEAR_BLACK
  let current: [number, number, number] = [...rgb]
  for (let i = 0; i < 60 && contrastRatio(toHex(current), WHITE) < min; i++) {
    current = [current[0] * 0.94, current[1] * 0.94, current[2] * 0.94]
  }
  return toHex(current)
}

/** Same color at a given alpha — for soft accent fills behind an avatar. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color)
  if (!rgb) return `rgba(0, 0, 0, ${alpha})`
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}
