# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start web UI (default port 8080 — multi-project, projects self-register via MCP)
npx tsx src/cli.ts --port 8080

# Pre-seed the registry with a project at HTTP startup (optional shortcut)
npx tsx src/cli.ts --dir /path/to/repo --port 8080

# Start MCP stdio server — registers the project in the shared registry on startup
# --dir defaults to process.cwd()
npx tsx src/cli.ts --mcp
```

There is no build step, no test suite, and no lint script. The project runs directly via `tsx`.

## When code changes, check these too

Any code change must be cross-checked against the following, because they describe the same surface and drift silently:

- `README.md` — install instructions, MCP tool table, REST API table, data-model example
- `skills/review-workflow/SKILL.md` — the fix loop Claude Code follows; update when MCP tool names, params, or the workflow order change
- `CLAUDE.md` (this file) — tool list, data model, core-module responsibilities
- `.mcp.json` / `scripts/run-mcp.sh` — the command that launches the MCP server; update when CLI flags or entry points change
- `hooks/hooks.json` / `scripts/hook.js` — the Pre/PostToolUse capture path; update when the tool-call wire format changes

Before finishing a code change, ask: "Did I change an MCP tool, a REST endpoint, the data model, the CLI, the hook wire format, or the install flow?" If yes, update the matching doc in the same change.

## Version bumping

**Always bump the version in all three files when making changes:**
- `package.json` → `"version"`
- `.claude-plugin/plugin.json` → `"version"`
- `.claude-plugin/marketplace.json` → `plugins[0].version`

Use semver: patch for bug fixes, minor for new features.

## Architecture

The tool has two runtime modes, both sharing the same core modules. A central **project registry** at `$XDG_CONFIG_HOME/code-review-annotator/projects.json` (default `~/.config/...`) lets a single HTTP server serve many projects / worktrees — each MCP server registers its `--dir` on startup, and the browser UI lists every registered project in a dropdown. The HTTP server also writes its port into every registered project's entry on startup and clears it on shutdown, so the Pre/PostToolUse hook scripts can discover where to send captures. Stale entries (dir missing) are filtered on read; the file is safe to hand-edit.

### Data model — tool-call timeline

Unlike a GitHub-style PR view, this tool models each Edit / Write / MultiEdit / NotebookEdit as an independent **tool call**. Every call captures the target file's full contents before and after the tool ran. The UI renders a timeline of tool calls; clicking one opens a two-panel before→after diff. Reviewers anchor comments to specific lines of either side.

Because snapshots are captured at the moment the tool ran, the diff view is stable — later edits to the same file produce *new* tool-call cards rather than mutating existing ones. There is no merge-base and no base branch.

### Web UI mode (`startHttpServer` in `src/server.ts`)
A plain `node:http` server (no framework) serving:
- `public/index.html` — single-file SPA (vanilla JS, no build step); uses `diff@5.2.0` from CDN for client-side unified diff rendering
- REST API endpoints under `/api/` (tool calls, comments, replies, export, SSE)
- `GET /api/events` — Server-Sent Events stream for live UI refresh. One `ProjectWatcher` per project (shared across subscribers) polls a cheap signature every 1.5 s over `.review-log.json` `mtime+size`. Emits a `log` event on change. First subscriber starts the watcher; last one stops it.

On startup the HTTP server iterates `listProjects()` and writes its port into each project's registry entry via `setHttpPort(dir, port)`. `SIGINT` / `SIGTERM` / `beforeExit` clear those entries so hooks don't try to POST to a dead server.

### MCP mode (`startMcpServer` in `src/mcp.ts`)
An MCP stdio server exposing 5 tools to Claude Code:
- `get_tool_calls` — list captured Edit/Write/MultiEdit/NotebookEdit snapshots (optionally filtered by file / status)
- `get_review_comments` — open comments enriched with `toolCall` context and actual `sourceLines` at the anchor
- `get_export_prompt` — fix / report / both prompt string
- `mark_resolved` — close a comment by id
- `reply_to_comment` — add a reply authored as `claude`

### Pre/Post hooks (`scripts/hook.js` + `hooks/hooks.json`)

The plugin installs PreToolUse and PostToolUse hooks matching `Edit|Write|MultiEdit|NotebookEdit`. Both invoke the same Node script with a `pre` / `post` argument:

1. Read stdin JSON (`tool_name`, `tool_input.file_path`, `tool_use_id`, `session_id`, `cwd`)
2. Walk the registry to find which registered project contains `cwd`
3. Read the target file's current contents
4. POST to `http://127.0.0.1:<httpPort>/api/tool-calls/{start|complete}?project=<dir>` with a 1.5 s timeout

