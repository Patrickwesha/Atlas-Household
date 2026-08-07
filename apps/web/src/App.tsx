import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Avatar, AvatarRing } from './Avatar'
import { GREEN, tint } from './colors'
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
  type Household,
  type Instance,
  type Member,
} from './api'

const POLL_MS = 60_000
/** Back to the family screen after a minute untouched. Deliberately not 30s:
 *  someone reading their list should not get bounced mid-read. */
const IDLE_MS = 60_000
const TOAST_MS = 8_000

type ToastKind = 'done' | 'reopened' | 'error'

interface Toast {
  kind: ToastKind
  title: string
  instanceId: string
  memberId: string
}

export default function App() {
  const [hasToken, setHasToken] = useState<boolean>(() => getToken() !== null)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<number | null>(null)

  const showToast = useCallback((next: Toast) => {
    setToast(next)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  const refresh = useCallback(async () => {
    try {
      const b = await getBoard()
      setBoard(b)
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

  // A list left open on the wall goes back to the family screen on its own, so
  // the next kid always walks up to the same starting screen.
  useEffect(() => {
    if (selectedId === null) return
    let timer = 0
    const goHome = () => {
      setSelectedId(null)
      setToast(null)
    }
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(goHome, IDLE_MS)
    }
    reset()
    window.addEventListener('pointerdown', reset)
    window.addEventListener('keydown', reset)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [selectedId])

  // Optimistic: update immediately on tap (kids re-tap dead UI), reconcile with
  // the server's row, and roll back visibly if the call fails.
  const toggle = useCallback(
    async (instance: Instance, member: Member) => {
      const wasDone = instance.completed_at !== null
      const optimistic: Instance = wasDone
        ? { ...instance, completed_at: null, completed_by: null }
        : { ...instance, completed_at: new Date().toISOString(), completed_by: member.id }

      const patch = (next: Instance) => (cur: Board | null) =>
        cur ? { ...cur, instances: cur.instances.map((i) => (i.id === next.id ? next : i)) } : cur

      setBoard(patch(optimistic))
      showToast({
        kind: wasDone ? 'reopened' : 'done',
        title: instance.title,
        instanceId: instance.id,
        memberId: member.id,
      })
      try {
        const updated = wasDone
          ? await uncompleteInstance(instance.id)
          : await completeInstance(instance.id, member.id)
        setBoard(patch(updated))
      } catch {
        // Roll the row back AND retract the toast's claim — a toast that still
        // said "done" over a reverted row would be a lie on the wall.
        setBoard(patch(instance))
        showToast({
          kind: 'error',
          title: instance.title,
          instanceId: instance.id,
          memberId: member.id,
        })
      }
    },
    [showToast],
  )

  // Undo acts on the row as it is NOW, not as it was when the toast appeared,
  // so a tap that lands after a poll or a second tap still does the right thing.
  const handleUndo = useCallback(() => {
    if (toast === null || toast.kind === 'error' || board === null) return
    const instance = board.instances.find((i) => i.id === toast.instanceId)
    const member = board.members.find((m) => m.id === toast.memberId)
    if (instance === undefined || member === undefined) return
    setToast(null)
    void toggle(instance, member)
  }, [toast, board, toggle])

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
          <p className="card-body">{error}</p>
          <button className="big-btn" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </Centered>
    ) : (
      <Centered>
        <div className="card">
          <p className="card-body">Loading…</p>
        </div>
      </Centered>
    )
  }

  const selectedIndex = selectedId ? board.members.findIndex((m) => m.id === selectedId) : -1
  const selected = selectedIndex >= 0 ? board.members[selectedIndex] : null

  return (
    <div className="screen">
      {error && (
        <div className="offline-banner" role="alert">
          ⚠ {error} Showing the last board that loaded.
        </div>
      )}
      {selected ? (
        <MemberChores
          member={selected}
          variant={selectedIndex}
          chores={board.instances.filter((i) => i.assignee_id === selected.id)}
          onBack={() => setSelectedId(null)}
          onToggle={(instance) => void toggle(instance, selected)}
        />
      ) : (
        <MemberTiles
          household={board.household}
          members={board.members}
          instances={board.instances}
          onSelect={(m) => setSelectedId(m.id)}
        />
      )}
      {toast && <ToastBar toast={toast} onUndo={handleUndo} onDismiss={() => setToast(null)} />}
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="screen center">{children}</div>
}

/** The wall clock, on the DEVICE's local time. The board's notion of "today"
 *  is resolved server-side in APP_TIMEZONE; this is the iPad's own clock. */
function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const d = new Date()
      setNow(d)
      // Re-arm on the next minute boundary rather than running a 1Hz render
      // loop for a display that only shows hours and minutes.
      timer = window.setTimeout(tick, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()))
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div className="clock">
      <span className="clock-time">
        {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </span>
      <span className="clock-date">
        {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
      </span>
    </div>
  )
}

/**
 * A static schedule reminder, not a chore. There is no chore_instance behind it
 * and nothing to complete, so it carries no checkbox, no count, and no tap
 * target — it states when the family reset happens and nothing more.
 */
function FamilyResetStrip() {
  return (
    <div className="reset-strip">
      <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" className="reset-icon">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12 7v5.2l3.4 2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="reset-time">8:00 PM</span>
      <span className="reset-text">
        <strong>Family Reset</strong> — everyone tidies the common rooms together.
      </span>
      <span className="reset-tag">Every night</span>
    </div>
  )
}

function TokenSetup({ onSaved }: { onSaved: (token: string) => void }) {
  const [value, setValue] = useState('')
  const trimmed = value.trim()
  return (
    <Centered>
      <div className="card setup-card">
        <h1>Set up this device</h1>
        <p className="card-body">Paste the device token to connect this kiosk.</p>
        <input
          className="token-input"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Device token"
          autoFocus
        />
        <button
          className="big-btn"
          disabled={trimmed.length === 0}
          onClick={() => onSaved(trimmed)}
        >
          Connect
        </button>
      </div>
    </Centered>
  )
}

function MemberTiles({
  household,
  members,
  instances,
  onSelect,
}: {
  household: Household
  members: Member[]
  instances: Instance[]
  onSelect: (m: Member) => void
}) {
  return (
    <div className="sheet">
      <header className="top-bar">
        <h1 className="household">{household.name}</h1>
        <Clock />
      </header>

      <div className="tiles">
        {members.map((m, index) => {
          const mine = instances.filter((i) => i.assignee_id === m.id)
          const total = mine.length
          const done = mine.filter((i) => i.completed_at !== null).length
          const remaining = total - done
          const complete = total > 0 && remaining === 0

          // A dependent cannot complete a chore — the API refuses it — so the
          // kiosk must never offer the tap. Face and name only: present on the
          // board, with no count to imply an assignment that cannot exist.
          if (m.role === 'dependent') {
            return (
              <div className="tile tile-static" key={m.id}>
                <Avatar color={m.color} variant={index} className="avatar avatar-tile" />
                <span className="tile-name">{m.name}</span>
              </div>
            )
          }

          // Only "done" is allowed to paint a tile green. A member whose own
          // colour is green would otherwise look finished all day, so an
          // unfinished tile stays neutral and wears its colour on the border,
          // the ring, and the face.
          return (
            <button
              key={m.id}
              className={`tile${complete ? ' tile-complete' : ''}`}
              style={complete ? undefined : { borderColor: tint(m.color, 0.45) }}
              onClick={() => onSelect(m)}
            >
              <AvatarRing color={m.color} variant={index} done={done} total={total} />
              <span className="tile-name">{m.name}</span>
              {total === 0 ? (
                <span className="pill pill-neutral">Nothing today</span>
              ) : complete ? (
                <span className="pill pill-done">All done</span>
              ) : (
                <span className="pill pill-todo">
                  {remaining} to do
                </span>
              )}
            </button>
          )
        })}
      </div>

      <FamilyResetStrip />
    </div>
  )
}

function MemberChores({
  member,
  variant,
  chores,
  onBack,
  onToggle,
}: {
  member: Member
  variant: number
  chores: Instance[]
  onBack: () => void
  onToggle: (instance: Instance) => void
}) {
  const total = chores.length
  const done = chores.filter((c) => c.completed_at !== null).length
  const complete = total > 0 && done === total

  return (
    <div className="sheet">
      <header className="chores-header">
        <button className="back-btn" onClick={onBack}>
          <span aria-hidden="true">‹</span> Back
        </button>
        <Avatar color={member.color} variant={variant} className="avatar avatar-head" />
        <h1 className="chores-name">{member.name}</h1>
        <Clock />
      </header>

      {total > 0 && (
        <div className="progress">
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: `${(done / total) * 100}%`,
                background: complete ? GREEN : member.color,
              }}
            />
          </div>
          <span className="progress-label">
            {done} of {total} done
          </span>
        </div>
      )}

      {total === 0 ? (
        <p className="big-empty">No chores today 🎉</p>
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
                    {isDone && (
                      <svg viewBox="0 0 24 24" width="60%" height="60%">
                        <path
                          d="M5 13l4.5 4.5L19 7"
                          fill="none"
                          stroke="#fff"
                          strokeWidth="3.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </span>
                  <span className="chore-title">{c.title}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
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
  if (toast.kind === 'error') {
    return (
      <div className={`toast toast-error`} role="alert">
        <span className="toast-text">Couldn't save “{toast.title}”. Try tapping it again.</span>
        <button className="toast-btn" onClick={onDismiss}>
          OK
        </button>
      </div>
    )
  }
  return (
    <div className="toast" role="status">
      <span className="toast-text">
        {toast.kind === 'done' ? `Nice! ${toast.title}` : `${toast.title} — back on the list`}
      </span>
      <button className="toast-btn" onClick={onUndo}>
        Undo
      </button>
    </div>
  )
}
