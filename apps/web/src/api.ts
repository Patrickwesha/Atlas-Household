// Data layer for the kiosk: types + a thin fetch wrapper.
//
// The device token lives in localStorage (set once via the setup screen) and is
// sent as an Authorization: Bearer header. It is NEVER a VITE_ var. The only
// VITE_ var is VITE_API_BASE_URL, which is safe to inline into the public bundle.

export type Role = 'adult' | 'kid' | 'dependent'

export interface Member {
  id: string
  name: string
  role: Role
  color: string
}

export interface Household {
  id: string
  name: string
}

export interface Instance {
  id: string
  assignee_id: string
  title: string
  due_on: string
  completed_at: string | null
  completed_by: string | null
}

export interface Board {
  household: Household
  members: Member[]
  instances: Instance[]
}

const BASE = import.meta.env.VITE_API_BASE_URL
const TOKEN_KEY = 'atlas_device_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

// Two distinct failure types so the UI can tell "server said no" (esp. 401)
// from "couldn't reach the server at all" — the difference between re-auth and
// an explicit offline banner, and never a blank board that reads as "all done".
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}
export class NetworkError extends Error {
  constructor(message = 'Could not reach the server') {
    super(message)
    this.name = 'NetworkError'
  }
}

// A header value must be sendable ASCII. A token pasted with a non-breaking
// space or a zero-width space (both survive a copy out of chat or email) makes
// fetch() throw before any request leaves the device — which used to surface as
// NetworkError, i.e. "Can't reach the server", forever: no response means no
// 401, and 401 is the only thing that clears a bad token. The kiosk could not
// be recovered from the iPad. Treat an unsendable token as what it is — a bad
// token — so it takes the same path as any other rejected one.
function isSendable(token: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x21-\x7e]+$/.test(token)
}

// Every request must settle. Without a deadline a dropped Wi-Fi link leaves the
// socket in TCP retransmit for minutes, and a row lock on the server blocks a
// write with no bound at all (there is no statement_timeout). A request that
// never settles is worse here than a failed one: the caller's cleanup never
// runs, so the row keeps its optimistic tick and stops accepting taps — a
// permanent false ✓ on a wall display. Generous enough for a cold Lambda.
const TIMEOUT_MS = 20_000

function timeoutSignal(ms: number): AbortSignal | undefined {
  // AbortSignal.timeout is iPadOS 16+. Older Safari simply gets the old
  // behaviour rather than a crash.
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = TIMEOUT_MS,
): Promise<T> {
  const token = getToken()
  if (token !== null && !isSendable(token)) {
    throw new ApiError(401, 'Stored device token contains characters that cannot be sent')
  }
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: timeoutSignal(timeoutMs),
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
  } catch {
    throw new NetworkError()
  }
  if (!res.ok) {
    throw new ApiError(res.status, `Request to ${path} failed (${res.status})`)
  }
  return (await res.json()) as T
}

// timeoutMs is overridable so a reconcile after a failed write can use a much
// smaller budget. Stacking two full 20s deadlines meant a wifi drop said nothing
// at all for 40 seconds.
export function getBoard(timeoutMs?: number): Promise<Board> {
  return request<Board>('/api/board', undefined, timeoutMs)
}

export function completeInstance(id: string, completedBy: string): Promise<Instance> {
  return request<Instance>(`/api/instances/${id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ completed_by: completedBy }),
  })
}

export function uncompleteInstance(id: string): Promise<Instance> {
  return request<Instance>(`/api/instances/${id}/uncomplete`, { method: 'POST' })
}
