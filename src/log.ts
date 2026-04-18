import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'

export type ToolKind = 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit'
export type CommentSide = 'before' | 'after' | 'current'
export type ViewSource = 'tool-call' | 'git-range' | 'browse'

/**
 * Computes the git blob SHA-1 for the given UTF-8 content. Matches
 * `git hash-object` so a comment's `blobSha` can be cross-referenced
 * with real git blobs when the same content exists in the repo.
 */
export function computeBlobSha(content: string): string {
  const buf = Buffer.from(content, 'utf-8')
  const header = `blob ${buf.length}\0`
  const hash = createHash('sha1')
  hash.update(header)
  hash.update(buf)
  return hash.digest('hex')
}

/** Slice 1-indexed line range, inclusive. Clamps to file bounds. Returns '' on empty content. */
export function sliceLines(content: string, startLine: number, endLine: number): string {
  if (!content) return ''
  const lines = content.split('\n')
  const s = Math.max(1, Math.min(startLine, lines.length))
  const e = Math.max(s, Math.min(endLine, lines.length))
  return lines.slice(s - 1, e).join('\n')
}

export interface ViewContext {
  source: ViewSource
  /** Only for source='tool-call'. */
  toolCallId?: string
  /** Only for source='git-range'. User-picked ref at write time. */
  fromRef?: string
  /** Only for source='git-range'. */
  toRef?: string
  /** Which side of the diff / worktree this comment was written against. */
  side?: CommentSide
}

export interface ToolCall {
  id: string
  toolUseId: string
  sessionId: string
  tool: ToolKind
  file: string
  before: string
  after: string | null
  /** git blob SHA of `before` content. */
  beforeSha: string
  /** git blob SHA of `after` content. Null while pending. */
  afterSha: string | null
  status: 'pending' | 'complete' | 'orphan'
  startedAt: string
  completedAt: string | null
}

/**
 * Legacy session shape, kept only for load-time migration of pre-Phase-3 logs.
 * The sessions table is no longer persisted or exposed via any API.
 */
interface LegacySession {
  id: string
  kind?: 'git-range' | 'browse'
  fromRef?: string | null
  toRef?: string
}

export interface ReviewReply {
  id: string
  author: 'claude' | 'human'
  body: string
  createdAt: string
}

