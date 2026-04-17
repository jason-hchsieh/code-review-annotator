#!/usr/bin/env tsx
import { startHttpServer } from './server.ts'
import { startMcpServer } from './mcp.ts'
import { registerProject, listProjects } from './registry.ts'
import * as path from 'node:path'
import * as fs from 'node:fs'

const args = process.argv.slice(2)

function parseArgs(argv: string[]) {
  let dir: string | null = null
  let port = 8080
  let mcpMode = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      dir = path.resolve(argv[++i])
    } else if (argv[i] === '--port' && argv[i + 1]) {
      port = parseInt(argv[++i], 10)
    } else if (argv[i] === '--mcp') {
      mcpMode = true
    }
  }
  return { dir, port, mcpMode }
}

const { dir, port, mcpMode } = parseArgs(args)

const LOG_FILE = '.review-log.json'

if (mcpMode) {
  let target = dir ?? process.cwd()
  // Plugin-mode fallback: when cwd has no log and no --dir was supplied,
  // fall back to the most recently registered project that has a log file.
  if (!dir && !fs.existsSync(path.join(target, LOG_FILE))) {
    const registered = listProjects().filter(p => fs.existsSync(path.join(p.dir, LOG_FILE)))
    if (registered.length >= 1) {
      const latest = registered[registered.length - 1]
      target = latest.dir
      console.error(`[code-review-annotator] cwd has no review log; using registered project: ${target}`)
    }
  }
  startMcpServer(target)
} else {
  if (dir) {
    registerProject(dir)
    console.log(`[code-review-annotator] Registered → ${dir}`)
  }
  startHttpServer(port)
  const projects = listProjects()
  console.log(`[code-review-annotator] Web UI  → http://localhost:${port}`)
  console.log(`[code-review-annotator] Projects (${projects.length}):`)
  for (const p of projects) console.log(`  - ${p.dir}`)
  console.log(`[code-review-annotator] Install plugin to capture Edit/Write snapshots via hooks.`)
}
