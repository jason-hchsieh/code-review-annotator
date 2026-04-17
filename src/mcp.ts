import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CommentStore, ReviewComment } from './comments.ts'
import { getChangedFiles, getSourceLines } from './gitDiff.ts'

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function generateExportPrompt(
  comments: ReviewComment[],
  mode: 'fix' | 'report' | 'both',
): string {
  const byFile: Record<string, ReviewComment[]> = {}
  for (const c of comments) {
    if (!byFile[c.file]) byFile[c.file] = []
    byFile[c.file].push(c)
  }

  const lines: string[] = []

  if (mode === 'fix' || mode === 'both') {
    lines.push('Please fix the following issues:\n')
    for (const [file, fileComments] of Object.entries(byFile)) {
      lines.push(`### ${file}`)
      for (const c of fileComments) {
        const lineRef = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–L${c.endLine}`
        lines.push(`- ${lineRef}: ${c.body}`)
      }
      lines.push('')
    }
  }

  if (mode === 'report' || mode === 'both') {
    if (mode === 'both') lines.push('---\n')
    lines.push('## Review Summary\n')
    for (const [file, fileComments] of Object.entries(byFile)) {
      lines.push(`### ${file}`)
      for (const c of fileComments) {
        const lineRef = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}–L${c.endLine}`
        lines.push(`- **${lineRef}**: ${c.body}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

export function startMcpServer(dir: string, baseBranch: string) {
  const store = new CommentStore(dir, baseBranch)

  const server = new Server(
    { name: 'code-review-annotator', version: '0.6.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_review_comments',
        description: 'Get review comments. Defaults to open comments. Each comment includes sourceLines (current file content at the anchor) and outdated (true if the current content no longer matches the snippet captured when the comment was written).',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Filter by file path (relative to project dir)' },
            status: { type: 'string', enum: ['open', 'resolved'], description: 'Filter by status. Defaults to open.' },
          },
        },
      },
      {
        name: 'get_changed_files',
        description: 'Get all files changed relative to the merge-base of HEAD and the base branch, with open comment counts.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_export_prompt',
        description: 'Generate a Claude Code prompt for fixing or reporting review comments.',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Filter to a specific file. Omit for all files.' },
            mode: { type: 'string', enum: ['fix', 'report', 'both'], description: 'Prompt mode' },
          },
          required: ['mode'],
        },
      },
      {
        name: 'mark_resolved',
        description: 'Mark a comment as resolved.',
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

    if (name === 'get_review_comments') {
      const comments = store.getComments({
        file: a.file as string | undefined,
        status: (a.status as 'open' | 'resolved') ?? 'open',
      })

      const enriched = await Promise.all(
        comments.map(async (c) => {
          const sourceLines = await getSourceLines(dir, c.file, c.startLine, c.endLine, c.side, baseBranch)
          const outdated = c.anchorSnippet && c.anchorSnippet.length > 0
            ? !arraysEqual(sourceLines, c.anchorSnippet)
            : false
          return { ...c, sourceLines, outdated }
        }),
      )

      return {
        content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
      }
    }

    if (name === 'get_changed_files') {
      const files = await getChangedFiles(dir, baseBranch)
      const allComments = store.getComments({ status: 'open' })
      const withCounts = files.map(f => ({
        ...f,
        openComments: allComments.filter(c => c.file === f.file).length,
      }))
      return {
        content: [{ type: 'text', text: JSON.stringify(withCounts, null, 2) }],
      }
    }

    if (name === 'get_export_prompt') {
      const fileFilter = a.file as string | undefined
      const mode = (a.mode as 'fix' | 'report' | 'both') ?? 'both'
      const comments = store.getComments({ status: 'open', file: fileFilter })
      const prompt = generateExportPrompt(comments, mode)
      return { content: [{ type: 'text', text: prompt }] }
    }

    if (name === 'mark_resolved') {
      const id = a.id as string
      const updated = store.updateComment(id, { status: 'resolved' })
      if (!updated) {
        return { content: [{ type: 'text', text: `Error: comment ${id} not found` }], isError: true }
      }
      return { content: [{ type: 'text', text: `Comment ${id} marked as resolved.` }] }
    }

    if (name === 'reply_to_comment') {
      const id = a.id as string
      const body = a.body as string
      const reply = store.addReply(id, 'claude', body)
      if (!reply) {
        return { content: [{ type: 'text', text: `Error: comment ${id} not found` }], isError: true }
      }
      return { content: [{ type: 'text', text: `Reply added to comment ${id}.` }] }
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  })

  const transport = new StdioServerTransport()
  server.connect(transport)
}
