#!/usr/bin/env tsx
import { startHttpServer } from './server.ts'
import { startMcpServer } from './mcp.ts'
import { detectDefaultBase } from './gitDiff.ts'
import { CommentStore } from './comments.ts'
import * as path from 'node:path'

const args = process.argv.slice(2)

function parseArgs(args: string[]) {
  let dir = process.cwd()
  let port = 8080
  let mcpMode = false
  let base: string | null = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) {
      dir = path.resolve(args[++i])
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10)
    } else if (args[i] === '--base' && args[i + 1]) {
      base = args[++i]
    } else if (args[i] === '--mcp') {
      mcpMode = true
    }
  }

  return { dir, port, mcpMode, base }
}

const { dir, port, mcpMode, base } = parseArgs(args)

async function resolveBaseBranch(): Promise<string> {
  if (base) return base
  const stored = CommentStore.readStoredBaseBranch(dir)
  if (stored) return stored
  const detected = await detectDefaultBase(dir)
  if (!detected) {
    console.error('[code-review-annotator] No --base specified and neither main nor master exists. Pass --base <branch>.')
    process.exit(1)
  }
  return detected
}

const baseBranch = await resolveBaseBranch()

if (mcpMode) {
  startMcpServer(dir, baseBranch)
} else {
  startHttpServer(dir, port, baseBranch)
  console.log(`[code-review-annotator] Web UI  → http://localhost:${port}`)
  console.log(`[code-review-annotator] Base    → ${baseBranch}`)
  console.log(`[code-review-annotator] MCP     → run: claude mcp add review-annotator -- npx code-review-annotator --mcp --dir ${dir} --base ${baseBranch}`)
}
