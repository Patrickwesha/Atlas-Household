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
import { avatarFor } from './avatar-looks'
import { Avatar } from './avatars'
import { dateKey, formatClock, formatDate, resetLabel } from './clock'

const POLL_MS = 60_000
// Back to the family screen after a minute of nothing. Deliberately not the
// prototype's 30s: someone standing there reading their list should not get
// bounced mid-read.
const IDLE_MS = 60_000
// Long enough for a kid with wet hands to notice the toast and reach Undo.
const TOAST_MS = 6_000
// The clock only shows hours and minutes, so a 10s tick is plenty.
const TICK_MS = 10_000

interface ToastState {
  instanceId: string
  title: string
}

interface Stats {
  total: number
  done: number
  pct: number
}

function statsFor(instances: Instance[], memberId: string): Stats {
  const mine = instances.filter((i) => i.assignee_id === memberId)
  const done = mine.filter((i) => i.completed_at !== null).length
  return {
    total: mine.length,
    done,
    pct: mine.length === 0 ? 0 : Math.round((done / mine.length) * 100),
  }
}

export default function App() {
  const [hasToken, setHasToken] = useState<boolean>(() => getToken() !== null)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [now, setNow] = useState<Date>(() => new Date())
  const [toast, setToast] = useState<ToastState | null>(null)

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

  // Header clock.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  // Midnight rollover. The header date is computed in the same timezone the API
  // resolves "today" in, so when the date string changes the board the server
  // would return has changed too — refetch immediately rather than showing
  // tomorrow's date beside today's chores until the next poll.
  const todayKey = dateKey(now)
  const lastKey = useRef(todayKey)
  useEffect(() => {
    if (lastKey.current === todayKey) return
    lastKey.current = todayKey
    if (hasToken) void refresh()
  }, [todayKey, hasToken, refresh])

  // Idle: return to the family screen so the next kid never walks up to someone
  // else's list. Person screen only — the family screen is the resting state.
  useEffect(() => {
    if (selectedId === null) return
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setSelectedId(null), IDLE_MS)
    }
    arm()
    const events = ['pointerdown', 'touchstart', 'keydown'] as const
    for (const e of events) window.addEventListener(e, arm, { passive: true })
    return () => {
      window.clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, arm)
    }
  }, [selectedId])

  // Auto-dismiss the toast.
  useEffect(() => {
    if (toast === null) return
    const id = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [toast])

  const applyInstance = useCallback((updated: Instance) => {
    setBoard((cur) =>
      cur
        ? { ...cur, instances: cur.instances.map((i) => (i.id === updated.id ? updated : i)) }
        : cur,
    )
  }, [])

  // Optimistic: update immediately on tap (kids re-tap dead UI), reconcile with
  // the server's row, and roll back visibly if the call fails.
  const toggle = useCallback(
    async (instance: Instance, member: Member) => {
      const wasDone = instance.completed_at !== null
      applyInstance(
        wasDone
          ? { ...instance, completed_at: null, completed_by: null }
          : { ...instance, completed_at: new Date().toISOString(), completed_by: member.id },
      )
      try {
        const updated = wasDone
          ? await uncompleteInstance(instance.id)
          : await completeInstance(instance.id, member.id)
        applyInstance(updated)
        // Only confirm once the server has actually taken it — the row already
        // went green on tap, so the toast is the honest part.
        if (wasDone) {
          setToast((t) => (t?.instanceId === instance.id ? null : t))
        } else {
          setToast({ instanceId: updated.id, title: updated.title })
        }
      } catch {
        applyInstance(instance)
      }
    },
    [applyInstance],
  )

  const undo = useCallback(
    async (instance: Instance) => {
      setToast(null)
      applyInstance({ ...instance, completed_at: null, completed_by: null })
      try {
        applyInstance(await uncompleteInstance(instance.id))
      } catch {
        applyInstance(instance)
      }
    },
    [applyInstance],
  )

  if (!hasToken) {
    return (
      <Shell>
        <TokenSetup
          onSaved={(t) => {
            setToken(t)
            setBoard(null)
            setError(null)
            setHasToken(true)
          }}
        />
      </Shell>
    )
  }

  // No board yet: an explicit error screen (never a blank board that reads as
  // "no chores today") vs. a plain loading state.
  if (board === null) {
    return (
      <Shell>
        {error ? (
          <div className="center">
            <div className="card error-card">
              <h1>Can't load the board</h1>
              <p>{error}</p>
              <button className="big-btn" onClick={() => void refresh()}>
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div className="center">
            <p className="loading">Loading…</p>
          </div>
        )}
      </Shell>
    )
  }

  const selected = selectedId ? board.members.find((m) => m.id === selectedId) ?? null : null
  const toastInstance = toast
    ? board.instances.find((i) => i.id === toast.instanceId) ?? null
    : null

  return (
    <>
      {error && (
        <div className="offline-banner" role="alert">
          ⚠ {error} Showing the last board that loaded.
        </div>
      )}
      <Shell>
        {selected ? (
          <PersonScreen
            member={selected}
            index={board.members.indexOf(selected)}
            chores={board.instances.filter((i) => i.assignee_id === selected.id)}
            onBack={() => setSelectedId(null)}
            onToggle={(instance) => void toggle(instance, selected)}
          />
        ) : (
          <FamilyScreen
            board={board}
            now={now}
            onSelect={(m) => setSelectedId(m.id)}
          />
        )}
      </Shell>
      <Toast
        toast={toast}
        canUndo={toastInstance !== null && toastInstance.completed_at !== null}
        onUndo={() => {
          if (toastInstance) void undo(toastInstance)
        }}
      />
    </>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="kiosk">{children}</div>
}

function TokenSetup({ onSaved }: { onSaved: (token: string) => void }) {
  const [value, setValue] = useState('')
  const trimmed = value.trim()
  return (
    <div className="center">
      <div className="card">
        <h1>Set up this device</h1>
        <p>Paste the device token to connect this kiosk.</p>
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
    </div>
  )
}

function FamilyScreen({
  board,
  now,
  onSelect,
}: {
  board: Board
  now: Date
  onSelect: (m: Member) => void
}) {
  return (
    <div className="screen">
      <div className="head">
        <div>
          <h1>{board.household.name}</h1>
          <div className="sub">{formatDate(now)}</div>
        </div>
        <div className="right">
          <div className="clock">{formatClock(now)}</div>
        </div>
      </div>

      <div className="people">
        {board.members.map((m, i) => (
          <PersonCard
            key={m.id}
            member={m}
            index={i}
            stats={statsFor(board.instances, m.id)}
            onSelect={onSelect}
          />
        ))}
      </div>

      {/* Schedule display only. It says WHEN the reset is, never that it was
          done — there is no completion to record, so there is no checkbox. */}
      <div className="sheet">
        <div className="strip">
          <div className="bell" aria-hidden="true">
            🧹
          </div>
          <div>
            <div className="t">15-minute family reset</div>
            <div className="s">Everyone, every night at 8:00 PM</div>
          </div>
          <div className="cd">{resetLabel(now)}</div>
        </div>
      </div>
    </div>
  )
}

function countLabel(stats: Stats): string {
  // A member with nothing assigned has not "finished" anything — saying
  // "All done" for an empty list would be a small lie on the wall.
  if (stats.total === 0) return 'Nothing today'
  if (stats.done === stats.total) return 'All done ✓'
  return `${stats.done} of ${stats.total} done`
}

function PersonCard({
  member,
  index,
  stats,
  onSelect,
}: {
  member: Member
  index: number
  stats: Stats
  onSelect: (m: Member) => void
}) {
  const look = avatarFor(index, member.color)

  // The dependent is not a button at all. The API refuses to record a
  // completion by a dependent, so the kiosk must not offer the tap: a face and
  // a name, no count, nothing to press.
  if (member.role === 'dependent') {
    return (
      <div className="pcard pcard-static">
        <div className="ring ring-none">
          <div className="inner">
            <Avatar look={look} />
          </div>
        </div>
        <div className="nm">{member.name}</div>
      </div>
    )
  }

  return (
    <button
      className={`pcard${stats.total > 0 && stats.done === stats.total ? ' clear' : ''}`}
      onClick={() => onSelect(member)}
      aria-label={`${member.name}, ${countLabel(stats)}`}
    >
      <div className="ring" style={{ ['--p' as string]: stats.pct }}>
        <div className="inner">
          <Avatar look={look} />
        </div>
      </div>
      <div className="nm">{member.name}</div>
      <div className="cnt">{countLabel(stats)}</div>
    </button>
  )
}

function PersonScreen({
  member,
  index,
  chores,
  onBack,
  onToggle,
}: {
  member: Member
  index: number
  chores: Instance[]
  onBack: () => void
  onToggle: (instance: Instance) => void
}) {
  const done = chores.filter((c) => c.completed_at !== null).length
  const pct = chores.length === 0 ? 0 : Math.round((done / chores.length) * 100)

  return (
    <div className="screen">
      <div className="head">
        <button className="back" onClick={onBack} aria-label="Back to the family">
          ←
        </button>
        <div className="phead-av">
          <Avatar look={avatarFor(index, member.color)} />
        </div>
        <div>
          <h1>{member.name}</h1>
          <div className="sub">
            {done} of {chores.length} {chores.length === 1 ? 'task' : 'tasks'} done
          </div>
          <div className="bar">
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <div className="sheet grow">
        {chores.length === 0 ? (
          <p className="big-empty">No chores today 🎉</p>
        ) : (
          // Server order (by title) is kept even as rows are completed. Rows must
          // never reshuffle under a finger mid-tap.
          <ul className="list">
            {chores.map((c) => {
              const isDone = c.completed_at !== null
              return (
                <li key={c.id} className={`task${isDone ? ' done' : ''}`}>
                  <button className="trow" onClick={() => onToggle(c)}>
                    <span className="check">{isDone ? '✓' : ''}</span>
                    <span>
                      <span className="ttl">{c.title}</span>
                      {isDone && <span className="note">Done ✓</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function Toast({
  toast,
  canUndo,
  onUndo,
}: {
  toast: ToastState | null
  canUndo: boolean
  onUndo: () => void
}) {
  return (
    <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
      <span className="toast-text">{toast ? `${toast.title} — done` : ''}</span>
      {canUndo && <button onClick={onUndo}>Undo</button>}
    </div>
  )
}
