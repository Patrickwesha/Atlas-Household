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
// How long a chore row ignores a repeat tap after it moves. Deliberately longer
// than an accidental double tap and than a "did that register?" re-tap. The
// deliberate way to reverse a completion inside this window is the Undo button,
// which is on screen for TOAST_MS and is a bigger, clearer target than the row.
const TAP_COOLDOWN_MS = 2_000
// The reconcile after a failed write gets a much smaller budget than the write
// itself. Two stacked 20s deadlines meant a wifi drop said nothing for 40s.
const RECONCILE_TIMEOUT_MS = 6_000

interface ToastState {
  instanceId: string
  // Only meaningful for kind 'already': whether the row is currently done.
  done?: boolean
  // Whose screen produced this toast. The toast is global, so without this it
  // survived every navigation: complete a chore, tap Back, and a live Undo for
  // YOUR chore rode along onto the next kid's screen, where one tap erased it.
  memberId: string
  title: string
  // 'done' offers Undo. 'undone' confirms the destructive direction, which used
  // to happen in complete silence. 'error' is the one thing a failed tap never
  // had: any visible acknowledgement at all.
  kind: 'done' | 'undone' | 'error' | 'already' | 'unknown'
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
  const [retrying, setRetrying] = useState(false)

  // Instances with a tap in flight — stops a background poll from overwriting a
  // row mid-tap, and stops a second tap racing the first.
  const pending = useRef<Set<string>>(new Set())
  // When each row was last acted on. An in-flight lock alone does NOT stop a
  // double tap: the API answers in milliseconds, so the second tap of a double
  // tap arrives after the first has settled and reads as a deliberate toggle —
  // which un-does the chore. Measured reversing at every gap from 60ms to
  // 1.2s. A row therefore ignores repeat taps for a moment after it moves.
  const lastTap = useRef<Map<string, number>>(new Map())
  // Monotonic write counter, and the write number of each row's last confirmed
  // change. A board GET issued BEFORE a write can be answered AFTER it — a cold
  // Lambda takes seconds while a warm write takes milliseconds — and that stale
  // snapshot would otherwise erase a tick that is committed in the database.
  // Guarding only rows still in flight is not enough: by the time the slow board
  // response lands, the write has finished and left the in-flight set.
  const writeSeq = useRef(0)
  const lastWrite = useRef<Map<string, number>>(new Map())

