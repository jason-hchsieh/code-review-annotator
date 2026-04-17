import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CommentSide, CommentTarget, LogStore, ReviewComment, ReviewSession, TargetKind, ToolCall, ToolKind } from './log.ts'
import { listProjects, setHttpPort, clearHttpPort, RegistryProject } from './registry.ts'
import { startProjectWatcher, WatcherEvent } from './watcher.ts'
import { isAncestor, isGitRepo, listChangedFiles, listRefs, listWorktreeFiles, mergeBase, readBlob, resolveRef } from './git.ts'

const TOOL_KINDS: ReadonlyArray<ToolKind> = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const TARGET_KINDS: ReadonlyArray<TargetKind> = ['tool-call', 'git-range', 'browse']

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

function fileForComment(comment: ReviewComment, store: LogStore): string {
  if (comment.target.kind === 'tool-call') {
    const call = store.getToolCall(comment.target.id)
    return call?.file ?? '(unknown)'
  }
  return comment.target.file ?? '(unknown)'
}

function toolRefForComment(comment: ReviewComment, store: LogStore): string {
  if (comment.target.kind === 'tool-call') {
    const call = store.getToolCall(comment.target.id)
    return call?.tool ?? 'tool'
  }
  const session = store.getSession(comment.target.id)
  if (!session) return comment.target.kind
  return session.kind === 'browse' ? 'Browse' : `${session.fromRef}→${session.toRef}`
}

