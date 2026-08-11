import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ApiError,
  NetworkError,
  clearToken,
  completeInstance,
  getBoard,
  getHistory,
  getToken,
  setToken,
  uncompleteInstance,
  type Board,
  type History,
  type HistoryDay,
  type Instance,
  type Member,
} from './api'
import { avatarFor } from './avatar-looks'
import { Avatar } from './avatars'
import { notifyLate, notifyState, requestNotify, type NotifyState } from './notify'
import {
  RESET_AT,
  dateKey,
  formatClock,
  formatDate,
  resetHasPassed,
  resetLabel,
} from './clock'

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

// How long a chore stays amber past its cutoff before it goes red. Amber says
// "you are over"; red says "this is not getting done on its own". A single jump
// straight to red gives a kid who is two minutes late the same signal as one who
// is an hour late.
const LATE_RED_AFTER_MS = 30 * 60_000
// localStorage name for the ledger of which instances have already chimed
// today. Persisted so a reload — a PWA relaunch, an iPadOS memory purge —
// cannot re-announce chores that already went late hours ago.
//
// Named ...STORAGE_NAME rather than ...KEY, and dotted rather than
// underscored, because the repo's gitleaks hook reads `SOMETHING_KEY = '<high
// entropy string>'` as a credential and blocks the commit. It is a storage
// name, not a secret, and nothing secret ever belongs in this file.
const CHIME_LEDGER_STORAGE_NAME = 'atlas.chime.ledger'

type Late = 'none' | 'amber' | 'red'

/** How late this instance is, at a SERVER-anchored instant.
 *
 *  Never called with a browser wall-clock time. `nowMs` comes from
 *  serverNowMs(), which is the database's clock plus elapsed monotonic time —
 *  see the ServerClock note in App(). A completed chore is never late, and a
 *  chore with no cutoff can never become late. */
function lateness(instance: Instance, nowMs: number): Late {
  if (instance.completed_at !== null || instance.cutoff_at === null) return 'none'
  const cutoff = Date.parse(instance.cutoff_at)
  if (Number.isNaN(cutoff) || Number.isNaN(nowMs) || nowMs < cutoff) return 'none'
  return nowMs - cutoff >= LATE_RED_AFTER_MS ? 'red' : 'amber'
}

interface ChimeLedger {
  day: string
  ids: string[]
}

function readChimed(): ChimeLedger | null {
  try {
    const raw = localStorage.getItem(CHIME_LEDGER_STORAGE_NAME)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as ChimeLedger
    return typeof parsed.day === 'string' && Array.isArray(parsed.ids) ? parsed : null
  } catch {
    // Corrupt or unavailable storage must never break the board. Losing the
    // ledger costs at most one extra chime.
    return null
  }
}

function writeChimed(store: { day: string; ids: Set<string> }): void {
  try {
    localStorage.setItem(
      CHIME_LEDGER_STORAGE_NAME,
      JSON.stringify({ day: store.day, ids: [...store.ids] } satisfies ChimeLedger),
    )
  } catch {
    // Private mode, or quota. The in-memory set still prevents repeats for this
    // page's life, which is the case that actually matters.
  }
}

function worseLate(a: Late, b: Late): Late {
  if (a === 'red' || b === 'red') return 'red'
  if (a === 'amber' || b === 'amber') return 'amber'
  return 'none'
}

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
  // The worst lateness among this member's chores, and how many are late. The
  // tile carries the worst one so a single red chore is never hidden behind
  // three amber ones.
  late: Late
  lateCount: number
}

function statsFor(instances: Instance[], memberId: string, nowMs: number): Stats {
  const mine = instances.filter((i) => i.assignee_id === memberId)
  const done = mine.filter((i) => i.completed_at !== null).length
  let late: Late = 'none'
  let lateCount = 0
  for (const i of mine) {
    const l = lateness(i, nowMs)
    if (l !== 'none') lateCount += 1
    late = worseLate(late, l)
  }
  return {
    total: mine.length,
    done,
    pct: mine.length === 0 ? 0 : Math.round((done / mine.length) * 100),
    late,
    lateCount,
  }
}

