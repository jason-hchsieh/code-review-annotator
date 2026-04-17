import * as fs from 'node:fs'
import * as path from 'node:path'
import { nanoid } from 'nanoid'

export type ToolKind = 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit'
export type TargetKind = 'tool-call' | 'git-range' | 'browse'
export type CommentSide = 'before' | 'after' | 'current'

export interface ToolCall {
  id: string
  toolUseId: string
  sessionId: string
  tool: ToolKind
  file: string
  before: string
  after: string | null
  status: 'pending' | 'complete' | 'orphan'
  startedAt: string
  completedAt: string | null
}

export interface ReviewSession {
  id: string
  kind: 'git-range' | 'browse'
  label: string
  /** For git-range: the from-side ref as the user picked it (branch name / HEAD / SHA / WORKTREE / INDEX). Null for browse. */
  fromRef: string | null
  /** The to-side ref as the user picked it. For browse mode this is always 'WORKTREE'. */
  toRef: string
  /** Resolved SHA at creation time for non-special refs. Null if the ref is WORKTREE/INDEX or resolution failed. */
  fromSha: string | null
  toSha: string | null
  createdAt: string
}

export interface CommentTarget {
  kind: TargetKind
  /** For tool-call: the toolCall.id. For git-range / browse: the session.id. */
  id: string
  /** For git-range / browse: the path of the file being commented on. Empty string for tool-call (file is on the toolCall). */
  file?: string
}

export interface ReviewReply {
  id: string
  author: 'claude' | 'human'
  body: string
  createdAt: string
}

export interface ReviewComment {
  id: string
  target: CommentTarget
  /** Kept for backward compatibility with the pre-v0.14 data model and the MCP response shape. For tool-call targets this equals target.id; otherwise empty string. */
  toolCallId: string
  side: CommentSide
  startLine: number
  endLine: number
  body: string
  status: 'open' | 'resolved'
  createdAt: string
  replies: ReviewReply[]
}

export interface ReviewLog {
  toolCalls: ToolCall[]
  sessions: ReviewSession[]
  comments: ReviewComment[]
}

const LOG_FILE = '.review-log.json'

function emptyLog(): ReviewLog {
  return { toolCalls: [], sessions: [], comments: [] }
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, file)
}

function normalizeComment(raw: any): ReviewComment | null {
  if (!raw || typeof raw !== 'object') return null
  // Migrate legacy shape: { toolCallId, side: 'before'|'after', ... } without target.
  let target: CommentTarget | undefined = raw.target
  if (!target) {
    if (typeof raw.toolCallId === 'string' && raw.toolCallId) {
      target = { kind: 'tool-call', id: raw.toolCallId, file: '' }
    } else {
      return null
    }
  }
  return {
    id: String(raw.id),
    target,
    toolCallId: target.kind === 'tool-call' ? target.id : '',
    side: (raw.side as CommentSide) ?? 'after',
    startLine: Number(raw.startLine ?? 1),
    endLine: Number(raw.endLine ?? raw.startLine ?? 1),
    body: String(raw.body ?? ''),
    status: raw.status === 'resolved' ? 'resolved' : 'open',
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    replies: Array.isArray(raw.replies) ? raw.replies : [],
  }
}

export class LogStore {
  private storePath: string
  private log: ReviewLog

  constructor(dir: string) {
    this.storePath = path.join(dir, LOG_FILE)
    this.log = this.load()
  }

