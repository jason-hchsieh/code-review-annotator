import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { LogStore, ReviewComment, ToolCall } from './log.ts'
import { registerProject } from './registry.ts'
import { readBlob } from './git.ts'

function sliceTextLines(text: string, startLine: number, endLine: number): string[] {
  const all = text.split('\n')
  const s = Math.max(1, startLine) - 1
  const e = Math.min(all.length, endLine)
  return all.slice(s, e)
}

function fileForComment(comment: ReviewComment, store: LogStore): string {
  if (comment.file) return comment.file
  const vc = comment.viewContext
  if (vc.source === 'tool-call' && vc.toolCallId) {
    return store.getToolCall(vc.toolCallId)?.file ?? '(unknown)'
  }
  return '(unknown)'
}

function contextLabel(comment: ReviewComment, store: LogStore): string {
  const vc = comment.viewContext
  if (vc.source === 'tool-call') {
    const call = vc.toolCallId ? store.getToolCall(vc.toolCallId) : undefined
    return call?.tool ?? 'tool'
  }
  if (vc.source === 'browse') return 'Browse'
  return `${vc.fromRef ?? '?'}→${vc.toRef ?? '?'}`
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
        lines.push(`- [${contextLabel(comment, store)}, ${comment.viewContext.side ?? '?'}, ${lineRef}] ${comment.body}`)
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
        lines.push(`- **[${contextLabel(comment, store)} ${lineRef} ${comment.viewContext.side ?? '?'}]**: ${comment.body}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function sourceForComment(comment: ReviewComment, store: LogStore, dir: string): string {
  // Prefer the stored anchorText (captured at write time — exact text the reviewer pointed at).
  if (comment.anchorText) return comment.anchorText

  const vc = comment.viewContext
  if (vc.source === 'tool-call') {
    const call = vc.toolCallId ? store.getToolCall(vc.toolCallId) : undefined
    if (!call) return ''
    return vc.side === 'before' ? call.before : (call.after ?? '')
  }
  if (vc.source === 'browse') {
    return comment.file ? readBlob(dir, 'WORKTREE', comment.file) : ''
  }
  if (vc.source === 'git-range') {
    if (!comment.file) return ''
    const ref = vc.side === 'before' ? (vc.fromRef ?? '') : (vc.toRef ?? '')
    return ref ? readBlob(dir, ref, comment.file) : ''
  }
  return ''
}

export function startMcpServer(dir: string) {
  const store = new LogStore(dir)

  try {
    registerProject(dir)
  } catch (err) {
    console.error(`[code-review-annotator] registry write failed: ${String(err)}`)
  }

  const server = new Server(
    { name: 'code-review-annotator', version: '0.17.0' },
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
        name: 'get_review_comments',
        description: 'Get review comments. Each comment is anchored to (file, line-range, blob-sha) and carries a viewContext indicating the perspective it was written in: source="tool-call" (written against a captured Edit / Write), source="git-range" (written while viewing a diff between two refs — fromRef/toRef on viewContext), or source="browse" (written against the worktree). side is "before"/"after" for diffs or "current" for browse. The response includes the source lines at the anchor so Claude can see what the reviewer pointed at. Defaults to open comments.',
        inputSchema: {
          type: 'object',
          properties: {
            toolCallId: { type: 'string', description: 'Filter to comments written against a specific tool-call id' },
            viewSource: { type: 'string', enum: ['tool-call', 'git-range', 'browse'], description: 'Filter by viewContext.source' },
            fromRef: { type: 'string', description: 'For viewSource=git-range: match viewContext.fromRef' },
            toRef: { type: 'string', description: 'For viewSource=git-range: match viewContext.toRef' },
            file: { type: 'string', description: 'Filter by file path (relative to project root)' },
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
            viewSource: { type: 'string', enum: ['tool-call', 'git-range', 'browse'], description: 'Filter by viewContext.source' },
            fromRef: { type: 'string', description: 'For viewSource=git-range: match viewContext.fromRef' },
            toRef: { type: 'string', description: 'For viewSource=git-range: match viewContext.toRef' },
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

    if (name === 'get_review_comments') {
      const comments = store.getComments({
        toolCallId: a.toolCallId as string | undefined,
        viewSource: a.viewSource as 'tool-call' | 'git-range' | 'browse' | undefined,
        fromRef: a.fromRef as string | undefined,
        toRef: a.toRef as string | undefined,
        file: a.file as string | undefined,
        status: (a.status as 'open' | 'resolved') ?? 'open',
      })
      const enriched = comments.map((c) => {
        const source = sourceForComment(c, store, dir)
        const sourceLines = sliceTextLines(source, c.startLine, c.endLine)
        const file = fileForComment(c, store)
        const base: Record<string, unknown> = {
          id: c.id,
          status: c.status,
          body: c.body,
          startLine: c.startLine,
          endLine: c.endLine,
          file,
          viewContext: c.viewContext,
          anchorText: c.anchorText,
          blobSha: c.blobSha,
          createdAt: c.createdAt,
          replies: c.replies,
          sourceLines,
        }
        if (c.viewContext.source === 'tool-call' && c.viewContext.toolCallId) {
          const call = store.getToolCall(c.viewContext.toolCallId)
          base.toolCall = call ? { tool: call.tool, file: call.file, startedAt: call.startedAt, status: call.status } : null
        }
        return base
      })
      return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] }
    }

    if (name === 'get_export_prompt') {
      const toolCallId = a.toolCallId as string | undefined
      const viewSource = a.viewSource as 'tool-call' | 'git-range' | 'browse' | undefined
      const fromRef = a.fromRef as string | undefined
      const toRef = a.toRef as string | undefined
      const mode = (a.mode as 'fix' | 'report' | 'both') ?? 'both'
      const comments = store.getComments({ status: 'open', toolCallId, viewSource, fromRef, toRef })
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
