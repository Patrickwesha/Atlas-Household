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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
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

export function getBoard(): Promise<Board> {
  return request<Board>('/api/board')
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
