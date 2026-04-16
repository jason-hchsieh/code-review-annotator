#!/usr/bin/env tsx
import { startHttpServer } from './server.ts'
import { startMcpServer } from './mcp.ts'
import * as path from 'node:path'

const args = process.argv.slice(2)

function parseArgs(args: string[]) {
  let dir = process.cwd()
  let port = 8080
  let mcpMode = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) {
      dir = path.resolve(args[++i])
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10)
    } else if (args[i] === '--mcp') {
      mcpMode = true
    }
  }

  return { dir, port, mcpMode }
}

const { dir, port, mcpMode } = parseArgs(args)

if (mcpMode) {
  startMcpServer(dir)
} else {
  startHttpServer(dir, port)
  console.log(`[code-review-annotator] Web UI  → http://localhost:${port}`)
  console.log(`[code-review-annotator] MCP     → run: claude mcp add review-annotator -- npx code-review-annotator --mcp --dir ${dir}`)
}
