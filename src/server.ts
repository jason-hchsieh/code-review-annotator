import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CommentStore, ReviewComment } from './comments.ts'
import { getChangedFiles, getFileDiff, parseDiff, getSourceLines, getHeadSha } from './gitDiff.ts'
import { getFileTree } from './fileTree.ts'
import { listProjects, RegistryProject } from './registry.ts'

function json(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

async function enrichComments(
  comments: ReviewComment[],
  dir: string,
  baseBranch: string,
): Promise<Array<ReviewComment & { sourceLines: string[]; outdated: boolean }>> {
  return Promise.all(
    comments.map(async (c) => {
      const sourceLines = await getSourceLines(dir, c.file, c.startLine, c.endLine, c.side, baseBranch)
      const outdated = c.anchorSnippet && c.anchorSnippet.length > 0
        ? !arraysEqual(sourceLines, c.anchorSnippet)
        : false
      return { ...c, sourceLines, outdated }
    }),
  )
}

function generateExportPrompt(
  comments: ReviewComment[],
  mode: 'fix' | 'report' | 'both',
): string {
  if (comments.length === 0) return '// No open comments found.'

  const byFile: Record<string, ReviewComment[]> = {}
  for (const c of comments) {
    if (!byFile[c.file]) byFile[c.file] = []
    byFile[c.file].push(c)
  }

  const lines: string[] = []

  if (mode === 'fix' || mode === 'both') {
    lines.push('Please fix the following issues:\n')
    for (const [file, fileComments] of Object.entries(byFile)) {
      lines.push(`### ${file}`)
      for (const c of fileComments) {
        const lineRef = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–L${c.endLine}`
        lines.push(`- ${lineRef}: ${c.body}`)
      }
      lines.push('')
    }
  }

  if (mode === 'report' || mode === 'both') {
    if (mode === 'both') lines.push('---\n')
    lines.push('## Review Summary\n')
    for (const [file, fileComments] of Object.entries(byFile)) {
      lines.push(`### ${file}`)
      for (const c of fileComments) {
        const lineRef = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–L${c.endLine}`
        lines.push(`- **${lineRef}**: ${c.body}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function homeRelative(dir: string): string {
  const home = process.env.HOME ?? ''
  if (home && dir.startsWith(home + '/')) return '~/' + dir.slice(home.length + 1)
  return dir
}

function projectName(dir: string): string {
  const base = path.basename(dir)
  const parent = path.basename(path.dirname(dir))
  return parent ? `${parent}/${base}` : base
}

export function startHttpServer(port: number) {
  function resolveProject(query: URLSearchParams): RegistryProject | null {
    const requested = query.get('project')
    const projects = listProjects()
    if (requested) {
      const resolved = path.resolve(requested)
      return projects.find(p => p.dir === resolved) ?? null
    }
    return projects[0] ?? null
  }

  const publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public')

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url ?? '/', 'http://localhost')
    const pathname = parsed.pathname
    const query = parsed.searchParams
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' })
      res.end()
      return
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    if (pathname === '/' || pathname === '/index.html') {
      const indexPath = path.join(publicDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(fs.readFileSync(indexPath))
      } else {
        res.writeHead(404)
        res.end('index.html not found')
      }
      return
    }

    try {
      if (method === 'GET' && pathname === '/api/projects') {
        const projects = listProjects().map(p => ({
          id: p.dir,
          dir: p.dir,
          displayPath: homeRelative(p.dir),
          name: projectName(p.dir),
          baseBranch: p.baseBranch,
          registeredAt: p.registeredAt,
        }))
        return json(res, 200, projects)
      }

      const project = resolveProject(query)
      if (!project) {
        return json(res, 400, { error: 'no project registered or specified' })
      }
      const { dir, baseBranch } = project
      const store = new CommentStore(dir, baseBranch)

      if (method === 'GET' && pathname === '/api/files') {
        const tree = getFileTree(dir)
        return json(res, 200, tree)
      }

      if (method === 'GET' && pathname === '/api/diff') {
        const file = query.get('file')
        if (!file) return json(res, 400, { error: 'file param required' })
        const rawDiff = await getFileDiff(dir, file, baseBranch)
        return json(res, 200, parseDiff(rawDiff, file))
      }

      if (method === 'GET' && pathname === '/api/diff/summary') {
        const files = await getChangedFiles(dir, baseBranch)
        return json(res, 200, files)
      }

      if (method === 'GET' && pathname === '/api/meta') {
        return json(res, 200, {
          baseBranch,
          dir,
          displayPath: homeRelative(dir),
          name: projectName(dir),
        })
      }

      if (method === 'GET' && pathname === '/api/comments') {
        const fileFilter = query.get('file') ?? undefined
        const statusFilter = (query.get('status') as 'open' | 'resolved' | null) ?? undefined
        const raw = store.getComments({ file: fileFilter, status: statusFilter })
        const enriched = await enrichComments(raw, dir, baseBranch)
        return json(res, 200, enriched)
      }

      if (method === 'POST' && pathname === '/api/comments') {
        const body = JSON.parse(await readBody(req))
        const { file, startLine, endLine, side, body: commentBody } = body
        if (!file || !startLine || !side || !commentBody) {
          return json(res, 400, { error: 'file, startLine, side, body required' })
        }
        const sLine = Number(startLine)
        const eLine = Number(endLine ?? startLine)
        const [commitSha, anchorSnippet] = await Promise.all([
          getHeadSha(dir),
          getSourceLines(dir, file, sLine, eLine, side, baseBranch),
        ])
        const comment = store.addComment({
          file,
          startLine: sLine,
          endLine: eLine,
          side,
          body: commentBody,
          commitSha,
          anchorSnippet,
        })
        return json(res, 201, comment)
      }

      const commentMatch = pathname.match(/^\/api\/comments\/([^/]+)$/)
      if (method === 'PATCH' && commentMatch) {
        const id = commentMatch[1]
        const body = JSON.parse(await readBody(req))
        const updated = store.updateComment(id, { body: body.body, status: body.status })
        if (!updated) return json(res, 404, { error: 'not found' })
        return json(res, 200, updated)
      }

      if (method === 'DELETE' && commentMatch) {
        const id = commentMatch[1]
        const deleted = store.deleteComment(id)
        if (!deleted) return json(res, 404, { error: 'not found' })
        return json(res, 200, { ok: true })
      }

      const replyMatch = pathname.match(/^\/api\/comments\/([^/]+)\/replies$/)
      if (method === 'POST' && replyMatch) {
        const id = replyMatch[1]
        const body = JSON.parse(await readBody(req))
        if (!body.body) return json(res, 400, { error: 'body required' })
        const reply = store.addReply(id, body.author ?? 'human', body.body)
        if (!reply) return json(res, 404, { error: 'not found' })
        return json(res, 201, reply)
      }

      if (method === 'GET' && pathname === '/api/export') {
        const fileFilter = query.get('file')
        const mode = (query.get('mode') as 'fix' | 'report' | 'both' | null) ?? 'both'
        const comments = store.getComments({ status: 'open', ...(fileFilter ? { file: fileFilter } : {}) })
        const prompt = generateExportPrompt(comments, mode)
        return json(res, 200, { prompt })
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      console.error(err)
      json(res, 500, { error: String(err) })
    }
  })

  server.listen(port)
}
