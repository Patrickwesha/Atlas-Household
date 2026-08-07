// Clock and date for the kiosk header.
//
// Everything here is pinned to APP_TIMEZONE, deliberately. The board's "today"
// is resolved SERVER-side in APP_TIMEZONE (see apps/api/app/routes.py `_today`),
// so if the header used the iPad's own timezone the two could disagree — the
// header would read one date while the chore list below it was for another.
// Pinning both to the same zone makes that impossible.
//
// This mirrors the API's APP_TIMEZONE default. It is not a secret (it is in the
// committed .env.example); it is a display constant. If the family ever moves,
// this and the API's APP_TIMEZONE change together.
export const APP_TIMEZONE = 'America/Chicago'

// The nightly family reset, shown as a schedule. 20:00 = 8:00 PM.
// A display of when it happens — the app makes no claim that it was done.
const RESET_HOUR = 20

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
})

const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIMEZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

// en-CA gives an ISO-shaped YYYY-MM-DD, which sorts and compares cleanly.
const keyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const hourMinuteFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: false,
})

/** "9:41 AM" */
export function formatClock(now: Date): string {
  return timeFmt.format(now)
}

/** "Friday, August 7" */
export function formatDate(now: Date): string {
  return dateFmt.format(now)
}

/** "2026-08-07" in APP_TIMEZONE — the same calendar day the API means by
 *  "today". Used to notice a midnight rollover. */
export function dateKey(now: Date): string {
  return keyFmt.format(now)
}

/** Wall-clock minutes since midnight in APP_TIMEZONE.
 *
 *  Read out of the formatter rather than computed with arithmetic on purpose:
 *  it is the wall clock the family reads, so DST transitions need no special
 *  case — on the spring-forward day 2am simply never appears. */
function minutesSinceMidnight(now: Date): number {
  const parts = hourMinuteFmt.formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  // hour12:false can render midnight as 24 in some engines; normalise it.
  return (hour % 24) * 60 + minute
}

/** Schedule text for the nightly reset strip: "in 3h 12m" / "Starting now" /
 *  "Tomorrow 8:00 PM". Describes the schedule only — never whether it was done. */
export function resetLabel(now: Date): string {
  const diff = RESET_HOUR * 60 - minutesSinceMidnight(now)
  if (diff > 15) {
    const h = Math.floor(diff / 60)
    const m = diff % 60
    return `in ${h ? `${h}h ` : ''}${m}m`
  }
  if (diff > -15) return 'Starting now'
  return 'Tomorrow 8:00 PM'
}