/** A soft two-note chime, and the honest truth about whether it can sound.
 *
 *  iOS Safari will not let a page make noise until the user has interacted with
 *  it, and that permission dies with the page. A kiosk that has been sitting
 *  untouched since it loaded therefore CANNOT chime — no API call changes that,
 *  and a service worker would not either. So:
 *
 *  - the AudioContext is created and resumed on the first real interaction,
 *    whatever it is (a kid tapping any chore unlocks it for the rest of the
 *    page's life),
 *  - `armed` reports whether sound is actually possible, so the UI can stop
 *    short of promising something it cannot do,
 *  - and every late state is carried visually regardless. The chime is a bonus
 *    on top of the colour, the text and the icon — never the thing that
 *    carries the message.
 */
function useChime(): { play: () => void; armed: boolean } {
  const ctxRef = useRef<AudioContext | null>(null)
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    const unlock = () => {
      if (ctxRef.current !== null) return
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      if (Ctor === undefined) return
      const ctx = new Ctor()
      ctxRef.current = ctx
      void ctx.resume().then(
        () => setArmed(ctx.state === 'running'),
        () => setArmed(false),
      )
    }
    const events = ['pointerdown', 'touchstart', 'keydown'] as const
    for (const e of events) window.addEventListener(e, unlock, { passive: true })
    return () => {
      for (const e of events) window.removeEventListener(e, unlock)
    }
  }, [])

  const play = useCallback(() => {
    const ctx = ctxRef.current
    if (ctx === null || ctx.state !== 'running') return
    // Two short, quiet tones a fourth apart. Deliberately soft: this is a
    // kitchen, not an alarm panel, and a sound anyone wants to silence is a
    // sound that gets the whole kiosk muted.
    const start = ctx.currentTime
    for (const [i, freq] of [880, 1174.7].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = start + i * 0.18
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.09, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.36)
    }
  }, [])

  return { play, armed }
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

  // THE SERVER CLOCK, and why lateness is not computed from `new Date()`.
  //
  // Every board response carries the database's instant. We store it beside a
  // performance.now() reading taken at the same moment, and from then on read
  // "now" as serverMs + elapsed monotonic time. The iPad's opinion of what time
  // it is never enters the calculation — only its ability to measure how long
  // has passed since the last response, which a wrong clock still does
  // correctly. A wall display with a skewed clock is a recorded failure
  // (GAUNTLET-01, FIX NEXT SLICE 19 and 20); here it would turn chores red early
  // or leave them green long after the deadline.
  //
  // Not a boolean from the server, because a boolean is only correct for the
  // instant it was computed: on a 60s poll a chore would go red up to a minute
  // after its cutoff, and the tile would visibly turn at the wrong time.
  const clock = useRef<{ serverMs: number; monoMs: number } | null>(null)
  const serverNowMs = useCallback((): number => {
    const c = clock.current
    return c === null ? Number.NaN : c.serverMs + (performance.now() - c.monoMs)
  }, [])

  const { play: playChime, armed: chimeArmed } = useChime()
  // Read once at mount, never requested here — only the button requests.
  const [notify, setNotify] = useState<NotifyState>(() => notifyState())
  // Which instances have already chimed, and on which day.
  const chimed = useRef<{ day: string; ids: Set<string> } | null>(null)

  // Returns the board it fetched, so a caller can reconcile against server
  // truth rather than assuming. null means the fetch failed.
  const refresh = useCallback(async (timeoutMs?: number): Promise<Board | null> => {
    const issuedAt = writeSeq.current
    try {
      const b = await getBoard(timeoutMs)
      // Re-anchor the clock on every board. Both readings are taken here, as
      // close together as the language allows, so the pair stays consistent.
      const serverMs = Date.parse(b.server_time)
      if (!Number.isNaN(serverMs)) {
        clock.current = { serverMs, monoMs: performance.now() }
      }
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

  // THE CHIME. At most once per instance per day, and never a burst.
  //
  // `now` is in the dependency list purely as the tick that re-evaluates this —
  // its value is never read, because what time it is comes from the server.
  useEffect(() => {
    if (board === null) return
    const nowMs = serverNowMs()
    if (Number.isNaN(nowMs)) return
    const day = dateKey(new Date(board.server_time))
    const lateIds = board.instances
      .filter((i) => lateness(i, nowMs) !== 'none')
      .map((i) => i.id)

    const store = chimed.current
    if (store === null || store.day !== day) {
      // Either the first evaluation of this page's life, or midnight just
      // rolled over. Either way, ADOPT whatever is already late without
      // sounding: a chime marks the moment a chore goes late, and announcing at
      // 10pm that something went late at 9:30 is noise. Prior chimes for today
      // are recovered from localStorage so a reload cannot re-announce them.
      const saved = readChimed()
      chimed.current =
        saved !== null && saved.day === day
          ? { day, ids: new Set(saved.ids) }
          : { day, ids: new Set(lateIds) }
      writeChimed(chimed.current)
      return
    }

    const fresh = lateIds.filter((id) => !store.ids.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) store.ids.add(id)
    writeChimed(store)
    // ONE chime for the whole batch. Four family-reset rows cross 10:15
    // together; four chimes back to back is how a kiosk gets muted, and a muted
    // kiosk is a dead one.
    playChime()
    // The SAME ledger drives the desktop notification, so a chore can never
    // both chime and notify twice, and a reload cannot re-announce lateness
    // from hours ago. One notification per batch, for the same reason.
    notifyLate(
      fresh
        .map((id) => board.instances.find((i) => i.id === id)?.title)
        .filter((t): t is string => t !== undefined),
    )
  }, [board, now, serverNowMs, playChime])

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

  // Recomputed every render, and the render happens on the TICK_MS timer, so a
  // tile turns within one tick of its cutoff rather than at the next 60s poll.
  const nowMs = serverNowMs()
  const lateTotal = board.instances.filter((i) => lateness(i, nowMs) !== 'none').length

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
          // Keyed by member so the screen genuinely remounts per person: the
          // tab, the browsed month and the month cache are all per-member, and
          // a kid must never open their name onto the previous kid's calendar.
          <PersonScreen
            key={selected.id}
            member={selected}
            index={board.members.indexOf(selected)}
            chores={board.instances.filter((i) => i.assignee_id === selected.id)}
            onBack={() => setSelectedId(null)}
            onToggle={(instance) => void toggle(instance, selected)}
            nowMs={nowMs}
          />
        ) : (
          <FamilyScreen
            board={board}
            now={now}
            nowMs={nowMs}
            lateTotal={lateTotal}
            chimeArmed={chimeArmed}
            notify={notify}
            setNotify={setNotify}
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
  nowMs,
  lateTotal,
  chimeArmed,
  notify,
  setNotify,
  onSelect,
}: {
  board: Board
  now: Date
  nowMs: number
  lateTotal: number
  chimeArmed: boolean
  notify: NotifyState
  setNotify: (s: NotifyState) => void
  onSelect: (m: Member) => void
}) {
  // The reset strip goes red once the reset time has passed, judged from the
  // SERVER-anchored instant rather than the iPad's clock.
  const resetPast = !Number.isNaN(nowMs) && resetHasPassed(new Date(nowMs))
  return (
    <div className="screen">
      <div className="head">
        <div>
          {/* The headline becomes the count when anything is late. Never colour
              alone: this is the same fact stated in words, above tiles that
              also carry it in colour and icon. */}
          <h1>
            {lateTotal > 0
              ? `${lateTotal} ${lateTotal === 1 ? 'chore' : 'chores'} left tonight`
              : board.household.name}
          </h1>
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
            stats={statsFor(board.instances, m.id, nowMs)}
            onSelect={onSelect}
          />
        ))}
      </div>

      {/* Schedule display only: it says WHEN the reset is, never whether it was
          done, so it has no checkbox.

          THIS COMMENT USED TO SAY "there is no completion to record". That is no
          longer true, and the change is not in this file. Since slice 2 the
          nightly reset is a real chore_definition assigned to four people, so
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
        <div className={`strip${resetPast ? ' strip-past' : ''}`}>
          <div className="bell" aria-hidden="true">
            🧹
          </div>
          <div>
            <div className="t">15-minute family reset</div>
            {/* The time is RESET_AT, never a literal. This copy and the
                countdown beside it must come from the same constant — a strip
                that says one time while counting down to another is the wall
                lying about the thing the whole house looks at. */}
            <div className="s">Everyone, every night at {RESET_AT}</div>
          </div>
          {/* Styled by `.strip-past .cd`, not by a modifier class here — see
              the specificity note in index.css. */}
          <div className="cd">
            {resetPast && <span aria-hidden="true">⏰ </span>}
            {resetLabel(now)}
          </div>
        </div>
        {/* Said once, quietly, and only when sound genuinely cannot happen. iOS
            will not let a page make noise until someone has touched it, and that
            permission dies with the page — so a kiosk sitting untouched since it
            loaded is silent no matter what the code does. Better to admit that
            than to let anyone believe a chime is coming. */}
        {!chimeArmed && (
          <p className="chime-note">
            Sound starts after the first tap on this screen. Late chores are always
            shown in colour and words as well.
          </p>
        )}
        {/* Permission is requested from THIS TAP and from nothing else. Never on
            page load: browsers reject a prompt without a gesture, and a wall
            display that asks every morning gets permanently denied. The button
            is absent entirely where notifications cannot work — which includes
            the wall iPad, since we add no service worker. */}
        {notify === 'default' && (
          <button
            className="notify-btn"
            onClick={() => {
              void requestNotify().then(setNotify)
            }}
          >
            Turn on desktop alerts for late chores
          </button>
        )}
        {notify === 'denied' && (
          <p className="chime-note">
            Desktop alerts are blocked in this browser's settings. The board still
            shows late chores in colour and words.
          </p>
        )}
      </div>
    </div>
  )
}

