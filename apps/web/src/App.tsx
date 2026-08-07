import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ApiError,
  NetworkError,
  clearToken,
  completeInstance,
  getBoard,
  getToken,
  setToken,
  uncompleteInstance,
  type Board,
  type Instance,
  type Member,
} from './api'
import { Avatar } from './avatars'
import { accentOnWhite, countsFor, pickInk } from './ink'

const POLL_MS = 60_000
// 60s, not 30: someone still reading their list shouldn't get bounced away.
const IDLE_MS = 60_000
const IDLE_TICK_MS = 5_000
const TOAST_MS = 6_000

// A static schedule display, not a completion claim. The board has no idea
// whether this actually happened, so it gets no checkbox, no tap target, and
// no done state — anything else would be the board asserting something it
// cannot know.
const FAMILY_RESET_TIME = '8:00 PM'

// Module scope: building an Intl formatter is expensive and these must not be
// reconstructed on every clock tick.
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
})

type Toast =
  | { kind: 'done'; instanceId: string; memberId: string; title: string }
  | { kind: 'failed'; title: string }

export default function App() {
  const [hasToken, setHasToken] = useState<boolean>(() => getToken() !== null)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)

  // One promise chain per instance id. An entry exists for as long as any tap
  // on that row is queued or in flight, which makes it double duty: it
  // serializes the calls, and it tells `refresh` which rows a poll must not
  // overwrite.
  const chains = useRef(new Map<string, Promise<void>>())

  const refresh = useCallback(async () => {
    try {
      const fresh = await getBoard()
      setBoard((cur) => {
        if (cur === null || chains.current.size === 0) return fresh
        // A poll landing mid-tap must not clobber the optimistic row, or the
        // checkbox visibly flips back and then forward again under the finger.
        return {
          ...fresh,
          instances: fresh.instances.map((i) => {
            if (!chains.current.has(i.id)) return i
            return cur.instances.find((held) => held.id === i.id) ?? i
          }),
        }
      })
      // The day can roll over under an open Undo. Undoing a chore that is no
      // longer on the board would 404 or, worse, quietly edit yesterday.
      setToast((cur) =>
        cur !== null &&
        cur.kind === 'done' &&
        !fresh.instances.some((i) => i.id === cur.instanceId)
          ? null
          : cur,
      )
      setError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken()
        setHasToken(false)
        return
      }
      setError(
        err instanceof NetworkError
          ? "Can't reach the server."
          : 'Something went wrong loading the board.',
      )
    }
  }, [])

  // Load once, then keep a wall display honest: poll every minute AND refetch on
  // focus / visibility, so 8pm never shows 7am's board.
  useEffect(() => {
    if (!hasToken) return
    void refresh()
    const interval = window.setInterval(() => void refresh(), POLL_MS)
    const onFocus = () => void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [hasToken, refresh])

  const setInstance = useCallback((next: Instance) => {
    setBoard((cur) =>
      cur ? { ...cur, instances: cur.instances.map((i) => (i.id === next.id ? next : i)) } : cur,
    )
  }, [])

  // Optimistic: update immediately on tap (kids re-tap dead UI), reconcile with
  // the server's row, and roll back visibly if the call fails.
  //
  // Calls for one instance run strictly in order. Without that, tapping Undo
  // while a slow complete is still in flight can land the uncomplete first and
  // leave the chore stuck done — which is exactly the moment a kid gives up.
  const toggle = useCallback(
    (instance: Instance, member: Member) => {
      const wasDone = instance.completed_at !== null
      const optimistic: Instance = wasDone
        ? { ...instance, completed_at: null, completed_by: null }
        : { ...instance, completed_at: new Date().toISOString(), completed_by: member.id }

      setInstance(optimistic)
      setToast(
        wasDone
          ? null
          : { kind: 'done', instanceId: instance.id, memberId: member.id, title: instance.title },
      )

      const run = async () => {
        try {
          const updated = wasDone
            ? await uncompleteInstance(instance.id)
            : await completeInstance(instance.id, member.id)
          setInstance(updated)
        } catch (err) {
          // Roll back — and say so out loud. A silent revert on a wall display
          // looks exactly like a tap that worked.
          setInstance(instance)
          if (err instanceof ApiError && err.status === 401) {
            // A revoked token would otherwise roll every tap back forever with
            // nothing on screen explaining why. Same handling as refresh.
            clearToken()
            setHasToken(false)
            return
          }
          setToast({ kind: 'failed', title: instance.title })
        }
      }

      const previous = chains.current.get(instance.id) ?? Promise.resolve()
      const next = previous.then(run, run)
      chains.current.set(instance.id, next)
      void next.finally(() => {
        if (chains.current.get(instance.id) === next) chains.current.delete(instance.id)
      })
    },
    [setInstance],
  )

  const undo = useCallback(() => {
    if (toast === null || toast.kind !== 'done' || board === null) return
    const instance = board.instances.find((i) => i.id === toast.instanceId)
    const member = board.members.find((m) => m.id === toast.memberId)
    setToast(null)
    // Already not done (a poll, or a second Undo) — nothing to send.
    if (!instance || !member || instance.completed_at === null) return
    toggle(instance, member)
  }, [board, toast, toggle])

  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  // Leaving a person's screen retires an Undo whose row is no longer on screen
  // — by Back, by idle, by anything. A failure toast survives on purpose: it
  // explains a count that just moved backwards, which is visible from the
  // family screen too.
  useEffect(() => {
    setToast((cur) => (cur !== null && cur.kind === 'done' ? null : cur))
  }, [selectedId])

  // Idle return to the family screen. The deadline lives in a ref and one slow
  // interval checks it, so a touch costs no re-render — this display stays on
  // for months. Comparing against Date.now() also makes the sleeping-iPad case
  // fall out for free: timers are suspended while asleep, so a board woken
  // after eight hours is already past its deadline and goes home on the next
  // tick, instead of sitting on one kid's list all night.
  const idleUntil = useRef(0)
  useEffect(() => {
    if (selectedId === null) return
    idleUntil.current = Date.now() + IDLE_MS
    const bump = () => {
      idleUntil.current = Date.now() + IDLE_MS
    }
    const check = () => {
      if (Date.now() < idleUntil.current) return
      setSelectedId(null)
    }
    // Capture phase, so a child calling stopPropagation can't starve the reset.
    document.addEventListener('pointerdown', bump, { capture: true, passive: true })
    // A woken iPad is already long past its deadline; don't wait for a tick.
    document.addEventListener('visibilitychange', check)
    const tick = window.setInterval(check, IDLE_TICK_MS)
    return () => {
      document.removeEventListener('pointerdown', bump, { capture: true })
      document.removeEventListener('visibilitychange', check)
      window.clearInterval(tick)
    }
  }, [selectedId])

  if (!hasToken) {
    return (
      <TokenSetup
        onSaved={(t) => {
          setToken(t)
          setBoard(null)
          setError(null)
          setHasToken(true)
        }}
      />
    )
  }

  // No board yet: an explicit error screen (never a blank board that reads as
  // "no chores today") vs. a plain loading state.
  if (board === null) {
    return error ? (
      <Centered>
        <div className="card error-card">
          <h1>Can't load the board</h1>
          <p>{error}</p>
          <button className="big-btn" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </Centered>
    ) : (
      <Centered>
        <p className="muted">Loading…</p>
      </Centered>
    )
  }

  const selected = selectedId ? (board.members.find((m) => m.id === selectedId) ?? null) : null

  return (
    <div className="screen">
      <div className="sheet">
        <header className="sheet-head">
          {selected ? (
            <button className="back-btn" onClick={() => setSelectedId(null)}>
              <span aria-hidden="true">‹</span> Back
            </button>
          ) : (
            <h1 className="sheet-title">{board.household.name}</h1>
          )}
          <div className="when">
            <Clock />
            <span className="when-date">{boardDateLabel(board)}</span>
          </div>
        </header>

        {error && (
          <p className="offline-banner" role="alert">
            ⚠ {error} Showing the last board that loaded.
          </p>
        )}

        {selected ? (
          <PersonView
            member={selected}
            chores={board.instances.filter((i) => i.assignee_id === selected.id)}
            onToggle={(instance) => toggle(instance, selected)}
          />
        ) : (
          <FamilyView
            members={board.members}
            instances={board.instances}
            onSelect={(m) => setSelectedId(m.id)}
          />
        )}
      </div>

      {toast && <ToastBar toast={toast} onUndo={undo} onDismiss={() => setToast(null)} />}
    </div>
  )
}

