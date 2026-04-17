import * as fs from 'node:fs'
import * as path from 'node:path'
import { nanoid } from 'nanoid'

export type ToolKind = 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit'

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

export interface ReviewReply {
  id: string
  author: 'claude' | 'human'
  body: string
  createdAt: string
}

export interface ReviewComment {
  id: string
  toolCallId: string
  side: 'before' | 'after'
  startLine: number
  endLine: number
  body: string
  status: 'open' | 'resolved'
  createdAt: string
  replies: ReviewReply[]
}

export interface ReviewLog {
  toolCalls: ToolCall[]
  comments: ReviewComment[]
}

const LOG_FILE = '.review-log.json'

function emptyLog(): ReviewLog {
  return { toolCalls: [], comments: [] }
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, file)
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
      const comments = Array.isArray(data.comments) ? (data.comments as ReviewComment[]) : []
      return { toolCalls, comments }
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

  // ─── Comments ───

  getComments(opts: { toolCallId?: string; status?: ReviewComment['status'] } = {}): ReviewComment[] {
    let comments = this.log.comments
    if (opts.toolCallId) comments = comments.filter(c => c.toolCallId === opts.toolCallId)
    if (opts.status) comments = comments.filter(c => c.status === opts.status)
    return comments
  }

  getComment(id: string): ReviewComment | undefined {
    return this.log.comments.find(c => c.id === id)
  }

  addComment(input: {
    toolCallId: string
    side: 'before' | 'after'
    startLine: number
    endLine: number
    body: string
  }): ReviewComment {
    const comment: ReviewComment = {
      id: nanoid(),
      toolCallId: input.toolCallId,
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
