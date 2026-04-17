import * as fs from 'node:fs'
import * as path from 'node:path'
import { getHeadSha, resolveBaseSha, getPorcelainStatus } from './gitDiff.ts'

export type WatcherEvent = { type: 'comments' } | { type: 'diff' }

const INTERVAL_MS = 1500

function commentsSignature(dir: string): string {
  try {
    const st = fs.statSync(path.join(dir, '.review-comments.json'))
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

async function diffSignature(dir: string, baseBranch: string): Promise<string> {
  try {
    const [headSha, baseSha, porcelain] = await Promise.all([
      getHeadSha(dir),
      resolveBaseSha(dir, baseBranch),
      getPorcelainStatus(dir),
    ])
    return `${headSha}:${baseSha}:${porcelain}`
  } catch (err) {
    return `error:${String(err)}`
  }
}

export function startProjectWatcher(
  dir: string,
  baseBranch: string,
  onEvent: (event: WatcherEvent) => void,
): () => void {
  let lastComments = commentsSignature(dir)
  let lastDiff: string | null = null
  let running = true
  let ticking = false

  diffSignature(dir, baseBranch).then(sig => { lastDiff = sig })

  const timer = setInterval(async () => {
    if (!running || ticking) return
    ticking = true
    try {
      const comments = commentsSignature(dir)
      if (comments !== lastComments) {
        lastComments = comments
        onEvent({ type: 'comments' })
      }

      const diff = await diffSignature(dir, baseBranch)
      if (lastDiff !== null && diff !== lastDiff) {
        onEvent({ type: 'diff' })
      }
      lastDiff = diff
    } finally {
      ticking = false
    }
  }, INTERVAL_MS)

  return () => {
    running = false
    clearInterval(timer)
  }
}