// The API decides what "today" means in its own timezone (America/Chicago);
// the iPad renders in whatever timezone it is set to. Reading the date off the
// rows themselves means this line can never contradict the chores under it.
//
// Every row on the board satisfies due_on == the server's today by
// construction of the query, so any row's due_on IS the server's date. With no
// rows there is nothing for a date to contradict, so the device's date is safe.
function boardDateLabel(board: Board): string {
  if (board.instances.length === 0) return DATE_FMT.format(new Date())
  const [y, m, d] = board.instances[0].due_on.split('-').map(Number)
  // Must be the 3-arg constructor: new Date('2026-08-07') parses as UTC
  // midnight and renders as the 6th in America/Chicago. One character, wrong
  // date on the kitchen wall, every day.
  return DATE_FMT.format(new Date(y, m - 1, d))
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="screen center">
      <div className="sheet sheet-narrow">{children}</div>
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let boundary = 0
    let interval = 0
    const sync = () => {
      window.clearTimeout(boundary)
      window.clearInterval(interval)
      setNow(new Date())
      // Land on the next minute, then tick once a minute. Ticking seconds would
      // be sixty times the renders for a digit nobody reads from a doorway.
      boundary = window.setTimeout(() => {
        setNow(new Date())
        interval = window.setInterval(() => setNow(new Date()), 60_000)
      }, 60_000 - (Date.now() % 60_000))
    }
    sync()
    // A woken iPad has a stale clock until its next tick — resync at once.
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(boundary)
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return <span className="when-time">{TIME_FMT.format(now)}</span>
}

