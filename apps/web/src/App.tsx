import { useCallback, useEffect, useState, type ReactNode } from 'react'
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

export default function App() {
  const [hasToken, setHasToken] = useState<boolean>(() => getToken() !== null)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

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
        <p className="muted">Loading…</p>
      </Centered>
    )
  }

  const selected = selectedId ? board.members.find((m) => m.id === selectedId) ?? null : null

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
  const remainingFor = (m: Member) =>
    instances.filter((i) => i.assignee_id === m.id && i.completed_at === null).length

  return (
    <div className="screen tiles-screen">
      <h1 className="board-title">{household.name}</h1>
      <div className="tiles">
        {members.map((m) => {
          const dependent = m.role === 'dependent'
          const remaining = remainingFor(m)
          return (
            <button
              key={m.id}
              className={`tile${dependent ? ' tile-disabled' : ''}`}
              style={{ backgroundColor: m.color }}
              disabled={dependent}
              onClick={dependent ? undefined : () => onSelect(m)}
            >
              <span className="tile-name">{m.name}</span>
              <span className="tile-sub">
                {dependent ? '—' : remaining === 0 ? 'All done' : `${remaining} to do`}
              </span>
            </button>
          )
        })}
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
  return (
    <div className="screen chores-screen">
      <div className="chores-header">
        <button className="back-btn" onClick={onBack}>
          ‹ Back
        </button>
        <h1 style={{ color: member.color }}>{member.name}</h1>
      </div>
      {chores.length === 0 ? (
        <p className="muted big-empty">No chores today 🎉</p>
      ) : (
        <ul className="chore-list">
          {chores.map((c) => {
            const done = c.completed_at !== null
            return (
              <li key={c.id}>
                <button
                  className={`chore${done ? ' chore-done' : ''}`}
                  onClick={() => onToggle(c)}
                >
                  <span
                    className="check"
                    style={{ backgroundColor: done ? member.color : undefined }}
                  >
                    {done ? '✓' : ''}
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
