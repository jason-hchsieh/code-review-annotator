import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export type WatcherEvent = { type: 'log' } | { type: 'worktree' }

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

/** Cheap signature covering commits, staging, and worktree modifications to
 *  tracked + untracked files. We combine:
 *   - `.git/HEAD` mtime (branch switches, new commits move HEAD)
 *   - `.git/index` mtime (staging changes the index)
 *   - `git status --porcelain=v1` output (paths + status letters)
 *   - mtime of each file listed in that output (catches repeated edits to an
 *     already-modified file, which would leave `git status` output identical)
 *
 *  Returns 'not-a-repo' when `.git` is missing, so non-git project dirs short-
 *  circuit without shelling out to git every tick.
 */
function worktreeSignature(dir: string): string {
  const gitDir = path.join(dir, '.git')
  let headMs = 0
  let indexMs = 0
  try {
    headMs = fs.statSync(path.join(gitDir, 'HEAD')).mtimeMs
  } catch {
    return 'not-a-repo'
  }
  try {
    indexMs = fs.statSync(path.join(gitDir, 'index')).mtimeMs
  } catch {
    // fresh repo with no index yet — fine, treat as 0
  }
  let statusOut = ''
  try {
    statusOut = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    // If git status fails (e.g. corrupt repo), fall back to mtime-only
    // signature rather than spamming events.
  }
  let fileMtimes = 0
  for (const line of statusOut.split('\n')) {
    if (!line) continue
    // porcelain v1 format: `XY path` (status letters + space + path). Rename
    // lines carry ` -> ` separator; we only need the final path either way.
    const rest = line.slice(3)
    const arrow = rest.indexOf(' -> ')
    const rel = arrow >= 0 ? rest.slice(arrow + 4) : rest
    const p = rel.trim().replace(/^"(.*)"$/, '$1')
    if (!p) continue
    try {
      fileMtimes = (fileMtimes * 31 + Math.floor(fs.statSync(path.join(dir, p)).mtimeMs)) | 0
    } catch {
      // file may have been deleted between the git status call and the stat
    }
  }
  return `${headMs}:${indexMs}:${hashString(statusOut)}:${fileMtimes}`
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h
}

export function startProjectWatcher(
  dir: string,
  onEvent: (event: WatcherEvent) => void,
): () => void {
  let lastLog = logSignature(dir)
  let lastWorktree = worktreeSignature(dir)
  let running = true

  const timer = setInterval(() => {
    if (!running) return
    const logSig = logSignature(dir)
    if (logSig !== lastLog) {
      lastLog = logSig
      onEvent({ type: 'log' })
    }
    const wtSig = worktreeSignature(dir)
    if (wtSig !== lastWorktree) {
      lastWorktree = wtSig
      onEvent({ type: 'worktree' })
    }
  }, INTERVAL_MS)

  return () => {
    running = false
    clearInterval(timer)
  }
}
