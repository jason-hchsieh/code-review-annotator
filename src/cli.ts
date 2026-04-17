#!/usr/bin/env tsx
import { startHttpServer } from './server.ts'
import { startMcpServer } from './mcp.ts'
import { detectDefaultBase } from './gitDiff.ts'
import { CommentStore } from './comments.ts'
import { registerProject, listProjects } from './registry.ts'
import * as path from 'node:path'
import * as fs from 'node:fs'

const args = process.argv.slice(2)

function parseArgs(args: string[]) {
  let dir: string | null = null
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

async function resolveBaseBranch(target: string): Promise<string> {
  if (base) return base
  const stored = CommentStore.readStoredBaseBranch(target)
  if (stored) return stored
  const detected = await detectDefaultBase(target)
  if (!detected) {
    console.error('[code-review-annotator] No --base specified and neither main nor master exists. Pass --base <branch>.')
    process.exit(1)
  }
  return detected
}

if (mcpMode) {
  let target = dir ?? process.cwd()
  // If cwd has no .review-comments.json, fall back to the most recently
  // registered project that does — lets a global MCP plugin work from any session.
  if (!dir && !fs.existsSync(path.join(target, '.review-comments.json'))) {
    const registered = listProjects().filter(p =>
      fs.existsSync(path.join(p.dir, '.review-comments.json'))
    )
    if (registered.length === 1) {
      target = registered[0].dir
      console.error(`[code-review-annotator] cwd has no comments; using registered project: ${target}`)
    } else if (registered.length > 1) {
      // Most recently registered
      const latest = registered[registered.length - 1]
      target = latest.dir
      console.error(`[code-review-annotator] Multiple projects with comments; using most recent: ${target}`)
    }
  }
  const baseBranch = await resolveBaseBranch(target)
  startMcpServer(target, baseBranch)
} else {
  if (dir) {
    const baseBranch = await resolveBaseBranch(dir)
    registerProject(dir, baseBranch)
    console.log(`[code-review-annotator] Registered → ${dir} (base: ${baseBranch})`)
  }
  startHttpServer(port)
  const projects = listProjects()
  console.log(`[code-review-annotator] Web UI  → http://localhost:${port}`)
  console.log(`[code-review-annotator] Projects (${projects.length}):`)
  for (const p of projects) {
    console.log(`  - ${p.dir} (base: ${p.baseBranch})`)
  }
  console.log(`[code-review-annotator] Register more via: claude mcp add review-annotator -- npx code-review-annotator --mcp --dir <path> --base <branch>`)
}
