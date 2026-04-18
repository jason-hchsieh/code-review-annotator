import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export type SpecialRef = 'WORKTREE' | 'INDEX'
export const SPECIAL_REFS: ReadonlyArray<SpecialRef> = ['WORKTREE', 'INDEX']

export interface RefEntry {
  kind: 'branch' | 'commit' | 'special'
  ref: string
  sha: string | null
  subject?: string
  date?: string
}

export interface ResolvedRef {
  ref: string
  sha: string | null
  isSpecial: boolean
}

export interface ChangedFile {
  file: string
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'
  oldFile?: string
}

export interface GitError extends Error {
  code: 'NOT_A_REPO' | 'UNKNOWN_REF' | 'GIT_FAILED'
}

function mkErr(code: GitError['code'], message: string): GitError {
  const e = new Error(message) as GitError
  e.code = code
  return e
}

function git(dir: string, args: string[], opts: { allowFail?: boolean; input?: string } = {}): string {
  try {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      input: opts.input,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err: any) {
    if (opts.allowFail) return ''
    const stderr = err?.stderr?.toString?.() ?? ''
    throw mkErr('GIT_FAILED', `git ${args.join(' ')} failed: ${stderr || err.message}`)
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out === 'true'
  } catch {
    return false
  }
}

export function isSpecialRef(ref: string): ref is SpecialRef {
  return ref === 'WORKTREE' || ref === 'INDEX'
}

export function resolveRef(dir: string, ref: string): ResolvedRef {
  if (isSpecialRef(ref)) return { ref, sha: null, isSpecial: true }
  const trimmed = ref.trim()
  if (!trimmed) throw mkErr('UNKNOWN_REF', 'empty ref')
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', `${trimmed}^{commit}`], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return { ref: trimmed, sha, isSpecial: false }
  } catch {
    throw mkErr('UNKNOWN_REF', `cannot resolve ref: ${trimmed}`)
  }
}

export function listRefs(dir: string, limit = 30): RefEntry[] {
  if (!isGitRepo(dir)) return []
  const out: RefEntry[] = SPECIAL_REFS.map(ref => ({ kind: 'special' as const, ref, sha: null }))

  const branchRaw = git(
    dir,
    ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(subject)',
     '--sort=-committerdate', '--count=100', 'refs/heads', 'refs/remotes'],
    { allowFail: true },
  )
  for (const line of branchRaw.split('\n')) {
    if (!line.trim()) continue
    const [ref, sha, date, ...rest] = line.split('\t')
    out.push({ kind: 'branch', ref, sha, date, subject: rest.join('\t') })
  }

  const logRaw = git(
    dir,
    ['log', '--pretty=format:%H%x09%ci%x09%s', `-n${limit}`, 'HEAD'],
    { allowFail: true },
  )
  for (const line of logRaw.split('\n')) {
    if (!line.trim()) continue
    const [sha, date, ...rest] = line.split('\t')
    out.push({ kind: 'commit', ref: sha, sha, date, subject: rest.join('\t') })
  }
  return out
}

export interface GraphCommit {
  sha: string
  parents: string[]
  author: string
  date: string
  subject: string
  refs: string[]
  isHead: boolean
}

export interface GraphData {
  commits: GraphCommit[]
  headSha: string | null
  headRef: string | null
}

/**
 * Return commit topology for the visual range picker. Walks `--all` so feature
 * branches and detached commits are included. Refs (tags + local/remote
 * branches) are attached to their tip commit.
 */
export function listGraphCommits(dir: string, limit = 80): GraphData {
  if (!isGitRepo(dir)) return { commits: [], headSha: null, headRef: null }

  const SEP = '\x1f'
  const raw = git(
    dir,
    ['log', '--all', '--date-order', `-n${limit}`,
     `--pretty=format:%H${SEP}%P${SEP}%an${SEP}%cI${SEP}%s`],
    { allowFail: true },
  )

  const refsAtCommit = new Map<string, string[]>()
  const refRaw = git(
    dir,
    ['for-each-ref', '--format=%(objectname)\t%(refname:short)\t%(refname)',
     'refs/heads', 'refs/remotes', 'refs/tags'],
    { allowFail: true },
  )
  for (const line of refRaw.split('\n')) {
    if (!line.trim()) continue
    const [sha, short, full] = line.split('\t')
    if (!sha) continue
    if (full?.startsWith('refs/remotes/') && short?.endsWith('/HEAD')) continue
    const arr = refsAtCommit.get(sha) ?? []
    arr.push(short)
    refsAtCommit.set(sha, arr)
  }

  let headSha: string | null = null
  let headRef: string | null = null
  try {
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null
  } catch { /* detached or empty repo */ }
  try {
    const out = execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) headRef = out
  } catch { /* detached HEAD */ }

  const commits: GraphCommit[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const parts = line.split(SEP)
    if (parts.length < 5) continue
    const [sha, parentStr, author, date, subject] = parts
    const parents = parentStr.trim() ? parentStr.trim().split(/\s+/) : []
    commits.push({
      sha,
      parents,
      author,
      date,
      subject,
      refs: refsAtCommit.get(sha) ?? [],
      isHead: sha === headSha,
    })
  }

  return { commits, headSha, headRef }
}

