// Time and idle behavior for the kiosk.
//
// TIMEZONE, and why it is hardcoded here:
//
// The board's "today" is resolved SERVER-side, in the API's APP_TIMEZONE
// (apps/api/app/config.py — defaults to America/Chicago; see routes.py `_today`).
// The iPad's clock is device-local. If this screen formatted the date with the
// device's zone, it could print a date the board was never for — a wall display
// confidently mislabeling which day's chores it is showing.
//
// CLAUDE.md permits exactly one VITE_ variable (VITE_API_BASE_URL), so this
// cannot be configured from the environment. It is a constant instead, and it
// MUST be kept equal to the API's APP_TIMEZONE. If you change one, change both.

import { useEffect, useRef, useState } from 'react'

export const KIOSK_TZ = 'America/Chicago'

// en-CA gives YYYY-MM-DD, which sorts and compares as a plain string.
const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: KIOSK_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: KIOSK_TZ,
  hour: 'numeric',
  minute: '2-digit',
})
const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: KIOSK_TZ,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

/** The kiosk's calendar day as YYYY-MM-DD — the same day the API means. */
export function kioskDayKey(at: Date): string {
  return dayKeyFormat.format(at)
}
export function kioskTime(at: Date): string {
  return timeFormat.format(at)
}
export function kioskDate(at: Date): string {
  return dateFormat.format(at)
}

/** A Date that re-renders its consumer on an interval. Keep it low in the tree. */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/**
 * Fire `onFlip` when the kiosk's calendar day changes while the app is open.
 *
 * Polling alone would leave up to a full poll interval where the header says
 * one day and the board holds another's chores. Checked every 10s: cheap, and
 * bounds the disagreement to ten seconds instead of a minute.
 */
export function useDayFlip(onFlip: () => void): void {
  const latest = useRef(onFlip)
  useEffect(() => {
    latest.current = onFlip
  }, [onFlip])

  useEffect(() => {
    let lastSeen = kioskDayKey(new Date())
    const id = window.setInterval(() => {
      const current = kioskDayKey(new Date())
      if (current !== lastSeen) {
        lastSeen = current
        latest.current()
      }
    }, 10_000)
    return () => window.clearInterval(id)
  }, [])
}

/**
 * Call `onIdle` after `ms` without a touch. Armed only while `enabled`.
 *
 * 60 seconds, not 30: someone reading down a list of chores should not get
 * bounced back to the family screen mid-read.
 */
export function useIdleReset(enabled: boolean, ms: number, onIdle: () => void): void {
  const latest = useRef(onIdle)
  useEffect(() => {
    latest.current = onIdle
  }, [onIdle])

  useEffect(() => {
    if (!enabled) return
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => latest.current(), ms)
    }
    arm()
    const events = ['pointerdown', 'keydown', 'touchstart'] as const
    for (const event of events) {
      window.addEventListener(event, arm, { passive: true })
    }
    return () => {
      window.clearTimeout(timer)
      for (const event of events) {
        window.removeEventListener(event, arm)
      }
    }
  }, [enabled, ms])
}