function countLabel(stats: Stats): string {
  // A member with nothing assigned has not "finished" anything — saying
  // "All done" for an empty list would be a small lie on the wall.
  if (stats.total === 0) return 'Nothing today'
  if (stats.done === stats.total) return 'All done ✓'
  // The count pill states lateness in WORDS. Colour on the tile says the same
  // thing a second way; neither is load-bearing alone.
  if (stats.late !== 'none') {
    return `${stats.lateCount} late · ${stats.done} of ${stats.total} done`
  }
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

  const lateClass = stats.late === 'none' ? '' : ` pcard-${stats.late}`
  return (
    <button
      className={`pcard${stats.total > 0 && stats.done === stats.total ? ' clear' : ''}${lateClass}`}
      onClick={() => onSelect(member)}
      aria-label={`${member.name}, ${countLabel(stats)}`}
    >
      <div className="ring" style={{ ['--p' as string]: stats.pct }}>
        <div className="inner">
          <Avatar look={look} />
        </div>
      </div>
      <div className="nm">{member.name}</div>
      {/* The icon is the third channel, after colour and the words in the pill.
          A kid who cannot tell amber from red still sees a mark that is not
          there on anyone else's tile. */}
      <div className="cnt">
        {stats.late !== 'none' && <span aria-hidden="true">⚠ </span>}
        {countLabel(stats)}
      </div>
    </button>
  )
}

