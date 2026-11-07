type MediaEl = HTMLAudioElement | HTMLVideoElement

const RETRY_DELAYS_MS = [250, 1000, 3000]

const pendingGestureRetry = new WeakMap<MediaEl, () => void>()

function onFirstGesture(el: MediaEl, retry: () => void) {
  const events = ['pointerdown', 'touchstart', 'keydown', 'click'] as const
  const done = () => {
    for (const e of events) window.removeEventListener(e, done, true)
    pendingGestureRetry.delete(el)
    retry()
  }
  for (const e of events) window.addEventListener(e, done, true)
  pendingGestureRetry.set(el, done)
}

export function attachStream(el: MediaEl | null, stream: MediaStream | null | undefined): void {
  if (!el || !stream) return
  try {
    if (el.srcObject !== stream) el.srcObject = stream
  } catch {  }

  const attempt = (n: number) => {
    if (el.srcObject !== stream) return
    void Promise.resolve(el.play?.())
      .then(() => {  })
      .catch(() => {
        if (n < RETRY_DELAYS_MS.length) {
          window.setTimeout(() => attempt(n + 1), RETRY_DELAYS_MS[n])
        } else if (!pendingGestureRetry.has(el)) {
          onFirstGesture(el, () => { void el.play?.().catch(() => {}) })
        }
      })
  }
  attempt(0)
}

export function detachStream(el: MediaEl | null): void {
  if (!el) return
  const done = pendingGestureRetry.get(el)
  if (done) {
    for (const e of ['pointerdown', 'touchstart', 'keydown', 'click'] as const) {
      window.removeEventListener(e, done, true)
    }
    pendingGestureRetry.delete(el)
  }
  try { el.srcObject = null } catch {  }
}
