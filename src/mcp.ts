import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { LogStore, ReviewComment, ToolCall } from './log.ts'
import { registerProject } from './registry.ts'

function sliceLines(text: string, startLine: number, endLine: number): string[] {
  const all = text.split('\n')
  const s = Math.max(1, startLine) - 1
  const e = Math.min(all.length, endLine)
  return all.slice(s, e)
}

function exportPrompt(
  calls: ToolCall[],
  comments: ReviewComment[],
  mode: 'fix' | 'report' | 'both',
): string {
  if (comments.length === 0) return '// No open comments found.'

  const byCall = new Map<string, ToolCall>()
  for (const c of calls) byCall.set(c.id, c)

  const byFile = new Map<string, Array<{ call: ToolCall; comment: ReviewComment }>>()
  for (const cm of comments) {
    const call = byCall.get(cm.toolCallId)
    if (!call) continue
    if (!byFile.has(call.file)) byFile.set(call.file, [])
    byFile.get(call.file)!.push({ call, comment: cm })
  }

  const lines: string[] = []

  if (mode === 'fix' || mode === 'both') {
    lines.push('Please address the following review comments on edits you made:\n')
    for (const [file, entries] of byFile.entries()) {
      lines.push(`### ${file}`)
      for (const { call, comment } of entries) {
        const lineRef = comment.startLine === comment.endLine ? `L${comment.startLine}` : `L${comment.startLine}–L${comment.endLine}`
        lines.push(`- [${call.tool}, ${comment.side}, ${lineRef}] ${comment.body}`)
      }
      lines.push('')
    }
  }

  if (mode === 'report' || mode === 'both') {
    if (mode === 'both') lines.push('---\n')
    lines.push('## Review Summary\n')
    for (const [file, entries] of byFile.entries()) {
      lines.push(`### ${file}`)
      for (const { call, comment } of entries) {
        const lineRef = comment.startLine === comment.endLine ? `L${comment.startLine}` : `L${comment.startLine}–L${comment.endLine}`
        lines.push(`- **[${call.tool} ${lineRef} ${comment.side}]**: ${comment.body}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

export function startMcpServer(dir: string) {
  const store = new LogStore(dir)

  try {
    registerProject(dir)
  } catch (err) {
    console.error(`[code-review-annotator] registry write failed: ${String(err)}`)
  }

  const server = new Server(
    { name: 'code-review-annotator', version: '0.13.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_tool_calls',
        description: 'List captured tool-call snapshots (Edit / Write / MultiEdit / NotebookEdit) for this project, optionally filtered by file or status. Each entry has id, tool, file, status (pending|complete|orphan), startedAt, completedAt. Use this to discover which tool-call id a review comment is anchored to.',
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
        description: 'Get review comments. Each comment is anchored to a specific tool call and side ("before" = file content before the edit; "after" = file content after the edit). The response includes the tool call context (file, tool, startedAt) and the actual source lines at the anchor so Claude can see what the reviewer was pointing at. Defaults to open comments.',
        inputSchema: {
          type: 'object',
          properties: {
            toolCallId: { type: 'string', description: 'Filter to a specific tool-call id' },
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
        status: (a.status as 'open' | 'resolved') ?? 'open',
      })
      const enriched = comments.map((c) => {
        const call = store.getToolCall(c.toolCallId)
        const source = call
          ? (c.side === 'before' ? call.before : (call.after ?? ''))
          : ''
        const sourceLines = sliceLines(source, c.startLine, c.endLine)
        return {
          id: c.id,
          toolCallId: c.toolCallId,
          status: c.status,
          body: c.body,
          side: c.side,
          startLine: c.startLine,
          endLine: c.endLine,
          createdAt: c.createdAt,
          replies: c.replies,
          toolCall: call ? { tool: call.tool, file: call.file, startedAt: call.startedAt, status: call.status } : null,
          sourceLines,
        }
      })
      return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] }
    }

    if (name === 'get_export_prompt') {
      const toolCallId = a.toolCallId as string | undefined
      const mode = (a.mode as 'fix' | 'report' | 'both') ?? 'both'
      const comments = store.getComments({ status: 'open', toolCallId })
      const calls = store.getToolCalls()
      const prompt = exportPrompt(calls, comments, mode)
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
