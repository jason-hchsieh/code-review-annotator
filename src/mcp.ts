import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CommentStore } from './comments.ts'
import { getChangedFiles, getSourceLines } from './gitDiff.ts'

function generateExportPrompt(
  comments: ReturnType<CommentStore['getComments']>,
  mode: 'fix' | 'report' | 'both',
): string {
  const byFile: Record<string, typeof comments> = {}
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

export function startMcpServer(dir: string) {
  const store = new CommentStore(dir)
  store.ensureInitialRound()

  const server = new Server(
    { name: 'code-review-annotator', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_review_comments',
        description: 'Get review comments. Defaults to current round open comments.',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string', description: 'Filter by file path (relative to project dir)' },
            status: { type: 'string', enum: ['open', 'resolved', 'stale'], description: 'Filter by status' },
            round: { description: 'Round number or "all". Defaults to current round.', oneOf: [{ type: 'number' }, { type: 'string', enum: ['all'] }] },
          },
        },
      },
      {
        name: 'get_changed_files',
        description: 'Get all files changed in git diff, with open comment counts.',
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
        name: 'start_new_round',
        description: 'Start a new review round. Marks all open comments in current round as stale.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const a = (args ?? {}) as Record<string, unknown>

    await store.ensureInitialRound()
    const rounds = store.getRounds()
    const currentRoundData = rounds.find(r => r.id === store.getCurrentRound())
    const baseCommit = currentRoundData?.baseCommit ?? 'HEAD'

    if (name === 'get_review_comments') {
      const round = a.round as number | 'all' | undefined
      const comments = store.getComments({
        file: a.file as string | undefined,
        status: (a.status as 'open' | 'resolved' | 'stale') ?? 'open',
        round: round ?? store.getCurrentRound(),
      })

      const enriched = await Promise.all(
        comments.map(async (c) => {
          const sourceLines = await getSourceLines(dir, c.file, c.startLine, c.endLine, c.side, baseCommit)
          return { ...c, sourceLines }
        }),
      )

      return {
        content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
      }
    }

    if (name === 'get_changed_files') {
      const files = await getChangedFiles(dir, baseCommit)
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
      return {
        content: [{ type: 'text', text: prompt }],
      }
    }

    if (name === 'mark_resolved') {
      const id = a.id as string
      const updated = store.updateComment(id, { status: 'resolved' })
      if (!updated) {
        return { content: [{ type: 'text', text: `Error: comment ${id} not found` }], isError: true }
      }
      return { content: [{ type: 'text', text: `Comment ${id} marked as resolved.` }] }
    }

    if (name === 'start_new_round') {
      const result = await store.startNewRound()
      return {
        content: [{
          type: 'text',
          text: `Started round ${result.newRoundId}. ${result.staledCount} comment(s) marked as stale.`,
        }],
      }
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  })

  const transport = new StdioServerTransport()
  server.connect(transport)
}