The script **always exits 0** on any failure (server down, no matching project, file unreadable) — review capture must never block Claude Code. The server pairs Pre and Post via `tool_use_id`; if Post never arrives within 5 min, `markOrphans()` downgrades the call's status to `orphan`.

### Core modules

| File | Responsibility |
|------|---------------|
| `src/log.ts` | `LogStore` — all state. Reads/writes `.review-log.json` in the target repo root. Manages tool-call lifecycle (`pending` → `complete` / `orphan`), comments (`open` ↔ `resolved`) and reply threads. Atomic tmp+rename writes. The constructor only reads; it never writes on load, so the HTTP handler can safely create a fresh store per request without self-triggering the SSE watcher. |
| `src/registry.ts` | Central project registry. Atomic writes. `registerProject(dir)` upserts by abs path. `setHttpPort` / `clearHttpPort` let the HTTP server advertise its listening port. `listProjects()` filters entries whose `dir` no longer exists. |
| `src/watcher.ts` | `startProjectWatcher(dir, onEvent)` — 1.5 s interval comparing `.review-log.json` `mtime+size`; invokes `onEvent({ type: 'log' })` on change. Returns a stop function. |
| `scripts/hook.js` | PreToolUse / PostToolUse capture script. Silent exit 0 on any failure. |

### Data model

`.review-log.json` is written to the **target project's root** (not this repo). It stores:
```
{
  toolCalls: [{
    id,               // short nanoid, surfaced in UI / MCP
    toolUseId,        // Claude Code's tool_use_id — pairs Pre + Post hook
    sessionId,
    tool,             // Edit | Write | MultiEdit | NotebookEdit
    file,             // path relative to project root
    before,           // full file contents before the edit
    after,            // full file contents after the edit (null while pending)
    status,           // pending | complete | orphan
    startedAt,
    completedAt,
  }],
  comments: [{
    id,
    toolCallId,       // which tool-call this comment is anchored to
    side,             // 'before' | 'after'
    startLine, endLine,
    body, status,     // open | resolved
    createdAt,
    replies: [{ id, author: 'claude' | 'human', body, createdAt }]
  }]
}
```

### CLI flags

- `--port <n>` — HTTP port (default `8080`, HTTP mode only)
- `--dir <path>` — project root. Optional in HTTP mode; auto-registers on startup if given.
- `--mcp` — run as MCP stdio server instead of HTTP. MCP mode registers `--dir` so it shows up in the browser UI.

**MCP project-dir resolution order** (first match wins):
1. `--dir <path>` flag
2. `$CLAUDE_PROJECT_DIR` env var — forwarded by `scripts/run-mcp.sh` as `--dir` when the value is an existing directory. `.mcp.json` requests this var under `env` so Claude Code can substitute the current session's project.
3. `process.cwd()` — works when launched directly with `tsx src/cli.ts --mcp` from a git repo.
4. Registry fallback in `src/cli.ts` — if the resolved cwd has no `.review-log.json`, the most recently registered project from `~/.config/code-review-annotator/projects.json` is used. This handles plugin-mode MCP servers whose cwd is the plugin install path.

HTTP mode resolves the project per request by reading the registry and matching the `?project=<abs-dir>` query param (or picking the first registered project when absent).