function TokenSetup({ onSaved }: { onSaved: (token: string) => void }) {
  const [value, setValue] = useState('')
  const trimmed = value.trim()
  return (
    <Centered>
      <div className="card setup-card">
        <h1>Set up this device</h1>
        <p className="muted">Paste the device token to connect this kiosk.</p>
        <input
          className="token-input"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Device token"
          autoFocus
        />
        <button className="big-btn" disabled={trimmed.length === 0} onClick={() => onSaved(trimmed)}>
          Connect
        </button>
      </div>
    </Centered>
  )
}

function Ring({ done, total, color }: { done: number; total: number; color: string }) {
  const radius = 70
  const circumference = 2 * Math.PI * radius
  const filled = total === 0 ? 0 : (done / total) * circumference
  return (
    <svg className="ring" viewBox="0 0 160 160" aria-hidden="true" focusable="false">
      <circle className="ring-track" cx="80" cy="80" r={radius} />
      {/* Nothing done means nothing drawn. A zero-length dash with a round cap
          still paints a dot, and a dot on the ring reads as "a bit of progress"
          — the one thing an empty list must not claim. */}
      {filled > 0 && (
        <circle
          className="ring-fill"
          cx="80"
          cy="80"
          r={radius}
          stroke={color}
          strokeDasharray={`${filled} ${circumference}`}
          transform="rotate(-90 80 80)"
        />
      )}
    </svg>
  )
}

