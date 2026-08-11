// Desktop notifications for newly-late chores.
//
// NO SERVICE WORKER, deliberately. `new Notification()` works directly on
// desktop browsers, and adding a service worker to get iOS support would mean
// taking on an offline cache for a wall display whose whole job is showing the
// CURRENT board — a stale-cache bug there is worse than the feature is worth.
//
// WHICH MEANS THIS IS DESKTOP ONLY, and the code says so rather than pretending
// otherwise. iOS Safari exposes no usable Notification constructor outside an
// installed PWA, and inside one it requires exactly the service worker we are
// not adding. On the wall iPad `supported()` is false, the button never
// appears, and nothing about the late states changes — they are carried by
// colour, words and icon regardless (see CLAUDE.md).

export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied'

/** Whether this browser can show a notification without a service worker. */
function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notifyState(): NotifyState {
  if (!supported()) return 'unsupported'
  return Notification.permission as NotifyState
}

/** Ask for permission. MUST be called from a real user gesture.
 *
 *  Never called on page load: browsers reject — and increasingly punish — a
 *  permission prompt that appears without one, and a wall display that begs for
 *  permission every morning is one someone permanently denies. */
export async function requestNotify(): Promise<NotifyState> {
  if (!supported()) return 'unsupported'
  try {
    return (await Notification.requestPermission()) as NotifyState
  } catch {
    return notifyState()
  }
}

/** One notification for a batch of newly-late chores.
 *
 *  A batch, not one each: four family-reset rows cross 10:15 together, and four
 *  separate notifications is the same mistake as four chimes — the thing gets
 *  turned off, and then it protects nothing. `tag` lets the browser collapse a
 *  repeat rather than stacking. */
export function notifyLate(titles: string[]): void {
  if (!supported() || Notification.permission !== 'granted' || titles.length === 0) return
  const body =
    titles.length === 1
      ? titles[0]
      : `${titles.slice(0, 3).join(', ')}${titles.length > 3 ? `, and ${titles.length - 3} more` : ''}`
  try {
    new Notification(
      titles.length === 1 ? '1 chore is late' : `${titles.length} chores are late`,
      { body, tag: 'atlas-late', silent: false },
    )
  } catch {
    // Some browsers throw on construction in odd contexts. A failed
    // notification must never break the board.
  }
}
