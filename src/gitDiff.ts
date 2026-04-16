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
  content: string  // without the leading +/-/ prefix
}

export interface ParsedDiff {
  file: string
  hunks: ParsedHunk[]
  rawDiff: string
}

export async function getChangedFiles(dir: string, baseCommit: string): Promise<FileDiffStat[]> {
  const git = simpleGit(dir)
  let diffOutput: string

  try {
    diffOutput = await git.raw(['diff', '--numstat', baseCommit])
    // If comparing to a commit yields nothing (e.g. all changes are staged),
    // fall through to the cached comparison below.
    if (!diffOutput.trim()) {
      diffOutput = await git.raw(['diff', '--numstat', '--cached', baseCommit])
    }
  } catch {
    diffOutput = await git.raw(['diff', '--numstat', '--cached'])
  }

  const result: FileDiffStat[] = []

  // Parse lines like: "808\t0\tsrc/foo.ts"
  // Binary files show "-\t-\t<file>" — skip them.
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

export async function getFileDiff(dir: string, file: string, baseCommit: string): Promise<string> {
  const git = simpleGit(dir)
  try {
    return await git.raw(['diff', baseCommit, '--', file])
  } catch {
    return await git.raw(['diff', '--cached', '--', file])
  }
}

export function parseDiff(rawDiff: string, file: string): ParsedDiff {
  const hunks: ParsedHunk[] = []
  const lines = rawDiff.split('\n')

  let currentHunk: ParsedHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    // Hunk header: @@ -40,6 +40,8 @@ optional context
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
  baseCommit: string,
): Promise<string[]> {
  const git = simpleGit(dir)

  let content: string
  if (side === 'old') {
    try {
      content = await git.raw(['show', `${baseCommit}:${file}`])
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
  // line numbers are 1-based
  return fileLines.slice(startLine - 1, endLine)
}
