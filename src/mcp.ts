import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { LogStore, ReviewComment, ReviewSession, TargetKind, ToolCall } from './log.ts'
import { registerProject } from './registry.ts'
import { readBlob } from './git.ts'

function sliceLines(text: string, startLine: number, endLine: number): string[] {
  const all = text.split('\n')
  const s = Math.max(1, startLine) - 1
  const e = Math.min(all.length, endLine)
  return all.slice(s, e)
}

function fileForComment(comment: ReviewComment, store: LogStore): string {
  if (comment.target.kind === 'tool-call') {
    return store.getToolCall(comment.target.id)?.file ?? '(unknown)'
  }
  return comment.target.file ?? '(unknown)'
}

function contextLabel(comment: ReviewComment, store: LogStore): string {
  if (comment.target.kind === 'tool-call') {
    const call = store.getToolCall(comment.target.id)
    return call?.tool ?? 'tool'
  }
  const s = store.getSession(comment.target.id)
  if (!s) return comment.target.kind
  return s.kind === 'browse' ? 'Browse' : `${s.fromRef}→${s.toRef}`
}

function exportPrompt(
  store: LogStore,
  comments: ReviewComment[],
  mode: 'fix' | 'report' | 'both',
): string {
  if (comments.length === 0) return '// No open comments found.'

  const byFile = new Map<string, ReviewComment[]>()
  for (const c of comments) {
    const file = fileForComment(c, store)
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file)!.push(c)
  }

  const lines: string[] = []

  if (mode === 'fix' || mode === 'both') {
    lines.push('Please address the following review comments on edits you made:\n')
    for (const [file, entries] of byFile.entries()) {
      lines.push(`### ${file}`)
      for (const comment of entries) {
        const lineRef = comment.startLine === comment.endLine ? `L${comment.startLine}` : `L${comment.startLine}–L${comment.endLine}`
        lines.push(`- [${contextLabel(comment, store)}, ${comment.side}, ${lineRef}] ${comment.body}`)
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
        lines.push(`- **[${contextLabel(comment, store)} ${lineRef} ${comment.side}]**: ${comment.body}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function sourceForComment(comment: ReviewComment, store: LogStore, dir: string): string {
  if (comment.target.kind === 'tool-call') {
    const call = store.getToolCall(comment.target.id)
    if (!call) return ''
    return comment.side === 'before' ? call.before : (call.after ?? '')
  }
  const session = store.getSession(comment.target.id)
  if (!session || !comment.target.file) return ''
  if (session.kind === 'browse') {
    return readBlob(dir, 'WORKTREE', comment.target.file)
  }
  // git-range
  const ref = comment.side === 'before'
    ? (session.fromSha ?? session.fromRef ?? '')
    : (session.toSha ?? session.toRef ?? '')
  if (!ref) return ''
  return readBlob(dir, ref, comment.target.file)
}

export function startMcpServer(dir: string) {
  const store = new LogStore(dir)

  try {
    registerProject(dir)
  } catch (err) {
    console.error(`[code-review-annotator] registry write failed: ${String(err)}`)
  }

  const server = new Server(
    { name: 'code-review-annotator', version: '0.14.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_tool_calls',
        description: 'List captured tool-call snapshots (Edit / Write / MultiEdit / NotebookEdit) for this project, optionally filtered by file or status. Each entry has id, tool, file, status (pending|complete|orphan), startedAt, completedAt.',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Filter by file path (relative to project root)' },
            status: { type: 'string', enum: ['pending', 'complete', 'orphan'], description: 'Filter by tool-call status' },
          },
        },
      },
      {
        name: 'get_review_sessions',
        description: 'List user-created review sessions (git-range diffs and worktree browse sessions). Each session has its own set of comments independent of the tool-call timeline.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_review_comments',
        description: 'Get review comments across all modes. Each comment is anchored to a target: kind="tool-call" (anchored to a captured Edit / Write), kind="git-range" (anchored to a file in a user-defined git diff session), or kind="browse" (anchored to a file in a worktree browse session). side is "before" / "after" for diffs or "current" for browse. The response includes the source lines at the anchor so Claude can see what the reviewer pointed at. Defaults to open comments.',
        inputSchema: {
          type: 'object',
          properties: {
            toolCallId: { type: 'string', description: 'Filter to comments anchored to a specific tool-call id' },
            sessionId: { type: 'string', description: 'Filter to comments anchored to a specific review-session id' },
            targetKind: { type: 'string', enum: ['tool-call', 'git-range', 'browse'], description: 'Filter by target kind' },
            file: { type: 'string', description: 'Filter by file (git-range / browse comments only)' },
            status: { type: 'string', enum: ['open', 'resolved'], description: 'Filter by status. Defaults to open.' },
          },
        },
      },
      {
        name: 'get_export_prompt',
        description: 'Generate a prompt describing the open review comments, suitable for feeding into another Claude Code session to fix them.',
        inputSchema: {
          type: 'object',
          properties: {
            toolCallId: { type: 'string', description: 'Filter to a specific tool-call id' },
            sessionId: { type: 'string', description: 'Filter to a specific session id' },
            targetKind: { type: 'string', enum: ['tool-call', 'git-range', 'browse'], description: 'Filter by target kind' },
            mode: { type: 'string', enum: ['fix', 'report', 'both'], description: 'Prompt mode' },
          },
          required: ['mode'],
        },
      },
      {
        name: 'mark_resolved',
        description: 'Mark a review comment as resolved.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Comment ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'reply_to_comment',
        description: 'Add a reply to a reviewer comment. Use this after fixing an issue to explain what you changed.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Comment ID to reply to' },
            body: { type: 'string', description: 'Reply text' },
          },
          required: ['id', 'body'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const a = (args ?? {}) as Record<string, unknown>

    if (name === 'get_tool_calls') {
      store.markOrphans()
      const calls = store.getToolCalls({
        file: a.file as string | undefined,
        status: a.status as ToolCall['status'] | undefined,
      })
      const compact = calls.map(c => ({
        id: c.id,
        tool: c.tool,
        file: c.file,
        status: c.status,
        startedAt: c.startedAt,
        completedAt: c.completedAt,
        beforeLines: c.before === '' ? 0 : c.before.split('\n').length,
        afterLines: c.after === null ? null : (c.after === '' ? 0 : c.after.split('\n').length),
      }))
      return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] }
    }

    if (name === 'get_review_sessions') {
      const sessions: ReviewSession[] = store.getSessions()
      return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] }
    }

    if (name === 'get_review_comments') {
      const comments = store.getComments({
        toolCallId: a.toolCallId as string | undefined,
        sessionId: a.sessionId as string | undefined,
        targetKind: a.targetKind as TargetKind | undefined,
        file: a.file as string | undefined,
        status: (a.status as 'open' | 'resolved') ?? 'open',
      })
      const enriched = comments.map((c) => {
        const source = sourceForComment(c, store, dir)
        const sourceLines = sliceLines(source, c.startLine, c.endLine)
        const file = fileForComment(c, store)
        const base: Record<string, unknown> = {
          id: c.id,
          target: c.target,
          toolCallId: c.target.kind === 'tool-call' ? c.target.id : undefined,
          status: c.status,
          body: c.body,
          side: c.side,
          startLine: c.startLine,
          endLine: c.endLine,
          file,
          createdAt: c.createdAt,
          replies: c.replies,
          sourceLines,
        }
        if (c.target.kind === 'tool-call') {
          const call = store.getToolCall(c.target.id)
          base.toolCall = call ? { tool: call.tool, file: call.file, startedAt: call.startedAt, status: call.status } : null
        } else {
          const session = store.getSession(c.target.id)
          base.session = session ?? null
        }
        return base
      })
      return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] }
    }

    if (name === 'get_export_prompt') {
      const toolCallId = a.toolCallId as string | undefined
      const sessionId = a.sessionId as string | undefined
      const targetKind = a.targetKind as TargetKind | undefined
      const mode = (a.mode as 'fix' | 'report' | 'both') ?? 'both'
      const comments = store.getComments({ status: 'open', toolCallId, sessionId, targetKind })
      const prompt = exportPrompt(store, comments, mode)
      return { content: [{ type: 'text', text: prompt }] }
    }

    if (name === 'mark_resolved') {
      const id = a.id as string
      const updated = store.updateComment(id, { status: 'resolved' })
      if (!updated) return { content: [{ type: 'text', text: `Error: comment ${id} not found` }], isError: true }
      return { content: [{ type: 'text', text: `Comment ${id} marked as resolved.` }] }
    }

    if (name === 'reply_to_comment') {
      const id = a.id as string
      const body = a.body as string
      const reply = store.addReply(id, { author: 'claude', body })
      if (!reply) return { content: [{ type: 'text', text: `Error: comment ${id} not found` }], isError: true }
      return { content: [{ type: 'text', text: `Reply added to comment ${id}.` }] }
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  })

  const transport = new StdioServerTransport()
  server.connect(transport)
}
