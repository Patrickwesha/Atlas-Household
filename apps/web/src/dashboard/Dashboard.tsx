import { useCallback, useEffect, useState } from 'react'
import {
  AuthExpired,
  clearSession,
  listDefinitions,
  listMembers,
  loadSession,
  login,
  previewDefinition,
  saveDefinition,
  type AdminDefinition,
  type AssignmentSpec,
  type Member,
  type PreviewResult,
  type Session,
} from './api'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const PARITY: { value: number | null; label: string }[] = [
  { value: null, label: 'Every week' },
  { value: 0, label: 'Even weeks' },
  { value: 1, label: 'Odd weeks' },
]

type Draft = Omit<AdminDefinition, 'id' | 'cadence'>

function toDraft(d: AdminDefinition): Draft {
  return {
    name: d.name,
    area: d.area,
    cutoff_time: d.cutoff_time,
    sort_order: d.sort_order,
    is_active: d.is_active,
    assignments: d.assignments.map((a) => ({ ...a })),
  }
}

export default function Dashboard() {
  const [session, setSession] = useState<Session | null>(() => loadSession())
  if (session === null) return <SignIn onSignedIn={setSession} />
  return <Editor session={session} onSignOut={() => { clearSession(); setSession(null) }} />
}

function SignIn({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="dash-center">
      <form
        className="dash-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (busy) return
          setBusy(true)
          setError(null)
          login(email.trim(), password)
            .then(onSignedIn)
            .catch((err: unknown) =>
              setError(err instanceof Error ? err.message : 'Could not sign in'),
            )
            .finally(() => setBusy(false))
        }}
      >
        <h1>Atlas — chores</h1>
        <p className="dash-muted">
          Signing in here does not change anything on the kitchen board. Closing
          this tab signs you out.
        </p>
        <label className="dash-label">
          Email
          <input
            className="dash-input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="dash-label">
          Password
          <input
            className="dash-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error !== null && <p className="dash-error" role="alert">{error}</p>}
        <button className="dash-primary" disabled={busy || password.length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

function Editor({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [defs, setDefs] = useState<AdminDefinition[] | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(() => {
    Promise.all([listDefinitions(), listMembers()])
      .then(([d, m]) => {
        setDefs(d)
        setMembers(m)
        setError(null)
      })
      .catch((err: unknown) => {
        if (err instanceof AuthExpired) {
          onSignOut()
          return
        }
        setError(err instanceof Error ? err.message : 'Could not load chores')
      })
  }, [onSignOut])

  useEffect(load, [load])

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1>Chores</h1>
          <p className="dash-muted">Signed in as {session.member_name}</p>
        </div>
        {/* Always visible, never behind a menu. A parent session on the wall
            iPad has to be one tap from ending. */}
        <button className="dash-signout" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      {error !== null && <p className="dash-error" role="alert">{error}</p>}
      {defs === null && error === null && <p className="dash-muted">Loading…</p>}

      {defs?.map((d) =>
        editing === d.id ? (
          <DefinitionEditor
            key={d.id}
            definition={d}
            members={members}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              load()
            }}
            onExpired={onSignOut}
          />
        ) : (
          <article key={d.id} className={`dash-row${d.is_active ? '' : ' dash-off'}`}>
            <div className="dash-row-main">
              <h2>{d.name}</h2>
              <p className="dash-muted">
                {d.area ?? 'No area'} · {d.cutoff_time ?? 'no cutoff'} ·{' '}
                {d.assignments.length} assignment
                {d.assignments.length === 1 ? '' : 's'}
                {d.is_active ? '' : ' · RETIRED'}
              </p>
            </div>
            <button className="dash-secondary" onClick={() => setEditing(d.id)}>
              Edit
            </button>
          </article>
        ),
      )}
    </div>
  )
}