export function isAncestor(dir: string, a: string, b: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], {
      cwd: dir, stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

export function mergeBase(dir: string, a: string, b: string): string | null {
  try {
    const out = execFileSync('git', ['merge-base', a, b], {
      cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function parseNameStatus(raw: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    const status = parts[0] ?? ''
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldFile = parts[1]
      const file = parts[2] ?? parts[1] ?? ''
      files.push({ file, status: status[0] as ChangedFile['status'], oldFile })
    } else {
      const file = parts[1] ?? ''
      const s = (status[0] ?? 'M') as ChangedFile['status']
      files.push({ file, status: s })
    }
  }
  return files
}

/**
 * List changed files between two refs. Either side may be a commit SHA, or the
 * special WORKTREE / INDEX markers. The returned files are expressed relative
 * to the repo root.
 */
export function listChangedFiles(dir: string, fromRef: string, toRef: string): ChangedFile[] {
  const from = isSpecialRef(fromRef) ? fromRef : fromRef
  const to = isSpecialRef(toRef) ? toRef : toRef

  // Cases involving WORKTREE/INDEX use `git diff` with no `..`.
  if (from === 'WORKTREE' && to === 'WORKTREE') return []
  if (from === 'INDEX' && to === 'INDEX') return []

  // INDEX → WORKTREE
  if (from === 'INDEX' && to === 'WORKTREE') {
    const raw = git(dir, ['diff', '--name-status', '--no-renames'], { allowFail: true })
    return parseNameStatus(raw)
  }
  // WORKTREE → INDEX (reverse, rare)
  if (from === 'WORKTREE' && to === 'INDEX') {
    const raw = git(dir, ['diff', '--name-status', '--no-renames', '-R'], { allowFail: true })
    return parseNameStatus(raw)
  }

  // <commit> → INDEX  (staged changes)
  if (to === 'INDEX' && !isSpecialRef(from)) {
    const raw = git(dir, ['diff', '--cached', '--name-status', '--no-renames', from], { allowFail: true })
    return parseNameStatus(raw)
  }
  // INDEX → <commit>
  if (from === 'INDEX' && !isSpecialRef(to)) {
    const raw = git(dir, ['diff', '--cached', '--name-status', '--no-renames', '-R', to], { allowFail: true })
    return parseNameStatus(raw)
  }

  // <commit> → WORKTREE  (all unstaged + untracked changes vs commit)
  if (to === 'WORKTREE' && !isSpecialRef(from)) {
    const tracked = parseNameStatus(
      git(dir, ['diff', '--name-status', '--no-renames', from], { allowFail: true }),
    )
    // Include untracked files (not ignored) as "added".
    const untrackedRaw = git(
      dir, ['ls-files', '--others', '--exclude-standard'], { allowFail: true },
    )
    const seen = new Set(tracked.map(f => f.file))
    for (const line of untrackedRaw.split('\n')) {
      const file = line.trim()
      if (!file || seen.has(file)) continue
      tracked.push({ file, status: 'A' })
    }
    return tracked
  }
  // WORKTREE → <commit>
  if (from === 'WORKTREE' && !isSpecialRef(to)) {
    const tracked = parseNameStatus(
      git(dir, ['diff', '--name-status', '--no-renames', '-R', to], { allowFail: true }),
    )
    return tracked
  }

  // <commit> → <commit> (both real commits)
  const raw = git(
    dir, ['diff', '--name-status', '--no-renames', `${from}..${to}`], { allowFail: true },
  )
  return parseNameStatus(raw)
}

/**
 * Read file contents at a given ref. Returns empty string for "file does not
 * exist at this ref" (which the UI renders as "added" / "deleted"). Returns
 * null for irrecoverable errors so the caller can surface a placeholder.
 */
export function readBlob(dir: string, ref: string, file: string): string {
  if (ref === 'WORKTREE') {
    const full = path.join(dir, file)
    try {
      return fs.readFileSync(full, 'utf-8')
    } catch {
      return ''
    }
  }
  if (ref === 'INDEX') {
    // `git show :path` reads the staged blob.
    const out = git(dir, ['show', `:${file}`], { allowFail: true })
    return out
  }
  const out = git(dir, ['show', `${ref}:${file}`], { allowFail: true })
  return out
}

/**
 * List every file in the worktree that git considers relevant (tracked +
 * untracked, minus anything matched by `.gitignore` / `core.excludesFile`).
 */
export function listWorktreeFiles(dir: string): string[] {
  if (!isGitRepo(dir)) return []
  const raw = git(dir, ['ls-files', '--cached', '--others', '--exclude-standard'], { allowFail: true })
  const files = new Set<string>()
  for (const line of raw.split('\n')) {
    const f = line.trim()
    if (f) files.add(f)
  }
  return Array.from(files).sort()
}