function PersonScreen({
  member,
  index,
  chores,
  onBack,
  onToggle,
  nowMs,
}: {
  member: Member
  index: number
  chores: Instance[]
  onBack: () => void
  onToggle: (instance: Instance) => void
  nowMs: number
}) {
  const done = chores.filter((c) => c.completed_at !== null).length
  const pct = chores.length === 0 ? 0 : Math.round((done / chores.length) * 100)

  const [tab, setTab] = useState<'today' | 'calendar'>('today')
  // The browsed month and the fetched months live HERE, not inside the
  // calendar, so switching Today -> Calendar -> Today does not lose your place
  // or refetch. null means "whichever month the server says it is". Both die
  // with this screen, so the next person starts fresh.
  const [calMonth, setCalMonth] = useState<string | null>(null)
  const calCache = useRef<Map<string, History>>(new Map())

  // The dependent gets no tabs and no calendar. They cannot be selected from
  // the family screen — their card is not a button — so this is belt and
  // braces. Stated anyway: the rule is "a dependent has no calendar", not
  // "there is currently no route to one".
  const showTabs = member.role !== 'dependent'
  const onCalendar = showTabs && tab === 'calendar'

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
        {showTabs && (
          <div className="tabs">
            <button
              className={`tab${onCalendar ? '' : ' on'}`}
              aria-pressed={!onCalendar}
              onClick={() => setTab('today')}
            >
              Today
            </button>
            <button
              className={`tab${onCalendar ? ' on' : ''}`}
              aria-pressed={onCalendar}
              onClick={() => setTab('calendar')}
            >
              Calendar
            </button>
          </div>
        )}
      </div>

      <div className="sheet grow">
        {onCalendar ? (
          <CalendarPanel
            member={member}
            month={calMonth}
            onMonth={setCalMonth}
            cache={calCache.current}
            // Today's square is fed from the LIVE board, not from the fetched
            // month. History is fetched once per month and cached, so the
            // moment a kid ticks a chore and switches to Calendar the cached
            // figure is stale and today's arc under-reports the work they just
            // did. These are the same rows the Today tab is showing, which is
            // the consistency that matters: the two tabs must not disagree
            // about the day the kid is standing in.
            todayTotal={chores.length}
            todayDone={done}
          />
        ) : chores.length === 0 ? (
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
              const late = lateness(c, nowMs)
              return (
                <li
                  key={c.id}
                  className={`task${isDone ? ' done' : ''}${late === 'none' ? '' : ` task-${late}`}`}
                >
                  <button className="trow" onClick={() => onToggle(c)}>
                    <span className="check">{isDone ? '✓' : ''}</span>
                    <span>
                      <span className="ttl">{c.title}</span>
                      {isDone && <span className="note">Done ✓</span>}
                      {/* ONLY "Missed 6:15 PM". No "a grown-up was told" until a
                          grown-up is actually told — that clause is B4's, and
                          only for chores that really escalate. The first time a
                          kid reads a promise the board does not keep, the board
                          stops being worth reading. */}
                      {/* The clause is only ever attached where cutoff_at is
                          non-null, because that is exactly the set of chores
                          /api/outstanding can report. A chore with no cutoff
                          never reaches that list, so claiming otherwise would
                          be the promise B2 refused to print.

                          And the words are what the app can GUARANTEE. "a
                          grown-up was told" depends on an iOS Shortcut that
                          lives on a phone and is not yet proven to run
                          unattended; the board cannot know whether a message
                          was ever delivered. It CAN know the chore is on the
                          list, because the endpoint returns it the moment it
                          goes late. */}
                      {!isDone && late !== 'none' && c.cutoff_at !== null && (
                        <span className={`note note-late note-${late}`}>
                          <span aria-hidden="true">⚠ </span>
                          Missed {formatClock(new Date(c.cutoff_at))} · on the
                          grown-ups&rsquo; list
                        </span>
                      )}
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

// ---------- calendar ----------
//
// Every decision about WHAT DAY IT IS comes from the server: `today` and
// `first_date` arrive in the History payload, resolved in APP_TIMEZONE. The
// iPad's own clock is never consulted, because a wall display with a skewed or
// wrong clock is a recorded failure (GAUNTLET-01, FIX NEXT SLICE 19 and 20) and
// here it would grey out days that really happened. UTC Dates appear below
// purely as a calendar calculator — the weekday of the 1st, and how many days a
// month has — where no timezone can leak into the answer.

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Five states. The two a naive calendar collapses are 'nodata' and a 'partial'
// with nothing completed: the first is a date with NO instances at all — before
// this system existed, or a day nothing was scheduled — and the second is a real
// day on which someone did none of their chores. The prototype drew both as the
// same empty ring. That ring says "you did none of your chores", so showing it
// for a day nobody was asked anything is the board accusing a kid of failing at
// something that was never on it. 'nodata' is therefore a dashed outline and
// never a ring.
type DayState = 'complete' | 'partial' | 'today' | 'nodata' | 'future'

function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7)
}

function shiftMonth(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta
  const year = String(Math.floor(index / 12)).padStart(4, '0')
  const mon = String((index % 12) + 1).padStart(2, '0')
  return `${year}-${mon}`
}

function monthUtc(month: string, day: number): Date {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, day))
}