function DefinitionEditor({
  definition,
  members,
  onCancel,
  onSaved,
  onExpired,
}: {
  definition: AdminDefinition
  members: Member[]
  onCancel: () => void
  onSaved: () => void
  onExpired: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(definition))
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Any edit invalidates the preview. Showing a preview computed from an
  // earlier draft next to a Save button is how someone saves a change they
  // never actually looked at.
  const change = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setPreview(null)
    setError(null)
  }

  const has = (memberId: string, day: number): AssignmentSpec | undefined =>
    draft.assignments.find((a) => a.member_id === memberId && a.day_of_week === day)

  const toggle = (memberId: string, day: number) => {
    const existing = has(memberId, day)
    change({
      assignments: existing
        ? draft.assignments.filter(
            (a) => !(a.member_id === memberId && a.day_of_week === day),
          )
        : [...draft.assignments, { member_id: memberId, day_of_week: day, week_parity: null }],
    })
  }

  const setParity = (memberId: string, day: number, week_parity: number | null) =>
    change({
      assignments: draft.assignments.map((a) =>
        a.member_id === memberId && a.day_of_week === day ? { ...a, week_parity } : a,
      ),
    })

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    fn()
      .catch((err: unknown) => {
        if (err instanceof AuthExpired) {
          onExpired()
          return
        }
        setError(err instanceof Error ? err.message : 'Something went wrong')
      })
      .finally(() => setBusy(false))
  }

  return (
    <article className="dash-row dash-editing">
      <label className="dash-label">
        Name
        <input
          className="dash-input"
          value={draft.name}
          onChange={(e) => change({ name: e.target.value })}
        />
      </label>
      <div className="dash-grid2">
        <label className="dash-label">
          Area
          <input
            className="dash-input"
            value={draft.area ?? ''}
            onChange={(e) => change({ area: e.target.value || null })}
          />
        </label>
        <label className="dash-label">
          Cutoff time
          <input
            className="dash-input"
            type="time"
            value={draft.cutoff_time ?? ''}
            onChange={(e) => change({ cutoff_time: e.target.value || null })}
          />
        </label>
        <label className="dash-label">
          Sort order
          <input
            className="dash-input"
            type="number"
            value={draft.sort_order}
            onChange={(e) => change({ sort_order: Number(e.target.value) })}
          />
        </label>
        <label className="dash-label dash-check">
          <input
            type="checkbox"
            checked={draft.is_active}
            onChange={(e) => change({ is_active: e.target.checked })}
          />
          Active — unticking retires this chore. It is never deleted, and past
          history is kept.
        </label>
      </div>

      <h3 className="dash-h3">Who does it, and when</h3>
      <table className="dash-table">
        <thead>
          <tr>
            <th>Person</th>
            {DAYS.map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const dependent = m.role === 'dependent'
            return (
              <tr key={m.id} className={dependent ? 'dash-dependent' : undefined}>
                <th scope="row">
                  {m.name}
                  {dependent && <span className="dash-muted"> · can’t be assigned</span>}
                </th>
                {DAYS.map((_, day) => {
                  const a = has(m.id, day)
                  return (
                    <td key={day}>
                      <input
                        type="checkbox"
                        checked={a !== undefined}
                        disabled={dependent}
                        aria-label={`${m.name}, ${DAYS[day]}`}
                        onChange={() => toggle(m.id, day)}
                      />
                      {a !== undefined && (
                        <select
                          className="dash-parity"
                          value={a.week_parity === null ? '' : String(a.week_parity)}
                          aria-label={`${m.name}, ${DAYS[day]}, which weeks`}
                          onChange={(e) =>
                            setParity(
                              m.id,
                              day,
                              e.target.value === '' ? null : Number(e.target.value),
                            )
                          }
                        >
                          {PARITY.map((p) => (
                            <option key={p.label} value={p.value === null ? '' : String(p.value)}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>

      {error !== null && <p className="dash-error" role="alert">{error}</p>}

      {preview !== null && (
        <div className="dash-preview">
          <h3 className="dash-h3">Tomorrow ({preview.due_on})</h3>
          {preview.appear.length === 0 && preview.disappear.length === 0 && (
            <p className="dash-muted">No change to tomorrow’s board.</p>
          )}
          {preview.appear.map((r, i) => (
            <p key={`a${i}`} className="dash-appear">
              + {r.member_name} — {r.title}
            </p>
          ))}
          {preview.disappear.map((r, i) => (
            <p key={`d${i}`} className="dash-disappear">
              − {r.member_name} — {r.title}
            </p>
          ))}
          <p className="dash-muted">
            Today’s board is not affected. Chores already on it keep the name and
            cutoff they were created with.
          </p>
        </div>
      )}

      <div className="dash-actions">
        <button className="dash-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="dash-secondary"
          disabled={busy}
          onClick={() => run(() => previewDefinition(definition.id, draft).then(setPreview))}
        >
          {busy ? 'Checking…' : 'Check what changes'}
        </button>
        {/* Save is only reachable once the change has been previewed. The
            requirement is to see what a change does BEFORE it saves, and a
            preview you can skip is a preview nobody reads. */}
        <button
          className="dash-primary"
          disabled={busy || preview === null}
          title={preview === null ? 'Check what changes first' : undefined}
          onClick={() => run(() => saveDefinition(definition.id, draft).then(onSaved))}
        >
          Save
        </button>
      </div>
      {preview === null && (
        <p className="dash-muted">Check what changes before saving.</p>
      )}
    </article>
  )
}
