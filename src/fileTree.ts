import * as fs from 'node:fs'
import * as path from 'node:path'
import ignore, { type Ignore } from 'ignore'

const HARD_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  '.review-comments.json',
]

const HARD_EXCLUDE_PATTERNS = [
  'node_modules/',
  '.git/',
  'dist/',
  '*.lock',
  '.review-comments.json',
]

export function buildIgnoreFilter(dir: string): Ignore {
  const ig = ignore()
  ig.add(HARD_EXCLUDE_PATTERNS)

  for (const filename of ['.gitignore', '.claudeignore']) {
    const filePath = path.join(dir, filename)
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8')
      ig.add(content)
    }
  }

  return ig
}

export interface FileTreeNode {
  name: string
  path: string       // relative to dir
  type: 'file' | 'dir'
  children?: FileTreeNode[]
}

export function scanDirectory(dir: string, ig: Ignore, relativePath = ''): FileTreeNode[] {
  const entries = fs.readdirSync(path.join(dir, relativePath), { withFileTypes: true })
  const nodes: FileTreeNode[] = []

  for (const entry of entries) {
    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

    // Hard exclude by name first (fast path)
    if (HARD_EXCLUDES.includes(entry.name)) continue

    // ignore filter (needs trailing slash for directories)
    const checkPath = entry.isDirectory() ? `${relPath}/` : relPath
    if (ig.ignores(checkPath)) continue

    if (entry.isDirectory()) {
      const children = scanDirectory(dir, ig, relPath)
      nodes.push({ name: entry.name, path: relPath, type: 'dir', children })
    } else {
      nodes.push({ name: entry.name, path: relPath, type: 'file' })
    }
  }

  return nodes.sort((a, b) => {
    // dirs first, then files
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function getFileTree(dir: string): FileTreeNode[] {
  const ig = buildIgnoreFilter(dir)
  return scanDirectory(dir, ig)
}