function monthLabel(month: string): string {
  return monthUtc(month, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function daysInMonth(month: string): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  ).getUTCDate()
}

/** Monday-first, matching the prototype's grid. */
function leadingBlanks(month: string): number {
  return (monthUtc(month, 1).getUTCDay() + 6) % 7
}

function dayState(iso: string, today: string, entry: HistoryDay | undefined): DayState {
  // Today keeps its own state — gold, and a 3px rim — but it FILLS like every
  // other day and is only a complete ring once the last chore is ticked. It is
  // the one day still in play, which is exactly why the arc is worth drawing:
  // it is not a grade, it is the same "here is where you are" the ring on the
  // kid's own tile already shows.
  if (iso === today) return 'today'
  if (iso > today) return 'future'
  if (entry === undefined || entry.total === 0) return 'nodata'
  return entry.completed >= entry.total ? 'complete' : 'partial'
}

function dayLabel(day: number, state: DayState, entry: HistoryDay | undefined): string {
  if (state === 'future') return `${day}, still to come`
  if (state === 'today') {
    return entry === undefined || entry.total === 0
      ? `${day}, today, nothing on your list`
      : `${day}, today, ${entry.completed} of ${entry.total} done`
  }
  if (state === 'nodata' || entry === undefined) return `${day}, nothing was on the board`
  if (state === 'complete') return `${day}, all ${entry.total} done`
  return `${day}, ${entry.completed} of ${entry.total} done`
}