  private load(): ReviewLog {
    if (!fs.existsSync(this.storePath)) return emptyLog()
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown>
      const toolCalls = Array.isArray(data.toolCalls) ? (data.toolCalls as ToolCall[]) : []
      const sessions = Array.isArray(data.sessions) ? (data.sessions as ReviewSession[]) : []
      const rawComments = Array.isArray(data.comments) ? data.comments : []
      const comments = rawComments
        .map(normalizeComment)
        .filter((c): c is ReviewComment => c !== null)
      return { toolCalls, sessions, comments }
    } catch {
      return emptyLog()
    }
  }

  private save(): void {
    atomicWrite(this.storePath, JSON.stringify(this.log, null, 2))
  }

  // ─── Tool calls ───

  getToolCalls(opts: { file?: string; status?: ToolCall['status'] } = {}): ToolCall[] {
    let calls = this.log.toolCalls
    if (opts.file) calls = calls.filter(c => c.file === opts.file)
    if (opts.status) calls = calls.filter(c => c.status === opts.status)
    return calls
  }

  getToolCall(id: string): ToolCall | undefined {
    return this.log.toolCalls.find(c => c.id === id)
  }

  getToolCallByUseId(toolUseId: string): ToolCall | undefined {
    return this.log.toolCalls.find(c => c.toolUseId === toolUseId)
  }

  startToolCall(input: {
    toolUseId: string
    sessionId: string
    tool: ToolKind
    file: string
    before: string
    startedAt?: string
  }): ToolCall {
    const existing = this.getToolCallByUseId(input.toolUseId)
    if (existing) return existing
    const call: ToolCall = {
      id: nanoid(),
      toolUseId: input.toolUseId,
      sessionId: input.sessionId,
      tool: input.tool,
      file: input.file,
      before: input.before,
      after: null,
      status: 'pending',
      startedAt: input.startedAt ?? new Date().toISOString(),
      completedAt: null,
    }
    this.log.toolCalls.push(call)
    this.save()
    return call
  }

  completeToolCall(toolUseId: string, after: string, completedAt?: string): ToolCall | null {
    const call = this.getToolCallByUseId(toolUseId)
    if (!call) return null
    call.after = after
    call.status = 'complete'
    call.completedAt = completedAt ?? new Date().toISOString()
    this.save()
    return call
  }

  markOrphans(maxAgeMs: number = 5 * 60_000): number {
    const cutoff = Date.now() - maxAgeMs
    let changed = 0
    for (const call of this.log.toolCalls) {
      if (call.status === 'pending' && new Date(call.startedAt).getTime() < cutoff) {
        call.status = 'orphan'
        changed++
      }
    }
    if (changed > 0) this.save()
    return changed
  }

  // ─── Sessions ───

  getSessions(): ReviewSession[] {
    return this.log.sessions
  }

  getSession(id: string): ReviewSession | undefined {
    return this.log.sessions.find(s => s.id === id)
  }

  addSession(input: Omit<ReviewSession, 'id' | 'createdAt'>): ReviewSession {
    const session: ReviewSession = {
      id: nanoid(),
      createdAt: new Date().toISOString(),
      ...input,
    }
    this.log.sessions.push(session)
    this.save()
    return session
  }

  updateSession(id: string, patch: Partial<Pick<ReviewSession, 'label'>>): ReviewSession | null {
    const s = this.getSession(id)
    if (!s) return null
    if (patch.label !== undefined) s.label = patch.label
    this.save()
    return s
  }

  deleteSession(id: string): boolean {
    const idx = this.log.sessions.findIndex(s => s.id === id)
    if (idx === -1) return false
    this.log.sessions.splice(idx, 1)
    this.save()
    return true
  }

  // ─── Comments ───

  getComments(opts: {
    toolCallId?: string
    sessionId?: string
    targetKind?: TargetKind
    file?: string
    status?: ReviewComment['status']
  } = {}): ReviewComment[] {
    let comments = this.log.comments
    if (opts.toolCallId) {
      comments = comments.filter(c => c.target.kind === 'tool-call' && c.target.id === opts.toolCallId)
    }
    if (opts.sessionId) {
      comments = comments.filter(c => c.target.kind !== 'tool-call' && c.target.id === opts.sessionId)
    }
    if (opts.targetKind) {
      comments = comments.filter(c => c.target.kind === opts.targetKind)
    }
    if (opts.file) {
      comments = comments.filter(c => (c.target.file ?? '') === opts.file)
    }
    if (opts.status) comments = comments.filter(c => c.status === opts.status)
    return comments
  }

  getComment(id: string): ReviewComment | undefined {
    return this.log.comments.find(c => c.id === id)
  }

  addComment(input: {
    target: CommentTarget
    side: CommentSide
    startLine: number
    endLine: number
    body: string
  }): ReviewComment {
    const target: CommentTarget = {
      kind: input.target.kind,
      id: input.target.id,
      file: input.target.file ?? '',
    }
    const comment: ReviewComment = {
      id: nanoid(),
      target,
      toolCallId: target.kind === 'tool-call' ? target.id : '',
      side: input.side,
      startLine: input.startLine,
      endLine: input.endLine,
      body: input.body,
      status: 'open',
      createdAt: new Date().toISOString(),
      replies: [],
    }
    this.log.comments.push(comment)
    this.save()
    return comment
  }

  updateComment(id: string, patch: Partial<Pick<ReviewComment, 'body' | 'status'>>): ReviewComment | null {
    const c = this.getComment(id)
    if (!c) return null
    if (patch.body !== undefined) c.body = patch.body
    if (patch.status !== undefined) c.status = patch.status
    this.save()
    return c
  }

  deleteComment(id: string): boolean {
    const idx = this.log.comments.findIndex(c => c.id === id)
    if (idx === -1) return false
    this.log.comments.splice(idx, 1)
    this.save()
    return true
  }

  // ─── Replies ───

  addReply(commentId: string, input: { body: string; author: 'claude' | 'human' }): ReviewReply | null {
    const c = this.getComment(commentId)
    if (!c) return null
    const reply: ReviewReply = {
      id: nanoid(),
      author: input.author,
      body: input.body,
      createdAt: new Date().toISOString(),
    }
    c.replies.push(reply)
    this.save()
    return reply
  }

  updateReply(commentId: string, replyId: string, body: string): ReviewReply | null {
    const c = this.getComment(commentId)
    if (!c) return null
    const r = c.replies.find(x => x.id === replyId)
    if (!r) return null
    r.body = body
    this.save()
    return r
  }

  deleteReply(commentId: string, replyId: string): boolean {
    const c = this.getComment(commentId)
    if (!c) return false
    const idx = c.replies.findIndex(x => x.id === replyId)
    if (idx === -1) return false
    c.replies.splice(idx, 1)
    this.save()
    return true
  }
}
