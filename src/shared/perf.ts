export type Cancellable = (() => void) & { cancel: () => void }

export function throttleTrailing(fn: () => void, windowMs: number): Cancellable {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const wrapped = (() => {
    const now = Date.now()
    const elapsed = now - last
    if (elapsed >= windowMs && timer === null) {
      last = now
      fn()
      return
    }
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        fn()
      }, Math.max(0, windowMs - elapsed))
    }
  }) as Cancellable
  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return wrapped
}

export function coalesceAsyncRefresh(fn: () => Promise<void>, minIntervalMs: number): Cancellable {
  let lastRun = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let queued = false

  const schedule = (delayMs: number) => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      run()
    }, Math.max(0, delayMs))
  }
  const run = () => {
    lastRun = Date.now()
    inFlight = true
    void Promise.resolve()
      .then(fn)
      .catch(() => {
      })
      .finally(() => {
        inFlight = false
        if (queued) {
          queued = false
          schedule(0)
        }
      })
  }
  const wrapped = (() => {
    if (inFlight) {
      queued = true
      return
    }
    if (typeof document !== 'undefined' && document.hidden) {
      schedule(minIntervalMs)
      return
    }
    const elapsed = Date.now() - lastRun
    if (elapsed >= minIntervalMs && timer === null) run()
    else schedule(minIntervalMs - elapsed)
  }) as Cancellable
  wrapped.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    queued = false
  }
  return wrapped
}
