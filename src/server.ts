import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import { CommentStore } from './comments.ts'
import { getChangedFiles, getFileDiff, parseDiff } from './gitDiff.ts'
import { getFileTree } from './fileTree.ts'

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

function generateExportPrompt(
  store: CommentStore,
  fileFilter: string | null,
  mode: 'fix' | 'report' | 'both',
): string {
  const comments = store.getComments({ status: 'open', ...(fileFilter ? { file: fileFilter } : {}) })

  if (comments.length === 0) return '// No open comments found.'

  const byFile: Record<string, typeof comments> = {}
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

export function startHttpServer(dir: string, port: number) {
  const store = new CommentStore(dir)
  store.ensureInitialRound()

  const publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public')

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url ?? '/', true)
    const pathname = parsed.pathname ?? '/'
    const method = req.method ?? 'GET'

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' })
      res.end()
      return
    }

    // Favicon
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    // Static files
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
      // GET /api/files
      if (method === 'GET' && pathname === '/api/files') {
        const tree = getFileTree(dir)
        return json(res, 200, tree)
      }

      // GET /api/diff?file=...
      if (method === 'GET' && pathname === '/api/diff') {
        const file = parsed.query.file as string
        if (!file) return json(res, 400, { error: 'file param required' })

        await store.ensureInitialRound()
        const rounds = store.getRounds()
        const currentRoundData = rounds.find(r => r.id === store.getCurrentRound())
        const baseCommit = currentRoundData?.baseCommit ?? 'HEAD'

        const rawDiff = await getFileDiff(dir, file, baseCommit)
        const parsed2 = parseDiff(rawDiff, file)
        return json(res, 200, parsed2)
      }

      // GET /api/diff/summary
      if (method === 'GET' && pathname === '/api/diff/summary') {
        await store.ensureInitialRound()
        const rounds = store.getRounds()
        const currentRoundData = rounds.find(r => r.id === store.getCurrentRound())
        const baseCommit = currentRoundData?.baseCommit ?? 'HEAD'

        const files = await getChangedFiles(dir, baseCommit)
        return json(res, 200, files)
      }

      // GET /api/comments
      if (method === 'GET' && pathname === '/api/comments') {
        const fileFilter = parsed.query.file as string | undefined
        const statusFilter = parsed.query.status as 'open' | 'resolved' | 'stale' | undefined
        const roundParam = parsed.query.round as string | undefined

        let roundFilter: number | 'all' | undefined
        if (roundParam === 'all') roundFilter = 'all'
        else if (roundParam) roundFilter = parseInt(roundParam, 10)

        const comments = store.getComments({ file: fileFilter, status: statusFilter, round: roundFilter })
        return json(res, 200, comments)
      }

      // POST /api/comments
      if (method === 'POST' && pathname === '/api/comments') {
        const body = JSON.parse(await readBody(req))
        const { file, startLine, endLine, side, body: commentBody } = body
        if (!file || !startLine || !side || !commentBody) {
          return json(res, 400, { error: 'file, startLine, side, body required' })
        }
        const comment = store.addComment({
          file,
          startLine: Number(startLine),
          endLine: Number(endLine ?? startLine),
          side,
          body: commentBody,
        })
        return json(res, 201, comment)
      }

      // PATCH /api/comments/:id
      const patchMatch = pathname.match(/^\/api\/comments\/([^/]+)$/)
      if (method === 'PATCH' && patchMatch) {
        const id = patchMatch[1]
        const body = JSON.parse(await readBody(req))
        const updated = store.updateComment(id, { body: body.body, status: body.status })
        if (!updated) return json(res, 404, { error: 'not found' })
        return json(res, 200, updated)
      }

      // DELETE /api/comments/:id
      if (method === 'DELETE' && patchMatch) {
        const id = patchMatch[1]
        const deleted = store.deleteComment(id)
        if (!deleted) return json(res, 404, { error: 'not found' })
        return json(res, 200, { ok: true })
      }

      // GET /api/rounds
      if (method === 'GET' && pathname === '/api/rounds') {
        return json(res, 200, {
          currentRound: store.getCurrentRound(),
          rounds: store.getRounds(),
        })
      }

      // POST /api/rounds
      if (method === 'POST' && pathname === '/api/rounds') {
        const result = await store.startNewRound()
        return json(res, 201, result)
      }

      // GET /api/export
      if (method === 'GET' && pathname === '/api/export') {
        const fileFilter = parsed.query.file as string | null ?? null
        const mode = (parsed.query.mode as 'fix' | 'report' | 'both') ?? 'both'
        const prompt = generateExportPrompt(store, fileFilter, mode)
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