  // Returns the board it fetched, so a caller can reconcile against server
  // truth rather than assuming. null means the fetch failed.
  const refresh = useCallback(async (timeoutMs?: number): Promise<Board | null> => {
    const issuedAt = writeSeq.current
    try {
      const b = await getBoard(timeoutMs)
      // Which rows we know more about than this response does: still in flight,
      // or written after this request went out. Snapshot NOW, not inside the
      // updater — React runs that closure later, during render, and by then a
      // caller's own bookkeeping may have moved on, which would make the merge
      // preserve a row it should have replaced.
      const keepLocal = new Set<string>(pending.current)
      for (const [id, seq] of lastWrite.current) {
        if (seq > issuedAt) keepLocal.add(id)
      }
      setBoard((cur) => {
        if (cur === null || keepLocal.size === 0) return b
        return {
          ...b,
          instances: b.instances.map((i) =>
            keepLocal.has(i.id) ? cur.instances.find((c) => c.id === i.id) ?? i : i,
          ),
        }
      })
      setError(null)
      return b
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken()
        setHasToken(false)
        return null
      }
      setError(
        err instanceof NetworkError
          ? "Can't reach the server."
          : 'Something went wrong loading the board.',
      )
      return null
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

  // A grown-up re-entering the token must never meet a button stuck on "Trying…"
  // left over from the failure that sent them to the setup screen.
  useEffect(() => {
    setRetrying(false)
  }, [hasToken])

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
      if (pending.current.has(instance.id)) return

      // Inside the cooldown, re-assert what the row already says instead of
      // reversing it. Not silent: a swallowed tap is what "broken" looks like,
      // so this re-shows the confirmation — with Undo, if it is done — which is
      // the answer to the question the second tap was asking.
      const tappedAt = Date.now()
      if (tappedAt - (lastTap.current.get(instance.id) ?? 0) < TAP_COOLDOWN_MS) {
        // 'already' STATES the row's current state. It must not reuse the
        // done/undone wording, which describes a TRANSITION: reporting "not
        // done any more" for a tap the code deliberately did not act on tells
        // a kid their work was just undone when nothing happened at all.
        setToast({
          instanceId: instance.id,
          memberId: member.id,
          title: instance.title,
          kind: 'already',
          done: instance.completed_at !== null,
        })
        return
      }
      lastTap.current.set(instance.id, tappedAt)
      pending.current.add(instance.id)

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
        writeSeq.current += 1
        lastWrite.current.set(updated.id, writeSeq.current)
        setToast({
          instanceId: updated.id,
          memberId: member.id,
          title: updated.title,
          kind: wasDone ? 'undone' : 'done',
        })
      } catch {
        // Roll back, then ask the server what is actually true. The rollback
        // alone is a GUESS: when the write commits and only the response is
        // lost — the ordinary shape of a mid-tap wifi drop — reverting shows
        // the opposite of the database as fact.
        applyInstance(instance)
        // Leave the pending set BEFORE reconciling, or refresh() will helpfully
        // preserve the row we just rolled back and defeat its own purpose.
        pending.current.delete(instance.id)
        // A much smaller budget than the write's. The outage that killed the
        // write usually kills this too, and stacking two full deadlines meant
        // the kid was told nothing at all for 40 seconds.
        const reconciled = await refresh(RECONCILE_TIMEOUT_MS)
        const row = reconciled?.instances.find((i) => i.id === instance.id) ?? null

        if (reconciled === null) {
          // We could not reach the server, so we DO NOT KNOW whether the write
          // landed. Saying "couldn't save" here would be a guess presented as
          // fact — and it is the common case, because the same outage takes out
          // both requests. Say what is actually true instead.
          lastTap.current.delete(instance.id)
          setToast({
            instanceId: instance.id,
            memberId: member.id,
            title: instance.title,
            kind: 'unknown',
          })
        } else {
          // Only cry failure when the board actually shows the write did not
          // happen. Saying "tap it again" over a row the refetch just painted
          // green makes a kid un-do the chore that saved.
          const saved = row !== null && (row.completed_at !== null) === !wasDone
          if (saved) {
            writeSeq.current += 1
            lastWrite.current.set(instance.id, writeSeq.current)
          } else {
            // Nothing was written, so there is nothing to protect from a second
            // tap — and the error toast tells the kid to tap again. Leaving the
            // cooldown armed would swallow the very retry we just asked for.
            lastTap.current.delete(instance.id)
          }
          setToast({
            instanceId: instance.id,
            memberId: member.id,
            title: row?.title ?? instance.title,
            kind: saved ? (wasDone ? 'undone' : 'done') : 'error',
          })
        }
      } finally {
        pending.current.delete(instance.id)
      }
    },
    [applyInstance, refresh],
  )

  const undo = useCallback(
    async (instance: Instance) => {
      if (pending.current.has(instance.id)) return
      pending.current.add(instance.id)
      // Undo is the deliberate reversal, so it also clears the row's cooldown —
      // re-completing straight afterwards must work on the very next tap.
      lastTap.current.delete(instance.id)
      setToast(null)
      applyInstance({ ...instance, completed_at: null, completed_by: null })
      try {
        const updated = await uncompleteInstance(instance.id)
        applyInstance(updated)
        // Undo is a write like any other and MUST register here. Without it,
        // lastWrite still held the seq of the completion this just reversed, so
        // a board GET issued after the complete and answered after the undo lost
        // the `seq > issuedAt` test, the merge took the server's stale row, and
        // the tick came back on its own — the wall crediting a chore the
        // database says is not done, for up to a full poll interval.
        writeSeq.current += 1
        lastWrite.current.set(updated.id, writeSeq.current)
      } catch {
        applyInstance(instance)
        pending.current.delete(instance.id)
        const reconciled = await refresh(RECONCILE_TIMEOUT_MS)
        const row = reconciled?.instances.find((i) => i.id === instance.id) ?? null
        if (reconciled === null) {
          setToast({
            instanceId: instance.id,
            memberId: instance.assignee_id,
            title: instance.title,
            kind: 'unknown',
          })
        } else {
          const cleared = row !== null && row.completed_at === null
          if (cleared) {
            writeSeq.current += 1
            lastWrite.current.set(instance.id, writeSeq.current)
          }
          setToast({
            instanceId: instance.id,
            memberId: instance.assignee_id,
            title: row?.title ?? instance.title,
            kind: cleared ? 'undone' : 'error',
          })
        }
      } finally {
        pending.current.delete(instance.id)
      }
    },
    [applyInstance, refresh],
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
              <p>Tell a grown-up if it keeps saying this.</p>
              {/* The retry used to change nothing on screen — same text before,
                  during and after — so the only button on the screen looked
                  dead and kids hammered it. */}
              <button
                className="big-btn"
                disabled={retrying}
                onClick={() => {
                  if (retrying) return
                  setRetrying(true)
                  const clear = () => setRetrying(false)
                  void refresh().finally(() => window.setTimeout(clear, 600))
                  // Hard stop. This is the only control on the screen; it must
                  // never be left disabled reading "Trying…" forever, which is
                  // what happened when a request hung and .finally never ran.
                  window.setTimeout(clear, 25_000)
                }}
              >
                {retrying ? 'Trying…' : 'Try again'}
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
  // A toast belongs to the screen that raised it. Off that screen it is not
  // shown and its Undo is unreachable — otherwise Undo for one kid's chore
  // rides onto the next kid's screen (or the family screen, if the response
  // lands after Back was tapped) and one curious press erases their work.
  const visibleToast = toast !== null && toast.memberId === selected?.id ? toast : null
  const toastInstance = visibleToast
    ? board.instances.find((i) => i.id === visibleToast.instanceId) ?? null
    : null

  return (
    <>
      <Shell banner={error ? `⚠ ${error} Showing the last board that loaded.` : null}>
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
        toast={visibleToast}
        canUndo={
          visibleToast?.kind === 'done' &&
          toastInstance !== null &&
          toastInstance.completed_at !== null
        }
        onUndo={() => {
          if (toastInstance) void undo(toastInstance)
        }}
      />
    </>
  )
}