function FamilyView({
  members,
  instances,
  onSelect,
}: {
  members: Member[]
  instances: Instance[]
  onSelect: (m: Member) => void
}) {
  return (
    <>
      <div className="tiles">
        {members.map((m) => {
          const dependent = m.role === 'dependent'
          const { done, total } = countsFor(instances, m.id)
          const remaining = total - done
          const accent = accentOnWhite(m.color)

          return (
            <button
              key={m.id}
              className={`tile${dependent ? ' tile-disabled' : ''}`}
              disabled={dependent}
              onClick={dependent ? undefined : () => onSelect(m)}
            >
              <span className="tile-face">
                {/* A dependent has no chores by rule, so no ring — an empty ring
                    would read as "none done yet" rather than "not applicable". */}
                {!dependent && <Ring done={done} total={total} color={accent} />}
                <Avatar color={m.color} seed={m.id} />
              </span>
              <span className="tile-name">{m.name}</span>
              {dependent ? (
                // No count, deliberately. A dependent cannot be assigned or
                // complete a chore (the API refuses it), so any number here —
                // even "0 to do" — would describe a rule rather than a fact.
                <span className="pill pill-none" aria-hidden="true">
                  —
                </span>
              ) : (
                <span
                  className={`pill${total > 0 && remaining === 0 ? ' pill-done' : ''}`}
                  style={
                    total === 0 || remaining === 0
                      ? undefined
                      : { backgroundColor: accent, color: pickInk(accent) }
                  }
                >
                  {total === 0 ? 'Nothing today' : remaining === 0 ? 'All done' : `${remaining} to do`}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Schedule, not a task. No checkbox, not tappable, no done state. */}
      <p className="reset-strip">
        <span className="reset-clock" aria-hidden="true">
          ⏰
        </span>
        <span>
          <strong>{FAMILY_RESET_TIME}</strong> Family Reset
        </span>
        <span className="reset-note">every night</span>
      </p>
    </>
  )
}

function PersonView({
  member,
  chores,
  onToggle,
}: {
  member: Member
  chores: Instance[]
  onToggle: (instance: Instance) => void
}) {
  const { done, total } = countsFor(chores, member.id)
  const accent = accentOnWhite(member.color)

  return (
    <>
      <div className="person-head">
        <span className="person-face">
          <Avatar color={member.color} seed={member.id} />
        </span>
        <div className="person-meta">
          <h2 className="person-name">{member.name}</h2>
          {total > 0 && (
            <>
              <div className="bar" role="img" aria-label={`${done} of ${total} done`}>
                <div
                  className="bar-fill"
                  style={{ width: `${(done / total) * 100}%`, backgroundColor: accent }}
                />
              </div>
              <p className="person-count">
                {done} of {total} done
              </p>
            </>
          )}
        </div>
      </div>

      {chores.length === 0 ? (
        <p className="muted big-empty">No chores today 🎉</p>
      ) : (
        <ul className="chore-list">
          {chores.map((c) => {
            const isDone = c.completed_at !== null
            return (
              <li key={c.id}>
                <button
                  className={`chore${isDone ? ' chore-done' : ''}`}
                  onClick={() => onToggle(c)}
                >
                  <span className="check" aria-hidden="true">
                    {isDone ? '✓' : ''}
                  </span>
                  <span className="chore-title">{c.title}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function ToastBar({
  toast,
  onUndo,
  onDismiss,
}: {
  toast: Toast
  onUndo: () => void
  onDismiss: () => void
}) {
  if (toast.kind === 'failed') {
    return (
      <div className="toast toast-failed" role="alert">
        <span className="toast-text">
          <strong>Didn't save.</strong> {toast.title} is still to do.
        </span>
        <button className="toast-btn" onClick={onDismiss}>
          OK
        </button>
      </div>
    )
  }
  return (
    <div className="toast" role="status">
      <span className="toast-text">
        <strong>Nice!</strong> {toast.title}
      </span>
      <button className="toast-btn" onClick={onUndo}>
        Undo
      </button>
    </div>
  )
}
