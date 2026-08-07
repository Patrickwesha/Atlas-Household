// Color math for anything drawn from `members.color`.
//
// That column is an arbitrary hex a parent typed in — the schema constrains
// nothing. So every use of it has to earn its own legibility rather than assume
// a curated palette. This board is read from across a kitchen; a pale accent
// simply disappears, and white-on-light text is unreadable at an angle.

import type { Instance } from './api'

const WHITE = '#FFFFFF'
const INK = '#141019'

function toChannel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function parse(hex: string): [number, number, number] {
  const raw = hex.trim().replace('#', '')
  const full =
    raw.length === 3 ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2] : raw.slice(0, 6)
  const n = Number.parseInt(full, 16)
  if (full.length !== 6 || Number.isNaN(n)) return [0, 0, 0]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${((clamp(r) << 16) | (clamp(g) << 8) | clamp(b)).toString(16).padStart(6, '0')}`
}

export function luminance(hex: string): number {
  const [r, g, b] = parse(hex)
  return 0.2126 * toChannel(r) + 0.7152 * toChannel(g) + 0.0722 * toChannel(b)
}

export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// Text color for anything sitting ON `bg`.
//
// Picking the better of white and black is provably safe for every color in
// sRGB: contrast against white is 1.05/(L+0.05) and against black is
// (L+0.05)/0.05, and those curves cross at L=0.1791 where both equal 4.58:1.
// INK is a softer near-black and gives up a little of that margin (worst case
// 4.36:1), so fall through to true black in the narrow band where it matters.
export function pickInk(bg: string): string {
  const best = contrast(bg, WHITE) >= contrast(bg, INK) ? WHITE : INK
  return contrast(bg, best) >= 4.5 ? best : '#000000'
}

// A member's color, darkened until it reads as a shape on the white sheet.
//
// The progress ring and the count pill are non-text graphics, so 3:1 is the
// bar. Without this a parent picking a pale yellow gets an invisible ring and
// a pill with no edge — the tile silently stops communicating.
export function accentOnWhite(hex: string, min = 3): string {
  let [r, g, b] = parse(hex)
  let out = toHex(r, g, b)
  for (let i = 0; i < 40 && contrast(out, WHITE) < min; i++) {
    r *= 0.92
    g *= 0.92
    b *= 0.92
    out = toHex(r, g, b)
  }
  return out
}

// A darker cut of the same hue.
//
// Used for avatar hair, which has two jobs at once: separate from the face, and
// stay visible against the white sheet. Halving each channel does both for any
// input — it is always darker than the face, so wherever the face reads, the
// hair reads.
export function shade(hex: string, factor = 0.5): string {
  const [r, g, b] = parse(hex)
  return toHex(r * factor, g * factor, b * factor)
}

export interface Counts {
  done: number
  total: number
}

// Today's done/total for one person. The board is a flat list — the API sends
// no counts — so the ring and the bar are both derived right here.
export function countsFor(instances: Instance[], memberId: string): Counts {
  let done = 0
  let total = 0
  for (const i of instances) {
    if (i.assignee_id !== memberId) continue
    total++
    if (i.completed_at !== null) done++
  }
  return { done, total }
}
