import * as fs from 'node:fs'
import * as path from 'node:path'
import { nanoid } from 'nanoid'

export interface CommentReply {
  id: string
  author: 'claude' | 'human'
  body: string
  createdAt: string
}

export interface ReviewComment {
  id: string
  file: string
  startLine: number
  endLine: number
  side: 'old' | 'new'
  body: string
  status: 'open' | 'resolved'
  createdAt: string
  replies: CommentReply[]
  commitSha: string
  anchorSnippet: string[]
}

export interface ReviewStore {
  baseBranch: string
  comments: ReviewComment[]
}

export class CommentStore {
  private storePath: string
  private store: ReviewStore

  constructor(dir: string, baseBranch: string) {
    this.storePath = path.join(dir, '.review-comments.json')
    this.store = this.load(baseBranch)
    this.save()
  }

  static readStoredBaseBranch(dir: string): string | null {
    const storePath = path.join(dir, '.review-comments.json')
    if (!fs.existsSync(storePath)) return null
    try {
      const data = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as Record<string, unknown>
      return typeof data.baseBranch === 'string' ? data.baseBranch : null
    } catch {
      return null
    }
  }

  private load(baseBranch: string): ReviewStore {
    if (fs.existsSync(this.storePath)) {
      try {
        const raw = fs.readFileSync(this.storePath, 'utf-8')
        const data = JSON.parse(raw) as Record<string, unknown>
        const comments = Array.isArray(data.comments) ? (data.comments as ReviewComment[]) : []
        return { baseBranch, comments }
      } catch {
        // corrupted file — start fresh
      }
    }
    return { baseBranch, comments: [] }
  }

  private save(): void {
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8')
  }

  getBaseBranch(): string {
    return this.store.baseBranch
  }

  getComments(opts: { file?: string; status?: 'open' | 'resolved' } = {}): ReviewComment[] {
    let comments = this.store.comments
    if (opts.file) comments = comments.filter(c => c.file === opts.file)
    if (opts.status) comments = comments.filter(c => c.status === opts.status)
    return comments
  }

  addComment(data: {
    file: string
    startLine: number
    endLine: number
    side: 'old' | 'new'
    body: string
    commitSha: string
    anchorSnippet: string[]
  }): ReviewComment {
    const comment: ReviewComment = {
      id: nanoid(),
      ...data,
      status: 'open',
      createdAt: new Date().toISOString(),
      replies: [],
    }
    this.store.comments.push(comment)
    this.save()
    return comment
  }

  updateComment(id: string, data: { body?: string; status?: 'open' | 'resolved' }): ReviewComment | null {
    const comment = this.store.comments.find(c => c.id === id)
    if (!comment) return null
    if (data.body !== undefined) comment.body = data.body
    if (data.status !== undefined) comment.status = data.status
    this.save()
    return comment
  }

  addReply(commentId: string, author: 'claude' | 'human', body: string): CommentReply | null {
    const comment = this.store.comments.find(c => c.id === commentId)
    if (!comment) return null
    if (!comment.replies) comment.replies = []
    const reply: CommentReply = { id: nanoid(), author, body, createdAt: new Date().toISOString() }
    comment.replies.push(reply)
    this.save()
    return reply
  }

  updateReply(commentId: string, replyId: string, body: string): CommentReply | null {
    const comment = this.store.comments.find(c => c.id === commentId)
    if (!comment || !comment.replies) return null
    const reply = comment.replies.find(r => r.id === replyId)
    if (!reply) return null
    reply.body = body
    this.save()
    return reply
  }

  deleteReply(commentId: string, replyId: string): boolean {
    const comment = this.store.comments.find(c => c.id === commentId)
    if (!comment || !comment.replies) return false
    const idx = comment.replies.findIndex(r => r.id === replyId)
    if (idx === -1) return false
    comment.replies.splice(idx, 1)
    this.save()
    return true
  }

  deleteComment(id: string): boolean {
    const index = this.store.comments.findIndex(c => c.id === id)
    if (index === -1) return false
    this.store.comments.splice(index, 1)
    this.save()
    return true
  }
}
