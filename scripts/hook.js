#!/usr/bin/env node
// Claude Code PreToolUse / PostToolUse hook for code-review-annotator.
// Reads the hook JSON from stdin, captures the target file's content
// before/after the edit, and POSTs it to the live HTTP server whose port
// is advertised in the shared project registry.
//
// Failures are silent (exit 0) so Claude Code is never blocked by a
// review tool that isn't running. Usage:
//   node hook.js pre   <- call from PreToolUse
//   node hook.js post  <- call from PostToolUse

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'

const TRACKED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const REQUEST_TIMEOUT_MS = 1500

const mode = process.argv[2]
if (mode !== 'pre' && mode !== 'post') process.exit(0)

async function main() {
  const raw = await readStdin()
  let payload
  try { payload = JSON.parse(raw) } catch { process.exit(0) }

  const tool = payload.tool_name
  if (!TRACKED_TOOLS.has(tool)) process.exit(0)

  const toolInput = payload.tool_input || {}
  const target = toolInput.file_path || toolInput.notebook_path
  if (!target || typeof target !== 'string') process.exit(0)

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd()
  const projectDir = findProjectDir(cwd)
  if (!projectDir) process.exit(0)

  const projects = loadRegistry()
  const project = projects.find(p => p.dir === projectDir)
  if (!project || !project.httpPort) process.exit(0)

  const absFile = path.isAbsolute(target) ? target : path.resolve(cwd, target)
  const relFile = path.relative(projectDir, absFile)
  // Don't track edits to files outside the project root
  if (relFile.startsWith('..') || path.isAbsolute(relFile)) process.exit(0)

  let content = ''
  try { content = fs.readFileSync(absFile, 'utf-8') } catch { /* new file or unreadable: treat as empty */ }

  const toolUseId = typeof payload.tool_use_id === 'string' && payload.tool_use_id
    ? payload.tool_use_id
    : `fallback-${payload.session_id ?? 'sess'}-${absFile}`

  const now = new Date().toISOString()

  if (mode === 'pre') {
    await post(project.httpPort, projectDir, '/api/tool-calls/start', {
      toolUseId,
      sessionId: payload.session_id ?? 'unknown',
      tool,
      file: relFile,
      before: content,
      startedAt: now,
    })
  } else {
    await post(project.httpPort, projectDir, '/api/tool-calls/complete', {
      toolUseId,
      after: content,
      completedAt: now,
    })
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    process.stdin.on('error', () => resolve(''))
  })
}

function loadRegistry() {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  const file = path.join(configBase, 'code-review-annotator', 'projects.json')
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const data = JSON.parse(raw)
    return Array.isArray(data.projects) ? data.projects : []
  } catch {
    return []
  }
}

function findProjectDir(cwd) {
  const abs = path.resolve(cwd)
  const projects = loadRegistry()
  return projects
    .map(p => p.dir)
    .filter(dir => typeof dir === 'string' && (abs === dir || abs.startsWith(dir + path.sep)))
    .sort((a, b) => b.length - a.length)[0]
    ?? null
}

function post(port, projectDir, endpoint, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const url = `${endpoint}?project=${encodeURIComponent(projectDir)}`
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      res.on('data', () => {})
      res.on('end', resolve)
    })
    req.on('timeout', () => { req.destroy(); resolve() })
    req.on('error', () => resolve())
    req.write(payload)
    req.end()
  })
}

main().catch(() => process.exit(0))
