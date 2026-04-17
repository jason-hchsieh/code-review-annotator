import * as fs from 'node:fs'
import * as path from 'node:path'

export type WatcherEvent = { type: 'log' }

const INTERVAL_MS = 1500
const LOG_FILE = '.review-log.json'

function logSignature(dir: string): string {
  try {
    const st = fs.statSync(path.join(dir, LOG_FILE))
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

export function startProjectWatcher(
  dir: string,
  onEvent: (event: WatcherEvent) => void,
): () => void {
  let last = logSignature(dir)
  let running = true

  const timer = setInterval(() => {
    if (!running) return
    const sig = logSignature(dir)
    if (sig !== last) {
      last = sig
      onEvent({ type: 'log' })
    }
  }, INTERVAL_MS)

  return () => {
    running = false
    clearInterval(timer)
  }
}
