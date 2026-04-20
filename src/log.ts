import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'

export type ToolKind = 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit'
export type CommentSide = 'before' | 'after' | 'current'
export type ViewSource = 'tool-call' | 'git-range' | 'browse'
export type CommentScope = 'line' | 'file' | 'multi-file' | 'view'

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

export interface ReviewReply {
  id: string
  author: 'claude' | 'human'
  body: string
  createdAt: string
}

/** One pinned location on a file. Line range + anchorText only for scope='line'. */
export interface Anchor {
  file: string
  blobSha: string
  startLine?: number
  endLine?: number
  /** Verbatim content at the line range (only for scope='line'). */
  anchorText?: string
}

export interface ReviewComment {
  id: string
  /**
   * - 'line': one anchor with startLine/endLine/anchorText
   * - 'file': one anchor, whole file (no line range)
   * - 'multi-file': N anchors, one per file
   * - 'view': empty anchors; target is the viewContext itself
   */
  scope: CommentScope
  anchors: Anchor[]
  /** The viewing context the comment was written in. */
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

/**
 * Accepts both:
 *   - new shape: { scope, anchors, viewContext, ... }
 *   - pre-0.19 shape: { file, startLine, endLine, blobSha, anchorText, viewContext, ... }
 * and coerces to new shape. Pre-0.15 shapes (target/sessions) are no longer supported.
 */
function normalizeComment(raw: any): ReviewComment | null {
  if (!raw || typeof raw !== 'object') return null

  const viewContext = raw.viewContext && typeof raw.viewContext === 'object'
    ? raw.viewContext as ViewContext
    : null
  if (!viewContext) return null

  let scope: CommentScope = raw.scope as CommentScope
  let anchors: Anchor[] = Array.isArray(raw.anchors) ? raw.anchors : []

  // Pre-0.19: flat top-level file/startLine/endLine/blobSha/anchorText.
  if (!scope && typeof raw.file === 'string' && raw.file) {
    scope = 'line'
    anchors = [{
      file: raw.file,
      blobSha: typeof raw.blobSha === 'string' ? raw.blobSha : '',
      startLine: Number(raw.startLine ?? 1),
      endLine: Number(raw.endLine ?? raw.startLine ?? 1),
      anchorText: typeof raw.anchorText === 'string' ? raw.anchorText : '',
    }]
  }

  if (!scope || !['line', 'file', 'multi-file', 'view'].includes(scope)) return null
  if (scope === 'view') anchors = []
  if ((scope === 'line' || scope === 'file') && anchors.length !== 1) {
    if (anchors.length === 0) return null
    anchors = [anchors[0]]
  }
  if (scope === 'multi-file' && anchors.length < 1) return null

  // Normalize anchor fields per scope.
  anchors = anchors.map(a => {
    const base: Anchor = {
      file: String(a.file ?? ''),
      blobSha: typeof a.blobSha === 'string' ? a.blobSha : '',
    }
    if (scope === 'line') {
      base.startLine = Number(a.startLine ?? 1)
      base.endLine = Number(a.endLine ?? a.startLine ?? 1)
      base.anchorText = typeof a.anchorText === 'string' ? a.anchorText : ''
    }
    return base
  })

  return {
    id: String(raw.id),
    scope,
    anchors,
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
  private lastSignature: string

  constructor(dir: string) {
    this.storePath = path.join(dir, LOG_FILE)
    this.log = this.load()
    this.lastSignature = this.computeSignature()
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
      const rawComments = Array.isArray(data.comments) ? data.comments : []
      const comments = rawComments
        .map(normalizeComment)
        .filter((c): c is ReviewComment => c !== null)
      return { toolCalls, comments }
    } catch {
      return emptyLog()
    }
  }

  private computeSignature(): string {
    try {
      const st = fs.statSync(this.storePath)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return 'missing'
    }
  }

  /**
   * Reload from disk if the file changed externally since our last read.
   * Called at the top of every public method so a long-lived instance stays
   * in sync with writes from other processes (e.g. the HTTP server writing
   * UI-created comments while the MCP server holds a long-lived store).
   */
  private syncFromDisk(): void {
    const sig = this.computeSignature()
    if (sig === this.lastSignature) return
    this.log = this.load()
    this.lastSignature = sig
  }

  private save(): void {
    atomicWrite(this.storePath, JSON.stringify(this.log, null, 2))
    this.lastSignature = this.computeSignature()
  }

  // ─── Tool calls ───

  getToolCalls(opts: { file?: string; status?: ToolCall['status'] } = {}): ToolCall[] {
    this.syncFromDisk()
    let calls = this.log.toolCalls
    if (opts.file) calls = calls.filter(c => c.file === opts.file)
    if (opts.status) calls = calls.filter(c => c.status === opts.status)
    return calls
  }

  getToolCall(id: string): ToolCall | undefined {
    this.syncFromDisk()
    return this.log.toolCalls.find(c => c.id === id)
  }

  getToolCallByUseId(toolUseId: string): ToolCall | undefined {
    this.syncFromDisk()
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
    this.syncFromDisk()
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
    this.syncFromDisk()
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
    this.syncFromDisk()
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
    scope?: CommentScope
    /** Filter by viewContext.source. */
    viewSource?: ViewSource
    /** Match viewContext.fromRef / toRef for source='git-range'. */
    fromRef?: string
    toRef?: string
  } = {}): ReviewComment[] {
    this.syncFromDisk()
    let comments = this.log.comments
    if (opts.toolCallId) {
      comments = comments.filter(c => c.viewContext.toolCallId === opts.toolCallId)
    }
    if (opts.scope) {
      comments = comments.filter(c => c.scope === opts.scope)
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
      comments = comments.filter(c => c.anchors.some(a => a.file === opts.file))
    }
    if (opts.status) comments = comments.filter(c => c.status === opts.status)
    return comments
  }

  getComment(id: string): ReviewComment | undefined {
    this.syncFromDisk()
    return this.log.comments.find(c => c.id === id)
  }

  addComment(input: {
    scope: CommentScope
    anchors: Anchor[]
    viewContext: ViewContext
    body: string
  }): ReviewComment {
    this.syncFromDisk()
    const comment: ReviewComment = {
      id: nanoid(),
      scope: input.scope,
      anchors: input.anchors,
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
    this.syncFromDisk()
    const c = this.getComment(id)
    if (!c) return null
    if (patch.body !== undefined) c.body = patch.body
    if (patch.status !== undefined) c.status = patch.status
    this.save()
    return c
  }

  deleteComment(id: string): boolean {
    this.syncFromDisk()
    const idx = this.log.comments.findIndex(c => c.id === id)
    if (idx === -1) return false
    this.log.comments.splice(idx, 1)
    this.save()
    return true
  }

  // ─── Replies ───

  addReply(commentId: string, input: { body: string; author: 'claude' | 'human' }): ReviewReply | null {
    this.syncFromDisk()
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
    this.syncFromDisk()
    const c = this.getComment(commentId)
    if (!c) return null
    const r = c.replies.find(x => x.id === replyId)
    if (!r) return null
    r.body = body
    this.save()
    return r
  }

  deleteReply(commentId: string, replyId: string): boolean {
    this.syncFromDisk()
    const c = this.getComment(commentId)
    if (!c) return false
    const idx = c.replies.findIndex(x => x.id === replyId)
    if (idx === -1) return false
    c.replies.splice(idx, 1)
    this.save()
    return true
  }
}
