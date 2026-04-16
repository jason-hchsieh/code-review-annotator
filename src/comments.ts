import * as fs from 'node:fs'
import * as path from 'node:path'
import { nanoid } from 'nanoid'
import { simpleGit } from 'simple-git'

export interface ReviewRound {
  id: number
  baseCommit: string
  createdAt: string
}

export interface ReviewComment {
  id: string
  file: string
  startLine: number
  endLine: number
  side: 'old' | 'new'
  body: string
  status: 'open' | 'resolved' | 'stale'
  round: number
  resolvedInRound?: number
  createdAt: string
}

export interface ReviewStore {
  currentRound: number
  rounds: ReviewRound[]
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
        return JSON.parse(raw) as ReviewStore
      } catch {
        // corrupted file, start fresh
      }
    }
    return { currentRound: 1, rounds: [], comments: [] }
  }

  private save(): void {
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8')
  }

  async ensureInitialRound(): Promise<void> {
    if (this.store.rounds.length === 0) {
      const baseCommit = await this.getCurrentCommit()
      this.store.rounds.push({
        id: 1,
        baseCommit,
        createdAt: new Date().toISOString(),
      })
      this.store.currentRound = 1
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

  getStore(): ReviewStore {
    return this.store
  }

  getCurrentRound(): number {
    return this.store.currentRound
  }

  getRounds(): ReviewRound[] {
    return this.store.rounds
  }

  getComments(opts: {
    file?: string
    round?: number | 'all'
    status?: 'open' | 'resolved' | 'stale'
  } = {}): ReviewComment[] {
    let comments = this.store.comments

    const targetRound = opts.round === 'all' ? null : (opts.round ?? this.store.currentRound)
    if (targetRound !== null) {
      comments = comments.filter(c => c.round === targetRound)
    }

    if (opts.file) {
      comments = comments.filter(c => c.file === opts.file)
    }

    if (opts.status) {
      comments = comments.filter(c => c.status === opts.status)
    }

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
      round: this.store.currentRound,
      createdAt: new Date().toISOString(),
    }
    this.store.comments.push(comment)
    this.save()
    return comment
  }

  updateComment(id: string, data: { body?: string; status?: 'open' | 'resolved' | 'stale' }): ReviewComment | null {
    const comment = this.store.comments.find(c => c.id === id)
    if (!comment) return null

    if (data.body !== undefined) comment.body = data.body
    if (data.status !== undefined) {
      comment.status = data.status
      if (data.status === 'resolved' || data.status === 'stale') {
        comment.resolvedInRound = this.store.currentRound
      }
    }

    this.save()
    return comment
  }

  deleteComment(id: string): boolean {
    const index = this.store.comments.findIndex(c => c.id === id)
    if (index === -1) return false
    this.store.comments.splice(index, 1)
    this.save()
    return true
  }

  async startNewRound(): Promise<{ newRoundId: number; staledCount: number }> {
    const baseCommit = await this.getCurrentCommit()
    const newId = this.store.currentRound + 1

    // stale all open comments from current round
    let staledCount = 0
    for (const comment of this.store.comments) {
      if (comment.round === this.store.currentRound && comment.status === 'open') {
        comment.status = 'stale'
        comment.resolvedInRound = newId
        staledCount++
      }
    }

    this.store.rounds.push({
      id: newId,
      baseCommit,
      createdAt: new Date().toISOString(),
    })
    this.store.currentRound = newId

    this.save()
    return { newRoundId: newId, staledCount }
  }
}
