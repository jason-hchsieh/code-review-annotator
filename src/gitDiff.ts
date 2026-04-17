import { simpleGit } from 'simple-git'

export interface FileDiffStat {
  file: string
  added: number
  deleted: number
}

export interface ParsedHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: ParsedLine[]
}

export interface ParsedLine {
  type: 'context' | 'added' | 'deleted'
  oldLine: number | null
  newLine: number | null
  content: string
}

export interface ParsedDiff {
  file: string
  hunks: ParsedHunk[]
  rawDiff: string
}

export async function resolveMergeBase(dir: string, baseBranch: string): Promise<string> {
  const git = simpleGit(dir)
  const out = await git.raw(['merge-base', 'HEAD', baseBranch])
  return out.trim()
}

export async function getHeadSha(dir: string): Promise<string> {
  const git = simpleGit(dir)
  const out = await git.raw(['rev-parse', 'HEAD'])
  return out.trim()
}

export async function detectDefaultBase(dir: string): Promise<string | null> {
  const git = simpleGit(dir)
  for (const branch of ['main', 'master']) {
    try {
      await git.raw(['rev-parse', '--verify', branch])
      return branch
    } catch {
      // try next
    }
  }
  return null
}

export async function getChangedFiles(dir: string, baseBranch: string): Promise<FileDiffStat[]> {
  const git = simpleGit(dir)
  const mergeBase = await resolveMergeBase(dir, baseBranch)

  const diffOutput = await git.raw(['diff', '--numstat', mergeBase])

  const result: FileDiffStat[] = []
  for (const line of diffOutput.split('\n')) {
    const match = line.match(/^(\d+)\t(\d+)\t(.+)$/)
    if (!match) continue
    result.push({
      file: match[3].trim(),
      added: parseInt(match[1], 10),
      deleted: parseInt(match[2], 10),
    })
  }
  return result
}

export async function getFileDiff(dir: string, file: string, baseBranch: string): Promise<string> {
  const git = simpleGit(dir)
  const mergeBase = await resolveMergeBase(dir, baseBranch)
  return git.raw(['diff', mergeBase, '--', file])
}

export function parseDiff(rawDiff: string, file: string): ParsedDiff {
  const hunks: ParsedHunk[] = []
  const lines = rawDiff.split('\n')

  let currentHunk: ParsedHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk)
      oldLine = parseInt(hunkMatch[1], 10)
      newLine = parseInt(hunkMatch[3], 10)
      currentHunk = {
        oldStart: oldLine,
        oldCount: parseInt(hunkMatch[2] ?? '1', 10),
        newStart: newLine,
        newCount: parseInt(hunkMatch[4] ?? '1', 10),
        lines: [],
      }
      continue
    }

    if (!currentHunk) continue

    if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'deleted', oldLine: oldLine++, newLine: null, content: line.slice(1) })
    } else if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'added', oldLine: null, newLine: newLine++, content: line.slice(1) })
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({ type: 'context', oldLine: oldLine++, newLine: newLine++, content: line.slice(1) })
    } else if (line === '\\ No newline at end of file') {
      // skip
    }
  }

  if (currentHunk) hunks.push(currentHunk)

  return { file, hunks, rawDiff }
}

export async function getSourceLines(
  dir: string,
  file: string,
  startLine: number,
  endLine: number,
  side: 'old' | 'new',
  baseBranch: string,
): Promise<string[]> {
  const git = simpleGit(dir)

  let content: string
  if (side === 'old') {
    try {
      const mergeBase = await resolveMergeBase(dir, baseBranch)
      content = await git.raw(['show', `${mergeBase}:${file}`])
    } catch {
      return []
    }
  } else {
    try {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      content = readFileSync(join(dir, file), 'utf-8')
    } catch {
      return []
    }
  }

  const fileLines = content.split('\n')
  return fileLines.slice(startLine - 1, endLine)
}
