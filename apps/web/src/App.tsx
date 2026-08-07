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
import { onWhite, readableOn } from './colors'
import { useDayFlip, useIdleReset } from './hooks'
import { AvatarRing, ClockHeader, ProgressBar, ResetStrip, Toast } from './ui'

const POLL_MS = 60_000
// 60s, not 30s: reading down a chore list should not bounce you to the family
// screen mid-read.
const IDLE_MS = 60_000
const TOAST_MS = 7_000

type ToastState = { key: number; instance: Instance; member: Member }

export default function App() {
  const [hasToken, setHasToken] = useState<boolean>(() => getToken() !== null)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastKey = useRef(0)

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

  // The header prints a date; when that date rolls over, the board underneath it
  // has to roll over too rather than waiting out the poll interval.
  useDayFlip(refresh)

  const goHome = useCallback(() => {
    setSelectedId(null)
    setToast(null)
  }, [])
  useIdleReset(selectedId !== null, IDLE_MS, goHome)

  const dismissToast = useCallback(() => setToast(null), [])

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
    if (wasDone) {
      setToast(null)
    } else {
      setToast({ key: toastKey.current++, instance: optimistic, member })
    }

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
      // The toast claimed this was done. The server disagreed, so retract it
      // rather than leave a confirmation standing over a chore that isn't done.
      setToast((cur) => (cur && cur.instance.id === instance.id ? null : cur))
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
        <p className="loading">Loading…</p>
      </Centered>
    )
  }

  const loadedBoard = board
  const selected = selectedId ? loadedBoard.members.find((m) => m.id === selectedId) ?? null : null

  return (
    <>
      {error && (
        <div className="offline-banner" role="alert">
          ⚠ {error} Showing the last board that loaded.
        </div>
      )}
      {selected ? (
        <MemberChores
          member={selected}
          chores={loadedBoard.instances.filter((i) => i.assignee_id === selected.id)}
          onBack={goHome}
          onToggle={(instance) => void toggle(instance, selected)}
        />
      ) : (
        <MemberTiles
          householdName={loadedBoard.household.name}
          members={loadedBoard.members}
          instances={loadedBoard.instances}
          onSelect={(m) => setSelectedId(m.id)}
        />
      )}
      {toast && (
        <Toast
          key={toast.key}
          title={toast.instance.title}
          ms={TOAST_MS}
          onDismiss={dismissToast}
          onUndo={() => {
            // Undo whatever the row is NOW, not the snapshot the toast captured —
            // it may already have been un-done from the list behind the toast.
            const live =
              loadedBoard.instances.find((i) => i.id === toast.instance.id) ?? toast.instance
            setToast(null)
            if (live.completed_at !== null) void toggle(live, toast.member)
          }}
        />
      )}
    </>
  )
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

function MemberTiles({
  householdName,
  members,
  instances,
  onSelect,
}: {
  householdName: string
  members: Member[]
  instances: Instance[]
  onSelect: (m: Member) => void
}) {
  return (
    <div className="screen">
      <div className="sheet">
        <ClockHeader householdName={householdName} />
        <div className="tiles">
          {members.map((m) => {
            const mine = instances.filter((i) => i.assignee_id === m.id)
            const total = mine.length
            const done = mine.filter((i) => i.completed_at !== null).length
            const remaining = total - done

            // A dependent has no chores by rule (the API refuses to record one).
            // Face and name only: present on the board, never a target.
            if (m.role === 'dependent') {
              return (
                <div key={m.id} className="tile tile-static">
                  <AvatarRing id={m.id} color={m.color} done={0} total={0} />
                  <span className="tile-name">{m.name}</span>
                </div>
              )
            }

            return (
              <button key={m.id} className="tile" onClick={() => onSelect(m)}>
                <AvatarRing id={m.id} color={m.color} done={done} total={total} />
                <span className="tile-name">{m.name}</span>
                {/* "All done" must mean chores existed and were finished. Zero
                    chores is "Nothing today" — claiming otherwise is a lie the
                    board would tell every morning before it's seeded. */}
                {total === 0 ? (
                  <span className="pill pill-none">Nothing today</span>
                ) : remaining === 0 ? (
                  <span className="pill pill-done">All done</span>
                ) : (
                  <span
                    className="pill"
                    style={{ backgroundColor: m.color, color: readableOn(m.color) }}
                  >
                    {remaining} left
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <ResetStrip />
      </div>
    </div>
  )
}

function MemberChores({
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
  const total = chores.length
  const done = chores.filter((c) => c.completed_at !== null).length

  return (
    <div className="screen">
      <div className="sheet">
        <div className="chores-header">
          <button className="back-btn" onClick={onBack}>
            <span aria-hidden="true">‹</span> Back
          </button>
          <AvatarRing id={member.id} color={member.color} done={done} total={total} />
          <h1 style={{ color: onWhite(member.color) }}>{member.name}</h1>
        </div>
        <ProgressBar done={done} total={total} color={member.color} />
        {total === 0 ? (
          <p className="big-empty">Nothing on the board today.</p>
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
      </div>
    </div>
  )
}