export interface ReviewComment {
  id: string
  /** Relative path. */
  file: string
  startLine: number
  endLine: number
  /** git blob SHA of the file content this comment was written against. Empty if unknown (legacy). */
  blobSha: string
  /** Verbatim content of the referenced lines at write time. Fuzzy-relocate fallback when blobSha stops matching. */
  anchorText: string
  /** The viewing context the comment was written in. Does NOT affect anchor — it's metadata for Claude. */
  viewContext: ViewContext
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

function normalizeToolCall(raw: any): ToolCall | null {
  if (!raw || typeof raw !== 'object') return null
  const before = typeof raw.before === 'string' ? raw.before : ''
  const after = typeof raw.after === 'string' ? raw.after : null
  const beforeSha = typeof raw.beforeSha === 'string' && raw.beforeSha
    ? raw.beforeSha
    : computeBlobSha(before)
  const afterSha = typeof raw.afterSha === 'string' && raw.afterSha
    ? raw.afterSha
    : (after !== null ? computeBlobSha(after) : null)
  return {
    id: String(raw.id),
    toolUseId: String(raw.toolUseId ?? ''),
    sessionId: String(raw.sessionId ?? ''),
    tool: raw.tool as ToolKind,
    file: String(raw.file ?? ''),
    before,
    after,
    beforeSha,
    afterSha,
    status: raw.status ?? 'pending',
    startedAt: String(raw.startedAt ?? new Date().toISOString()),
    completedAt: raw.completedAt ?? null,
  }
}

interface NormalizeCtx {
  toolCalls: ToolCall[]
  /** Legacy session data read from the file once, only for backfilling viewContext on pre-Phase-3 comments. */
  legacySessions: LegacySession[]
}

function normalizeComment(raw: any, ctx: NormalizeCtx): ReviewComment | null {
  if (!raw || typeof raw !== 'object') return null

  const startLine = Number(raw.startLine ?? 1)
  const endLine = Number(raw.endLine ?? raw.startLine ?? 1)
  const side = (raw.side as CommentSide) ?? 'after'

  let file = typeof raw.file === 'string' && raw.file ? raw.file : ''
  let blobSha = typeof raw.blobSha === 'string' ? raw.blobSha : ''
  let anchorText = typeof raw.anchorText === 'string' ? raw.anchorText : ''
  let viewContext: ViewContext | undefined = raw.viewContext && typeof raw.viewContext === 'object'
    ? raw.viewContext as ViewContext
    : undefined

  // Backfill viewContext + file/blobSha/anchorText from pre-Phase-4 legacy shape
  // ({ target: { kind, id, file }, side, toolCallId }) when present on disk.
  const legacyTarget = raw.target as { kind?: string; id?: string; file?: string } | undefined
  const legacyKind: string | undefined = legacyTarget?.kind
    ?? (typeof raw.toolCallId === 'string' && raw.toolCallId ? 'tool-call' : undefined)
  const legacyId: string = legacyTarget?.id ?? (typeof raw.toolCallId === 'string' ? raw.toolCallId : '')

  if (legacyKind === 'tool-call') {
    const call = ctx.toolCalls.find(c => c.id === legacyId)
    if (call) {
      if (!file) file = call.file
      if (!blobSha) blobSha = side === 'before' ? call.beforeSha : (call.afterSha ?? '')
      if (!anchorText) {
        const content = side === 'before' ? call.before : (call.after ?? '')
        anchorText = sliceLines(content, startLine, endLine)
      }
    }
    if (!viewContext) viewContext = { source: 'tool-call', toolCallId: legacyId, side }
  } else if (legacyKind === 'git-range') {
    if (!file) file = legacyTarget?.file ?? ''
    if (!viewContext) {
      const session = ctx.legacySessions.find(s => s.id === legacyId)
      viewContext = {
        source: 'git-range',
        fromRef: session?.fromRef ?? undefined,
        toRef: session?.toRef ?? undefined,
        side,
      }
    }
  } else if (legacyKind === 'browse') {
    if (!file) file = legacyTarget?.file ?? ''
    if (!viewContext) viewContext = { source: 'browse', side: 'current' }
  }

  // Post-Phase-4 comments must have viewContext — anything without it is unrecoverable.
  if (!viewContext) return null

  return {
    id: String(raw.id),
    file,
    startLine,
    endLine,
    blobSha,
    anchorText,
    viewContext,
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
      const rawToolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : []
      const toolCalls = rawToolCalls
        .map(normalizeToolCall)
        .filter((c): c is ToolCall => c !== null)
      const legacySessions = Array.isArray(data.sessions) ? (data.sessions as LegacySession[]) : []
      const rawComments = Array.isArray(data.comments) ? data.comments : []
      const ctx: NormalizeCtx = { toolCalls, legacySessions }
      const comments = rawComments
        .map(c => normalizeComment(c, ctx))
        .filter((c): c is ReviewComment => c !== null)
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
      beforeSha: computeBlobSha(input.before),
      afterSha: null,
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
    call.afterSha = computeBlobSha(after)
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

  getComments(opts: {
    toolCallId?: string
    file?: string
    status?: ReviewComment['status']
    /** Filter by viewContext.source. */
    viewSource?: ViewSource
    /** Match viewContext.fromRef / toRef for source='git-range'. */
    fromRef?: string
    toRef?: string
  } = {}): ReviewComment[] {
    let comments = this.log.comments
    if (opts.toolCallId) {
      comments = comments.filter(c => c.viewContext.toolCallId === opts.toolCallId)
    }
    if (opts.viewSource) {
      comments = comments.filter(c => c.viewContext.source === opts.viewSource)
    }
    if (opts.fromRef !== undefined) {
      comments = comments.filter(c => (c.viewContext.fromRef ?? '') === opts.fromRef)
    }
    if (opts.toRef !== undefined) {
      comments = comments.filter(c => (c.viewContext.toRef ?? '') === opts.toRef)
    }
    if (opts.file) {
      comments = comments.filter(c => c.file === opts.file)
    }
    if (opts.status) comments = comments.filter(c => c.status === opts.status)
    return comments
  }

  getComment(id: string): ReviewComment | undefined {
    return this.log.comments.find(c => c.id === id)
  }

  addComment(input: {
    file: string
    startLine: number
    endLine: number
    blobSha: string
    anchorText: string
    viewContext: ViewContext
    body: string
  }): ReviewComment {
    const comment: ReviewComment = {
      id: nanoid(),
      file: input.file,
      startLine: input.startLine,
      endLine: input.endLine,
      blobSha: input.blobSha,
      anchorText: input.anchorText,
      viewContext: input.viewContext,
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
