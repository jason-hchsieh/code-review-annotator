import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Anchor, CommentScope, LogStore, ReviewComment, ToolCall } from './log.ts'
import { registerProject } from './registry.ts'
import { readBlob } from './git.ts'

const SCOPES: ReadonlyArray<CommentScope> = ['line', 'file', 'multi-file', 'view']

function sliceTextLines(text: string, startLine: number, endLine: number): string[] {
  const all = text.split('\n')
  const s = Math.max(1, startLine) - 1
  const e = Math.min(all.length, endLine)
  return all.slice(s, e)
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

function lineRefOf(a: Anchor): string {
  if (a.startLine == null) return ''
  return a.startLine === a.endLine ? `L${a.startLine}` : `L${a.startLine}–L${a.endLine}`
}

function exportPrompt(
  store: LogStore,
  comments: ReviewComment[],
  mode: 'fix' | 'report' | 'both',
): string {
  if (comments.length === 0) return '// No open comments found.'

  const byScope: Record<CommentScope, ReviewComment[]> = {
    line: [], file: [], 'multi-file': [], view: [],
  }
  for (const c of comments) byScope[c.scope].push(c)

  const lines: string[] = []

  if (mode === 'fix' || mode === 'both') {
    lines.push('Please address the following review comments on edits you made:\n')

    if (byScope.line.length > 0) {
      lines.push('## Line-level comments')
      const byFile = new Map<string, ReviewComment[]>()
      for (const c of byScope.line) {
        const f = c.anchors[0]?.file ?? '(unknown)'
        if (!byFile.has(f)) byFile.set(f, [])
        byFile.get(f)!.push(c)
      }
      for (const [file, entries] of byFile.entries()) {
        lines.push(`### ${file}`)
        for (const c of entries) {
          const a = c.anchors[0]
          lines.push(`- [${contextLabel(c, store)}, ${c.viewContext.side ?? '?'}, ${lineRefOf(a)}] ${c.body}`)
        }
        lines.push('')
      }
    }

    if (byScope.file.length > 0) {
      lines.push('## File-level comments')
      lines.push('_These apply to the whole file. Decide scope of change yourself._\n')
      for (const c of byScope.file) {
        const f = c.anchors[0]?.file ?? '(unknown)'
        lines.push(`### ${f}`)
        lines.push(`- [${contextLabel(c, store)}] ${c.body}`)
        lines.push('')
      }
    }

    if (byScope['multi-file'].length > 0) {
      lines.push('## Multi-file comments')
      lines.push('_These span several files at once. Read all of them before editing._\n')
      for (const c of byScope['multi-file']) {
        const files = c.anchors.map(a => a.file).join(', ')
        lines.push(`- **Files**: ${files}`)
        lines.push(`  [${contextLabel(c, store)}] ${c.body}`)
        lines.push('')
      }
    }

    if (byScope.view.length > 0) {
      lines.push('## Review-level comments')
      lines.push('_These are about the review as a whole — architecture, missing tests, coverage. Plan before editing._\n')
      for (const c of byScope.view) {
        lines.push(`- [${contextLabel(c, store)}] ${c.body}`)
      }
      lines.push('')
    }
  }

  if (mode === 'report' || mode === 'both') {
    if (mode === 'both') lines.push('---\n')
    lines.push('## Review Summary\n')
    for (const scope of SCOPES) {
      const entries = byScope[scope]
      if (entries.length === 0) continue
      lines.push(`### ${scope === 'line' ? 'Line' : scope === 'file' ? 'File-level' : scope === 'multi-file' ? 'Multi-file' : 'Review-level'} (${entries.length})`)
      for (const c of entries) {
        const scopeRef = scope === 'line'
          ? `${c.anchors[0]?.file ?? ''} ${lineRefOf(c.anchors[0])}`
          : scope === 'file'
            ? (c.anchors[0]?.file ?? '')
            : scope === 'multi-file'
              ? c.anchors.map(a => a.file).join(' + ')
              : '(view)'
        lines.push(`- **[${contextLabel(c, store)} | ${scopeRef}]**: ${c.body}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function sourceForAnchor(c: ReviewComment, anchor: Anchor, store: LogStore, dir: string): string {
  if (anchor.anchorText) return anchor.anchorText
  const vc = c.viewContext
  if (vc.source === 'tool-call') {
    const call = vc.toolCallId ? store.getToolCall(vc.toolCallId) : undefined
    if (!call) return ''
    const sha = vc.side === 'before' ? call.beforeSha : (call.afterSha ?? '')
    return store.readBlob(sha)
  }
  if (vc.source === 'browse') {
    return anchor.file ? readBlob(dir, 'WORKTREE', anchor.file) : ''
  }
  if (vc.source === 'git-range') {
    if (!anchor.file) return ''
    const ref = vc.side === 'before' ? (vc.fromRef ?? '') : (vc.toRef ?? '')
    return ref ? readBlob(dir, ref, anchor.file) : ''
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
    { name: 'code-review-annotator', version: '0.19.0' },
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
        description: `Get review comments. Every comment has a 'scope' telling you how broad the target is:
- 'line': targets a specific line range. anchors[0] has file, blobSha, startLine, endLine, anchorText.
- 'file': targets a whole file. anchors[0] has file + blobSha, no line range. Interpret as "something about this file overall" (rename, split, delete, add tests, etc.).
- 'multi-file': targets multiple files at once. anchors has one entry per file. Read all of them before choosing where to edit — the instruction applies across the set.
- 'view': targets the review as a whole (architecture, missing tests, cross-cutting concerns). anchors is empty; the target is the viewContext (which tool call, which git range, or the browse view).

Every comment also carries a viewContext saying which UI perspective it was written in: source='tool-call' (carrying toolCallId), 'git-range' (carrying fromRef/toRef), or 'browse'. side='before'/'after' for diffs, 'current' for browse.

The response includes sourceLines per anchor when applicable (scope='line') so you can see the exact text the reviewer pointed at. Defaults to open comments.`,
        inputSchema: {
          type: 'object',
          properties: {
            toolCallId: { type: 'string', description: 'Filter to comments written against a specific tool-call id' },
            scope: { type: 'string', enum: ['line', 'file', 'multi-file', 'view'], description: 'Filter by comment scope' },
            viewSource: { type: 'string', enum: ['tool-call', 'git-range', 'browse'], description: 'Filter by viewContext.source' },
            fromRef: { type: 'string', description: 'For viewSource=git-range: match viewContext.fromRef' },
            toRef: { type: 'string', description: 'For viewSource=git-range: match viewContext.toRef' },
            file: { type: 'string', description: 'Filter to comments whose anchors include this file (matches line/file/multi-file scopes)' },
            status: { type: 'string', enum: ['open', 'resolved'], description: 'Filter by status. Defaults to open.' },
          },
        },
      },
      {
        name: 'get_export_prompt',
        description: 'Generate a prompt describing the open review comments, grouped by scope (line / file / multi-file / view), suitable for feeding into another Claude Code session to fix them.',
        inputSchema: {
          type: 'object',
          properties: {
            toolCallId: { type: 'string', description: 'Filter to a specific tool-call id' },
            scope: { type: 'string', enum: ['line', 'file', 'multi-file', 'view'], description: 'Filter by scope' },
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
          properties: { id: { type: 'string', description: 'Comment ID' } },
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
      }))
      return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] }
    }

    if (name === 'get_review_comments') {
      const comments = store.getComments({
        toolCallId: a.toolCallId as string | undefined,
        scope: a.scope as CommentScope | undefined,
        viewSource: a.viewSource as 'tool-call' | 'git-range' | 'browse' | undefined,
        fromRef: a.fromRef as string | undefined,
        toRef: a.toRef as string | undefined,
        file: a.file as string | undefined,
        status: (a.status as 'open' | 'resolved') ?? 'open',
      })
      const enriched = comments.map((c) => {
        const base: Record<string, unknown> = {
          id: c.id,
          scope: c.scope,
          status: c.status,
          body: c.body,
          viewContext: c.viewContext,
          createdAt: c.createdAt,
          replies: c.replies,
          anchors: c.anchors.map(anchor => {
            const entry: Record<string, unknown> = {
              file: anchor.file,
              blobSha: anchor.blobSha,
            }
            if (anchor.startLine != null) {
              entry.startLine = anchor.startLine
              entry.endLine = anchor.endLine
              entry.anchorText = anchor.anchorText ?? ''
              const source = sourceForAnchor(c, anchor, store, dir)
              entry.sourceLines = sliceTextLines(source, anchor.startLine, anchor.endLine ?? anchor.startLine)
            }
            return entry
          }),
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
      const scope = a.scope as CommentScope | undefined
      const viewSource = a.viewSource as 'tool-call' | 'git-range' | 'browse' | undefined
      const fromRef = a.fromRef as string | undefined
      const toRef = a.toRef as string | undefined
      const mode = (a.mode as 'fix' | 'report' | 'both') ?? 'both'
      const comments = store.getComments({ status: 'open', toolCallId, scope, viewSource, fromRef, toRef })
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