function exportPrompt(
  store: LogStore,
  comments: ReviewComment[],
  mode: 'fix' | 'report' | 'both',
): string {
  if (comments.length === 0) return '// No open comments found.'

  const byFile = new Map<string, ReviewComment[]>()
  for (const cm of comments) {
    const file = fileForComment(cm, store)
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file)!.push(cm)
  }

  const lines: string[] = []

  if (mode === 'fix' || mode === 'both') {
    lines.push('Please address the following review comments:\n')
    for (const [file, entries] of byFile.entries()) {
      lines.push(`### ${file}`)
      for (const comment of entries) {
        const lineRef = comment.startLine === comment.endLine ? `L${comment.startLine}` : `L${comment.startLine}–L${comment.endLine}`
        const ctx = toolRefForComment(comment, store)
        lines.push(`- [${ctx}, ${comment.side}, ${lineRef}] ${comment.body}`)
      }
      lines.push('')
    }
  }

  if (mode === 'report' || mode === 'both') {
    if (mode === 'both') lines.push('---\n')
    lines.push('## Review Summary\n')
    for (const [file, entries] of byFile.entries()) {
      lines.push(`### ${file}`)
      for (const comment of entries) {
        const lineRef = comment.startLine === comment.endLine ? `L${comment.startLine}` : `L${comment.startLine}–L${comment.endLine}`
        const ctx = toolRefForComment(comment, store)
        lines.push(`- **[${ctx} ${lineRef} ${comment.side}]**: ${comment.body}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

interface SseSubscriber {
  res: http.ServerResponse
  heartbeat: NodeJS.Timeout
}

interface ProjectWatcher {
  subscribers: Set<SseSubscriber>
  stop: () => void
}

const watchers = new Map<string, ProjectWatcher>()

function sseWrite(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(project: RegistryProject, event: WatcherEvent) {
  const entry = watchers.get(project.dir)
  if (!entry) return
  for (const sub of entry.subscribers) {
    try {
      sseWrite(sub.res, event.type, { dir: project.dir, ts: Date.now() })
    } catch {
      // connection closed; cleanup happens on 'close' event
    }
  }
}

function handleSse(req: http.IncomingMessage, res: http.ServerResponse, project: RegistryProject) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  })
  res.write('\n')
  sseWrite(res, 'hello', { dir: project.dir })

  let entry = watchers.get(project.dir)
  if (!entry) {
    const created: ProjectWatcher = {
      subscribers: new Set(),
      stop: () => {},
    }
    created.stop = startProjectWatcher(project.dir, (event) => {
      broadcast(project, event)
    })
    watchers.set(project.dir, created)
    entry = created
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      // ignore; close handler will clean up
    }
  }, 20000)

  const subscriber: SseSubscriber = { res, heartbeat }
  entry.subscribers.add(subscriber)

  const cleanup = () => {
    clearInterval(heartbeat)
    const current = watchers.get(project.dir)
    if (!current) return
    current.subscribers.delete(subscriber)
    if (current.subscribers.size === 0) {
      current.stop()
      watchers.delete(project.dir)
    }
  }

  req.on('close', cleanup)
  req.on('error', cleanup)
}

function parseTarget(raw: unknown): CommentTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.kind as TargetKind | undefined
  const id = r.id as string | undefined
  if (!kind || !TARGET_KINDS.includes(kind)) return null
  if (!id) return null
  return { kind, id, file: typeof r.file === 'string' ? r.file : '' }
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
          httpPort: p.httpPort,
          updatedAt: p.updatedAt,
        }))
        return json(res, 200, projects)
      }

      const project = resolveProject(query)
      if (!project) {
        return json(res, 400, { error: 'no project registered or specified' })
      }

      if (method === 'GET' && pathname === '/api/events') {
        handleSse(req, res, project)
        return
      }

      const { dir } = project
      const store = new LogStore(dir)

      if (method === 'GET' && pathname === '/api/meta') {
        return json(res, 200, {
          dir,
          displayPath: homeRelative(dir),
          name: projectName(dir),
          isGitRepo: isGitRepo(dir),
        })
      }

      // ─── Git refs / ancestry ───

      if (method === 'GET' && pathname === '/api/git/refs') {
        return json(res, 200, { isGitRepo: isGitRepo(dir), refs: listRefs(dir) })
      }

      if (method === 'POST' && pathname === '/api/git/check-ancestor') {
        const body = JSON.parse(await readBody(req)) as { fromRef?: string; toRef?: string }
        if (!body.fromRef || !body.toRef) return json(res, 400, { error: 'fromRef and toRef required' })
        try {
          const fromR = resolveRef(dir, body.fromRef)
          const toR = resolveRef(dir, body.toRef)
          if (!fromR.sha || !toR.sha) {
            return json(res, 200, { ancestor: null, note: 'one side is WORKTREE/INDEX' })
          }
          const ancestor = isAncestor(dir, fromR.sha, toR.sha)
          const base = mergeBase(dir, fromR.sha, toR.sha)
          return json(res, 200, { ancestor, mergeBase: base })
        } catch (err: any) {
          return json(res, 400, { error: err.message ?? String(err) })
        }
      }

      // ─── Sessions ───

      if (method === 'GET' && pathname === '/api/sessions') {
        return json(res, 200, store.getSessions())
      }

      if (method === 'POST' && pathname === '/api/sessions') {
        const body = JSON.parse(await readBody(req)) as {
          kind?: 'git-range' | 'browse'
          label?: string
          fromRef?: string | null
          toRef?: string
        }
        if (!body.kind || (body.kind !== 'git-range' && body.kind !== 'browse')) {
          return json(res, 400, { error: 'kind must be git-range or browse' })
        }
        if (body.kind === 'git-range') {
          if (!body.fromRef || !body.toRef) return json(res, 400, { error: 'fromRef and toRef required' })
          try {
            const fromR = resolveRef(dir, body.fromRef)
            const toR = resolveRef(dir, body.toRef)
            const session = store.addSession({
              kind: 'git-range',
              label: body.label?.trim() || `${fromR.ref} → ${toR.ref}`,
              fromRef: fromR.ref,
              toRef: toR.ref,
              fromSha: fromR.sha,
              toSha: toR.sha,
            })
            return json(res, 201, session)
          } catch (err: any) {
            return json(res, 400, { error: err.message ?? String(err) })
          }
        }
        // browse
        const session = store.addSession({
          kind: 'browse',
          label: body.label?.trim() || 'Worktree browse',
          fromRef: null,
          toRef: 'WORKTREE',
          fromSha: null,
          toSha: null,
        })
        return json(res, 201, session)
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (method === 'GET' && sessionMatch) {
        const session = store.getSession(sessionMatch[1])
        if (!session) return json(res, 404, { error: 'not found' })
        return json(res, 200, session)
      }
      if (method === 'PATCH' && sessionMatch) {
        const body = JSON.parse(await readBody(req)) as { label?: string }
        const updated = store.updateSession(sessionMatch[1], { label: body.label })
        if (!updated) return json(res, 404, { error: 'not found' })
        return json(res, 200, updated)
      }
      if (method === 'DELETE' && sessionMatch) {
        const ok = store.deleteSession(sessionMatch[1])
        if (!ok) return json(res, 404, { error: 'not found' })
        return json(res, 200, { ok: true })
      }

      const sessionFilesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/files$/)
      if (method === 'GET' && sessionFilesMatch) {
        const session = store.getSession(sessionFilesMatch[1])
        if (!session) return json(res, 404, { error: 'not found' })
        if (session.kind === 'browse') {
          const files = listWorktreeFiles(dir).map(f => ({ file: f, status: 'M' as const }))
          return json(res, 200, files)
        }
        const from = session.fromSha ?? session.fromRef ?? ''
        const to = session.toSha ?? session.toRef ?? ''
        try {
          const files = listChangedFiles(dir, from, to)
          return json(res, 200, files)
        } catch (err: any) {
          return json(res, 400, { error: err.message ?? String(err) })
        }
      }

      const sessionFileMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/file$/)
      if (method === 'GET' && sessionFileMatch) {
        const session = store.getSession(sessionFileMatch[1])
        if (!session) return json(res, 404, { error: 'not found' })
        const file = query.get('path')
        if (!file) return json(res, 400, { error: 'path query param required' })
        if (session.kind === 'browse') {
          const content = readBlob(dir, 'WORKTREE', file)
          return json(res, 200, { file, before: '', after: content, isBrowse: true })
        }
        const from = session.fromSha ?? session.fromRef ?? ''
        const to = session.toSha ?? session.toRef ?? ''
        const before = readBlob(dir, from, file)
        const after = readBlob(dir, to, file)
        return json(res, 200, { file, before, after, isBrowse: false })
      }

      // ─── Tool calls ───

      if (method === 'GET' && pathname === '/api/tool-calls') {
        store.markOrphans()
        const file = query.get('file') ?? undefined
        const status = (query.get('status') as ToolCall['status'] | null) ?? undefined
        const calls = store.getToolCalls({ file, status })
        return json(res, 200, calls)
      }

      const toolCallMatch = pathname.match(/^\/api\/tool-calls\/([^/]+)$/)
      if (method === 'GET' && toolCallMatch && toolCallMatch[1] !== 'start' && toolCallMatch[1] !== 'complete') {
        const call = store.getToolCall(toolCallMatch[1])
        if (!call) return json(res, 404, { error: 'not found' })
        return json(res, 200, call)
      }

      if (method === 'POST' && pathname === '/api/tool-calls/start') {
        const body = JSON.parse(await readBody(req)) as {
          toolUseId?: string
          sessionId?: string
          tool?: string
          file?: string
          before?: string
          startedAt?: string
        }
        if (!body.toolUseId || !body.sessionId || !body.tool || !body.file) {
          return json(res, 400, { error: 'toolUseId, sessionId, tool, file required' })
        }
        if (!TOOL_KINDS.includes(body.tool as ToolKind)) {
          return json(res, 400, { error: `tool must be one of ${TOOL_KINDS.join('|')}` })
        }
        const call = store.startToolCall({
          toolUseId: body.toolUseId,
          sessionId: body.sessionId,
          tool: body.tool as ToolKind,
          file: body.file,
          before: body.before ?? '',
          startedAt: body.startedAt,
        })
        return json(res, 201, call)
      }

      if (method === 'POST' && pathname === '/api/tool-calls/complete') {
        const body = JSON.parse(await readBody(req)) as {
          toolUseId?: string
          after?: string
          completedAt?: string
        }
        if (!body.toolUseId) return json(res, 400, { error: 'toolUseId required' })
        const call = store.completeToolCall(body.toolUseId, body.after ?? '', body.completedAt)
        if (!call) return json(res, 404, { error: 'toolUseId not found (maybe Pre hook missed)' })
        return json(res, 200, call)
      }

      // ─── Comments ───

      if (method === 'GET' && pathname === '/api/comments') {
        const toolCallId = query.get('toolCallId') ?? undefined
        const sessionId = query.get('sessionId') ?? undefined
        const targetKind = (query.get('targetKind') as TargetKind | null) ?? undefined
        const file = query.get('file') ?? undefined
        const status = (query.get('status') as ReviewComment['status'] | null) ?? undefined
        return json(res, 200, store.getComments({ toolCallId, sessionId, targetKind, file, status }))
      }

      if (method === 'POST' && pathname === '/api/comments') {
        const body = JSON.parse(await readBody(req)) as {
          target?: unknown
          toolCallId?: string
          side?: CommentSide
          startLine?: number
          endLine?: number
          body?: string
        }
        let target = parseTarget(body.target)
        if (!target && body.toolCallId) {
          target = { kind: 'tool-call', id: body.toolCallId, file: '' }
        }
        if (!target) return json(res, 400, { error: 'target {kind,id} or legacy toolCallId required' })
        if (!body.side || !body.startLine || !body.body) {
          return json(res, 400, { error: 'side, startLine, body required' })
        }
        // Validate target exists
        if (target.kind === 'tool-call') {
          if (!store.getToolCall(target.id)) return json(res, 404, { error: 'toolCallId not found' })
        } else {
          const s = store.getSession(target.id)
          if (!s) return json(res, 404, { error: 'sessionId not found' })
          if (s.kind === 'browse' && target.kind !== 'browse') return json(res, 400, { error: 'target.kind must match session kind' })
          if (s.kind === 'git-range' && target.kind !== 'git-range') return json(res, 400, { error: 'target.kind must match session kind' })
        }
        const sLine = Number(body.startLine)
        const eLine = Number(body.endLine ?? sLine)
        const comment = store.addComment({
          target,
          side: body.side,
          startLine: sLine,
          endLine: eLine,
          body: body.body,
        })
        return json(res, 201, comment)
      }

      const commentMatch = pathname.match(/^\/api\/comments\/([^/]+)$/)
      if (method === 'PATCH' && commentMatch) {
        const id = commentMatch[1]
        const body = JSON.parse(await readBody(req)) as { body?: string; status?: ReviewComment['status'] }
        const updated = store.updateComment(id, { body: body.body, status: body.status })
        if (!updated) return json(res, 404, { error: 'not found' })
        return json(res, 200, updated)
      }

      if (method === 'DELETE' && commentMatch) {
        const id = commentMatch[1]
        const ok = store.deleteComment(id)
        if (!ok) return json(res, 404, { error: 'not found' })
        return json(res, 200, { ok: true })
      }

      const replyMatch = pathname.match(/^\/api\/comments\/([^/]+)\/replies$/)
      if (method === 'POST' && replyMatch) {
        const id = replyMatch[1]
        const body = JSON.parse(await readBody(req)) as { body?: string; author?: 'claude' | 'human' }
        if (!body.body) return json(res, 400, { error: 'body required' })
        const reply = store.addReply(id, { body: body.body, author: body.author ?? 'human' })
        if (!reply) return json(res, 404, { error: 'not found' })
        return json(res, 201, reply)
      }

      const replyItemMatch = pathname.match(/^\/api\/comments\/([^/]+)\/replies\/([^/]+)$/)
      if (method === 'PATCH' && replyItemMatch) {
        const [, commentId, replyId] = replyItemMatch
        const body = JSON.parse(await readBody(req)) as { body?: string }
        if (!body.body) return json(res, 400, { error: 'body required' })
        const reply = store.updateReply(commentId, replyId, body.body)
        if (!reply) return json(res, 404, { error: 'not found' })
        return json(res, 200, reply)
      }

      if (method === 'DELETE' && replyItemMatch) {
        const [, commentId, replyId] = replyItemMatch
        const ok = store.deleteReply(commentId, replyId)
        if (!ok) return json(res, 404, { error: 'not found' })
        return json(res, 200, { ok: true })
      }

      if (method === 'GET' && pathname === '/api/export') {
        const mode = (query.get('mode') as 'fix' | 'report' | 'both' | null) ?? 'both'
        const toolCallId = query.get('toolCallId') ?? undefined
        const sessionId = query.get('sessionId') ?? undefined
        const targetKind = (query.get('targetKind') as TargetKind | null) ?? undefined
        const comments = store.getComments({ status: 'open', toolCallId, sessionId, targetKind })
        const prompt = exportPrompt(store, comments, mode)
        return json(res, 200, { prompt })
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      console.error(err)
      json(res, 500, { error: String(err) })
    }
  })

  server.listen(port)

  // Advertise port to the registry for hook scripts to discover.
  const advertised: string[] = []
  for (const p of listProjects()) {
    setHttpPort(p.dir, port)
    advertised.push(p.dir)
  }
  const release = () => {
    for (const dir of advertised) clearHttpPort(dir)
    process.exit(0)
  }
  process.on('SIGINT', release)
  process.on('SIGTERM', release)
  process.on('beforeExit', () => {
    for (const dir of advertised) clearHttpPort(dir)
  })
}
