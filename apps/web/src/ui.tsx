// Presentational pieces for the kiosk: progress ring, progress bar, the undo
// toast, the clock/date header, and the evening reset strip.
//
// Everything here renders from data the board endpoint already returns. Nothing
// in this file implies a fact the API cannot back — no due times, no escalation
// copy, no completion state on the reset strip.

import { useEffect } from 'react'
import { Avatar } from './avatars'
import { onWhite } from './colors'
import { kioskDate, kioskTime, useNow } from './hooks'

const DONE_GREEN = '#15803D'
const TRACK = '#E5E7EB'

// Fixed internal coordinate system; the rendered size comes from CSS, so the
// ring scales with the tile instead of pinning the layout to a pixel count.
const RING_STROKE = 8
const RING_RADIUS = (100 - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** Avatar with a today's-progress ring around it. */
export function AvatarRing({
  id,
  color,
  done,
  total,
}: {
  id: string
  color: string
  done: number
  total: number
}) {
  const complete = total > 0 && done >= total
  const fraction = total > 0 ? Math.min(1, done / total) : 0

  return (
    <div className="ring">
      <svg className="ring-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle
          cx="50"
          cy="50"
          r={RING_RADIUS}
          fill="none"
          stroke={TRACK}
          strokeWidth={RING_STROKE}
        />
        {/* Only when there is real progress. A zero-length arc with a round
            cap still paints a dot, which reads as "started" on a board where
            nothing has been done — the ring would be lying. */}
        {fraction > 0 && (
          <circle
            cx="50"
            cy="50"
            r={RING_RADIUS}
            fill="none"
            stroke={complete ? DONE_GREEN : onWhite(color, 3)}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={`${RING_CIRCUMFERENCE * fraction} ${RING_CIRCUMFERENCE}`}
            transform="rotate(-90 50 50)"
          />
        )}
      </svg>
      <div className="ring-inner">
        <Avatar id={id} color={color} />
      </div>
    </div>
  )
}

/** Today's progress as a bar. Same numbers as the ring, on the person screen. */
export function ProgressBar({
  done,
  total,
  color,
}: {
  done: number
  total: number
  color: string
}) {
  const complete = total > 0 && done >= total
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0
  return (
    <div className="progress">
      <div className="progress-track">
        <div
          className="progress-fill"
          style={{
            width: `${percent}%`,
            backgroundColor: complete ? DONE_GREEN : onWhite(color, 3),
          }}
        />
      </div>
      <span className="progress-label">
        {total === 0 ? 'Nothing today' : `${done} of ${total} done`}
      </span>
    </div>
  )
}

/**
 * Confirmation of a completed chore, with a way back.
 *
 * The undo path is the existing uncomplete endpoint — this toast does not
 * invent state. Given a fresh `key` by the caller on each completion, so a
 * second completion restarts the timer rather than inheriting the old one.
 */
export function Toast({
  title,
  onUndo,
  onDismiss,
  ms,
}: {
  title: string
  onUndo: () => void
  onDismiss: () => void
  ms: number
}) {
  useEffect(() => {
    const id = window.setTimeout(onDismiss, ms)
    return () => window.clearTimeout(id)
    // onDismiss is stable (useCallback in App); remounting via key restarts this.
  }, [ms, onDismiss])

  return (
    <div className="toast" role="status">
      <span className="toast-check" aria-hidden="true">
        ✓
      </span>
      <span className="toast-text">
        Nice! <strong>{title}</strong> is done.
      </span>
      <button className="toast-undo" onClick={onUndo}>
        Undo
      </button>
    </div>
  )
}

/**
 * Clock and date.
 *
 * Both formatted in the kiosk timezone (see hooks.ts) rather than the device's,
 * so the date printed here is the same date the board was built for.
 */
export function ClockHeader({ householdName }: { householdName: string }) {
  const now = useNow(1000)
  return (
    <header className="clock">
      <div className="clock-left">
        <div className="clock-time">{kioskTime(now)}</div>
        <div className="clock-date">{kioskDate(now)}</div>
      </div>
      <div className="clock-household">{householdName}</div>
    </header>
  )
}

/**
 * The evening reset.
 *
 * A STATIC schedule display: it states when the family reset happens, and
 * nothing else. No checkbox, no completed state, no claim that it happened —
 * there is no row behind it and nothing would record one.
 */
export function ResetStrip() {
  return (
    <div className="reset-strip">
      <span className="reset-dot" aria-hidden="true" />
      <span>
        <strong>Family reset</strong> · every night at 8:00 PM
      </span>
    </div>
  )
}
