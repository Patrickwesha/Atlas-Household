import { useCallback, useEffect, useState, type ReactNode } from 'react'
import Avatar from './Avatar'
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

const POLL_MS = 60_000
/** Back to the family screen after this long untouched. 60s, not 30s: someone
 *  reading a task list should not get bounced out mid-read. */
const IDLE_MS = 60_000
const TOAST_MS = 7_000

export default function App() {
  const [hasToken, setHasToken] = useState<boolean>(() => getToken() !== null)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ instanceId: string; title: string; member: Member } | null>(
    null,
  )
  const clock = useClock()

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

  // Idle: only ever armed while a person's list is open. Any touch restarts it.
  useEffect(() => {
    if (selectedId === null) return
    let timer = 0
    const goHome = () => {
      setSelectedId(null)
      setToast(null)
    }
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(goHome, IDLE_MS)
    }
    arm()
    window.addEventListener('pointerdown', arm)
    window.addEventListener('keydown', arm)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', arm)
      window.removeEventListener('keydown', arm)
    }
  }, [selectedId])

  // Toast lifetime. Re-armed whenever a new toast replaces an old one.
  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  // Optimistic: update immediately on tap (kids re-tap dead UI), reconcile with
  // the server's row, and roll back visibly if the call fails.
  const toggle = useCallback(async (instance: Instance, member: Member) => {
    const wasDone = instance.completed_at !== null
    const optimistic: Instance = wasDone
      ? { ...instance, completed_at: null, completed_by: null }
      : { ...instance, completed_at: new Date().toISOString(), completed_by: member.id }

    setBoard((cur) =>
      cur
        ? { ...cur, instances: cur.instances.map((i) => (i.id === instance.id ? optimistic : i)) }
        : cur,
    )
    // Offer Undo only for a completion — undoing an undo is just another tap.
    setToast(
      wasDone ? null : { instanceId: instance.id, title: instance.title, member },
    )
    try {
      const updated = wasDone
        ? await uncompleteInstance(instance.id)
        : await completeInstance(instance.id, member.id)
      setBoard((cur) =>
        cur
          ? { ...cur, instances: cur.instances.map((i) => (i.id === updated.id ? updated : i)) }
          : cur,
      )
    } catch {
      setBoard((cur) =>
        cur
          ? { ...cur, instances: cur.instances.map((i) => (i.id === instance.id ? instance : i)) }
          : cur,
      )
      // The write failed, so there is nothing to undo — don't offer it.
      setToast((cur) => (cur && cur.instanceId === instance.id ? null : cur))
    }
  }, [])

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
        <div className="card">
          <p className="muted">Loading…</p>
        </div>
      </Centered>
    )
  }

  const selected = selectedId ? (board.members.find((m) => m.id === selectedId) ?? null) : null

  const undo = () => {
    if (!toast) return
    const current = board.instances.find((i) => i.id === toast.instanceId)
    setToast(null)
    if (current && current.completed_at !== null) void toggle(current, toast.member)
  }

  return (
    <>
      {error && (
        <div className="offline-banner" role="alert">
          ⚠ {error} Showing the last board that loaded.
        </div>
      )}

      <div className="screen">
        <header className="kiosk-header">
          <div>
            <div className="clock">{clock.time}</div>
            <div className="clock-date">{clock.date}</div>
          </div>
          <div className="household-name">{board.household.name}</div>
        </header>

        {selected ? (
          <PersonScreen
            member={selected}
            chores={board.instances.filter((i) => i.assignee_id === selected.id)}
            onBack={() => {
              setSelectedId(null)
              setToast(null)
            }}
            onToggle={(instance) => void toggle(instance, selected)}
          />
        ) : (
          <FamilyScreen
            members={board.members}
            instances={board.instances}
            onSelect={(m) => setSelectedId(m.id)}
          />
        )}
      </div>

      {toast && (
        <div className="toast" role="status">
          <span className="toast-text">✓ {toast.title}</span>
          <button className="toast-undo" onClick={undo}>
            Undo
          </button>
        </div>
      )}
    </>
  )
}

/** Wall clock + date, in the iPad's own timezone. Ticks every second but only
 *  re-renders when the rendered strings actually change. */
function useClock() {
  const read = () => {
    const d = new Date()
    return {
      time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      date: d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
    }
  }
  const [clock, setClock] = useState(read)
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = read()
      setClock((cur) => (cur.time === next.time && cur.date === next.date ? cur : next))
    }, 1_000)
    return () => window.clearInterval(id)
  }, [])
  return clock
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="screen center">{children}</div>
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

function FamilyScreen({
  members,
  instances,
  onSelect,
}: {
  members: Member[]
  instances: Instance[]
  onSelect: (m: Member) => void
}) {
  return (
    <div className="sheet">
      <div className="tiles">
        {members.map((m) => {
          const mine = instances.filter((i) => i.assignee_id === m.id)
          const done = mine.filter((i) => i.completed_at !== null).length
          const remaining = mine.length - done

          // A dependent has no chores and cannot complete one — the API refuses
          // it. So the tile is a face and a name: no count, no ring, no button.
          if (m.role === 'dependent') {
            return (
              <div key={m.id} className="tile tile-static">
                <Avatar id={m.id} color={m.color} />
                <span className="tile-name">{m.name}</span>
              </div>
            )
          }

          return (
            <button key={m.id} className="tile" onClick={() => onSelect(m)}>
              <Avatar id={m.id} color={m.color} ring={{ done, total: mine.length }} />
              <span className="tile-name">{m.name}</span>
              <span className={`pill${remaining === 0 ? ' pill-clear' : ''}`}>
                {remaining === 0 ? 'All done' : `${remaining} to do`}
              </span>
            </button>
          )
        })}
      </div>

      {/* Schedule display, not a completion claim. Deliberately not tappable
       *  and deliberately has no checkbox: nothing records that it happened. */}
      <div className="reset-strip">
        <span className="reset-time">8:00 PM</span>
        <span className="reset-label">Family reset — everyone tidies the common rooms</span>
        <span className="reset-note">On the schedule</span>
      </div>
    </div>
  )
}

function PersonScreen({
  member,
  chores,
  onBack,
  onToggle,
}: {
  member: Member
  chores: Instance[]
  onBack: () => void
  onToggle: (instance: Instance) => void
}) {
  const done = chores.filter((c) => c.completed_at !== null).length
  const pct = chores.length === 0 ? 100 : Math.round((done / chores.length) * 100)

  return (
    <div className="sheet">
      <div className="person-header">
        <button className="back-btn" onClick={onBack}>
          ‹ Back
        </button>
        <Avatar id={member.id} color={member.color} size={84} />
        <div className="person-meta">
          <h1 className="person-name">{member.name}</h1>
          {chores.length > 0 && (
            <div className="progress">
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${pct}%`, backgroundColor: member.color }}
                />
              </div>
              <span className="progress-label">
                {done} of {chores.length} done
              </span>
            </div>
          )}
        </div>
      </div>

      {chores.length === 0 ? (
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
                  <span className="check">{isDone ? '✓' : ''}</span>
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
