import * as fs from 'node:fs'
import * as path from 'node:path'
import { nanoid } from 'nanoid'
import { simpleGit } from 'simple-git'

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
}

export interface ReviewStore {
  baseCommit: string
  comments: ReviewComment[]
}

export class CommentStore {
  private storePath: string
  private store: ReviewStore
  private dir: string

  constructor(dir: string) {
    this.dir = dir
    this.storePath = path.join(dir, '.review-comments.json')
    this.store = this.load()
  }

  private load(): ReviewStore {
    if (fs.existsSync(this.storePath)) {
      try {
        const raw = fs.readFileSync(this.storePath, 'utf-8')
        const data = JSON.parse(raw) as Record<string, unknown>
        // Migrate old round-based format
        if ('rounds' in data || 'currentRound' in data) {
          return this.migrate(data)
        }
        return data as unknown as ReviewStore
      } catch {
        // corrupted file, start fresh
      }
    }
    return { baseCommit: 'HEAD', comments: [] }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private migrate(old: any): ReviewStore {
    const baseCommit: string = old.rounds?.[0]?.baseCommit ?? 'HEAD'
    const comments: ReviewComment[] = (old.comments ?? []).map((c: any) => ({
      id: c.id,
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      side: c.side,
      body: c.body,
      status: c.status === 'resolved' ? 'resolved' : 'open',
      createdAt: c.createdAt,
      replies: c.replies ?? [],
    }))
    return { baseCommit, comments }
  }

  private save(): void {
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8')
  }

  async ensureInitialized(): Promise<void> {
    if (this.store.baseCommit === 'HEAD') {
      this.store.baseCommit = await this.getCurrentCommit()
      this.save()
    }
  }

  private async getCurrentCommit(): Promise<string> {
    try {
      const git = simpleGit(this.dir)
      const log = await git.log({ maxCount: 1 })
      return log.latest?.hash ?? 'HEAD'
    } catch {
      return 'HEAD'
    }
  }

  getBaseCommit(): string {
    return this.store.baseCommit
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

  deleteComment(id: string): boolean {
    const index = this.store.comments.findIndex(c => c.id === id)
    if (index === -1) return false
    this.store.comments.splice(index, 1)
    this.save()
    return true
  }
}