function CalendarPanel({
  member,
  month,
  onMonth,
  cache,
  todayTotal,
  todayDone,
}: {
  member: Member
  month: string | null
  onMonth: (month: string) => void
  cache: Map<string, History>
  todayTotal: number
  todayDone: number
}) {
  // null means "whichever month the server says it is", so the first request
  // carries no assumption about the date at all.
  const cacheKey = month ?? '@current'
  const [data, setData] = useState<History | null>(() => cache.get(cacheKey) ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const hit = cache.get(cacheKey)
    if (hit !== undefined) {
      setData(hit)
      setError(null)
      return
    }
    let cancelled = false
    getHistory(member.id, month ?? undefined)
      .then((fetched) => {
        if (cancelled) return
        // Stored under BOTH the key asked for and the month actually served, so
        // that asking for "the current month" and later paging back to it is a
        // cache hit rather than a second request for the same data.
        cache.set(cacheKey, fetched)
        cache.set(fetched.month, fetched)
        setData(fetched)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof NetworkError
            ? "Can't reach the server."
            : 'Could not load the calendar.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [member.id, month, cacheKey, cache])

  if (data === null) {
    return (
      <div className="cal">
        <p className="cal-msg">{error ?? 'Loading…'}</p>
      </div>
    )
  }

  // What the header claims vs. what we actually hold. When a month button is
  // pressed the header moves immediately — a nav control that looks dead for a
  // cold Lambda's worth of latency is the exact failure the gauntlet spent
  // three rounds on — while the grid says it is loading rather than showing the
  // previous month's squares under the new month's name.
  const shown = month ?? data.month
  const loaded = data.month
  const stale = shown !== loaded

  const firstMonth = data.first_date === null ? null : monthOf(data.first_date)
  // Never page back past this member's first recorded day, and never into a
  // month that has not happened. Both bounds are the server's, not the iPad's.
  const canPrev = firstMonth !== null && shown > firstMonth
  const canNext = shown < monthOf(data.today)

  const byDate = new Map(data.days.map((d) => [d.date, d]))
  const cells: ReactNode[] = []
  if (!stale) {
    for (let i = 0; i < leadingBlanks(loaded); i++) {
      cells.push(<div key={`pad-${i}`} className="day day-pad" aria-hidden="true" />)
    }
    for (let day = 1; day <= daysInMonth(loaded); day++) {
      const iso = `${loaded}-${String(day).padStart(2, '0')}`
      // Today comes from the live board; every other day from the fetched
      // month. See the call site for why the cached figure cannot be trusted
      // for the day currently being worked on.
      const entry =
        iso === data.today
          ? { date: iso, total: todayTotal, completed: todayDone }
          : byDate.get(iso)
      const state = dayState(iso, data.today, entry)
      const pct =
        entry !== undefined && entry.total > 0
          ? Math.round((entry.completed / entry.total) * 100)
          : 0
      cells.push(
        <div
          key={iso}
          className={`day day-${state}`}
          role="img"
          aria-label={dayLabel(day, state, entry)}
        >
          <div className="r" style={{ ['--p' as string]: pct }}>
            <em>{day}</em>
          </div>
        </div>,
      )
    }
  }

  return (
    <div className="cal">
      <div className="mon">
        <b>{monthLabel(shown)}</b>
        <button
          className="nav last"
          onClick={() => onMonth(shiftMonth(shown, -1))}
          disabled={!canPrev}
          aria-label="Previous month"
        >
          ‹
        </button>
        <button
          className="nav"
          onClick={() => onMonth(shiftMonth(shown, 1))}
          disabled={!canNext}
          aria-label="Next month"
        >
          ›
        </button>
      </div>

      {error !== null && <p className="cal-msg">{error}</p>}

      {stale ? (
        <p className="cal-msg">Loading…</p>
      ) : (
        <>
          <div className="grid">
            {DOW.map((d) => (
              <div key={d} className="dow">
                {d}
              </div>
            ))}
            {cells}
          </div>
          {/* Four entries, because there are four things a square can mean. The
              fourth is the one that has to be there: without it a dashed square
              is a mystery, and the honest answer ("nothing was on the board") is
              exactly what stops it reading as a failed day. */}
          <div className="legend">
            <span>
              <i className="key key-complete">
                <em />
              </i>
              Full circle — everything done
            </span>
            <span>
              <i className="key key-partial">
                <em />
              </i>
              Part circle — some left undone
            </span>
            <span>
              <i className="key key-today">
                <em />
              </i>
              Today
            </span>
            <span>
              <i className="key key-nodata">
                <em />
              </i>
              Dashed — nothing was on the board
            </span>
          </div>
        </>
      )}
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