function Shell({ banner, children }: { banner?: string | null; children: ReactNode }) {
  return (
    <div className="kiosk">
      {/* Always rendered so its strip is always reserved. Rendering it only on
          error moved every chore row 46px the moment the network hiccupped,
          which made kids tap the wrong chore. */}
      <div
        className={`offline-banner${banner ? '' : ' offline-banner-idle'}`}
        role={banner ? 'alert' : undefined}
        aria-hidden={banner ? undefined : true}
      >
        {banner ?? ''}
      </div>
      {children}
    </div>
  )
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

      {/* Schedule display only: it says WHEN the reset is, never whether it was
          done, so it has no checkbox.

          THIS COMMENT USED TO SAY "there is no completion to record". That is no
          longer true, and the change is not in this file. Since slice 2 the 8pm
          reset is a real chore_definition assigned to four people every day, so
          it materializes into four completable rows that appear in four people's
          lists — the same event is now on screen twice, in two different
          grammars, and only one of them can be tapped.

          Deliberately NOT reconciled here. The two are never co-visible (this is
          the family screen, those are person screens), the strip's
          looks-like-a-button-but-is-inert problem is pre-existing
          (GAUNTLET-01 FIX NEXT SLICE 27), and Phase 2 already owns making this
          strip stateful — it is specified to count down in red once cutoff has
          passed, which means reading those instances. Fixing it now would mean
          guessing at that design a phase early.

          Phase 2 must resolve this. Either the strip shows the real state of
          those four instances ("2 of 4 done", counting down in red), or it goes
          away because the rows already say it. What it must not stay is a
          hardcoded second opinion about a thing the database now knows. */}
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
          // No confetti. An empty list is almost never "you finished" — a
          // finished list still shows its rows, ticked. Empty means nothing was
          // put on the board, which is not an achievement to celebrate.
          <p className="big-empty">Nothing on your list today.</p>
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

// 'done' and 'undone' describe a CHANGE that just happened. 'already' describes
// the row's CURRENT STATE, for a tap that was deliberately not acted on — using
// the change wording there told a kid their work had just been undone when
// nothing had happened at all.
function toastText(t: ToastState): string {
  switch (t.kind) {
    case 'done':
      return `${t.title} — done`
    case 'undone':
      return `${t.title} — not done any more`
    case 'already':
      return t.done ? `${t.title} is already done ✓` : `${t.title} is not done yet`
    case 'error':
      return `Couldn't save "${t.title}". Tap it again.`
    // We reached neither the write nor the board, so we genuinely do not know.
    // Not "couldn't save" — that would be a guess stated as fact, and it is the
    // usual case, since one outage takes out both requests.
    case 'unknown':
      return `Can't reach the server — "${t.title}" might not be saved.`
  }
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
    <div
      className={`toast${toast ? ' show' : ''}${toast?.kind === 'error' || toast?.kind === 'unknown' ? ' toast-error' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="toast-text">{toast ? toastText(toast) : ''}</span>
      {canUndo && <button onClick={onUndo}>Undo</button>}
    </div>
  )
}
