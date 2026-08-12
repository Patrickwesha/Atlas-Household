// Dashboard data layer. Separate from the kiosk's api.ts on purpose: different
// token, different storage, different lifetime. Nothing here is importable into
// the kiosk bundle by accident, because they are separate Vite entries.

const BASE = import.meta.env.VITE_API_BASE_URL

// sessionStorage, NOT localStorage, and that is the entire answer to "a parent
// session sitting on the wall iPad". sessionStorage dies when the tab closes,
// so signing in on the kitchen screen cannot leave a logged-in dashboard behind
// for the kids. localStorage would survive reboots.
const SESSION = 'atlas.dashboard.session'

export interface Session {
  token: string
  expires_at: string
  member_id: string
  member_name: string
}

export interface AssignmentSpec {
  member_id: string
  day_of_week: number
  week_parity: number | null
}

export interface AdminDefinition {
  id: string
  name: string
  area: string | null
  cadence: string
  cutoff_time: string | null
  sort_order: number
  is_active: boolean
  assignments: AssignmentSpec[]
}

export interface PreviewRow {
  member_name: string
  title: string
}
export interface PreviewResult {
  due_on: string
  appear: PreviewRow[]
  disappear: PreviewRow[]
}

export interface Member {
  id: string
  name: string
  role: 'adult' | 'kid' | 'dependent'
  color: string
}

export class AuthExpired extends Error {}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION)
    if (raw === null) return null
    const s = JSON.parse(raw) as Session
    // An expired token is the same as no token. Checked here so the UI shows
    // the sign-in screen rather than a dashboard that 401s on every action.
    if (Date.parse(s.expires_at) <= Date.now()) {
      sessionStorage.removeItem(SESSION)
      return null
    }
    return s
  } catch {
    return null
  }
}

export function saveSession(s: Session): void {
  sessionStorage.setItem(SESSION, JSON.stringify(s))
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION)
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const session = loadSession()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: {
      ...(init?.headers ?? {}),
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (res.status === 401) {
    clearSession()
    throw new AuthExpired('Your session ended. Sign in again.')
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as { detail?: string }
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      /* non-JSON error body; keep the status message */
    }
    throw new Error(detail)
  }
  return (await res.json()) as T
}

export async function login(email: string, password: string): Promise<Session> {
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(body.detail ?? 'Wrong email or password')
  }
  const session = (await res.json()) as Session
  saveSession(session)
  return session
}

export const listDefinitions = (): Promise<AdminDefinition[]> =>
  call<AdminDefinition[]>('/api/admin/definitions')

export const listMembers = (): Promise<Member[]> => call<Member[]>('/api/admin/members')

export const previewDefinition = (
  id: string,
  body: Omit<AdminDefinition, 'id' | 'cadence'>,
): Promise<PreviewResult> =>
  call<PreviewResult>(`/api/admin/definitions/${id}/preview`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const saveDefinition = (
  id: string,
  body: Omit<AdminDefinition, 'id' | 'cadence'>,
): Promise<AdminDefinition> =>
  call<AdminDefinition>(`/api/admin/definitions/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
