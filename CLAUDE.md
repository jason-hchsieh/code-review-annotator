# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start web UI (default port 8080 — multi-project, projects self-register via MCP)
npx tsx src/cli.ts --port 8080

# Pre-seed the registry with a project at HTTP startup (optional shortcut)
npx tsx src/cli.ts --dir /path/to/repo --base main --port 8080

# Start MCP stdio server — registers the project in the shared registry on startup
# --dir defaults to process.cwd() and --base auto-detects main → master
npx tsx src/cli.ts --mcp
```

There is no build step, no test suite, and no lint script. The project runs directly via `tsx`.

## When code changes, check these too

Any code change must be cross-checked against the following, because they describe the same surface and drift silently:

- `README.md` — install instructions, MCP tool table, REST API table, data-model example
- `skills/review-workflow/SKILL.md` — the fix loop Claude Code follows; update when MCP tool names, params, or the workflow order change
- `CLAUDE.md` (this file) — tool list, data model, core-module responsibilities
- `.mcp.json` / `scripts/run-mcp.sh` — the command that launches the MCP server; update when CLI flags or entry points change

Before finishing a code change, ask: "Did I change an MCP tool, a REST endpoint, the data model, the CLI, or the install flow?" If yes, update the matching doc in the same change.

## Version bumping

**Always bump the version in all three files when making changes:**
- `package.json` → `"version"`
- `.claude-plugin/plugin.json` → `"version"`
- `.claude-plugin/marketplace.json` → `plugins[0].version`

Use semver: patch for bug fixes, minor for new features.

## Architecture

The tool has two runtime modes, both sharing the same core modules. A central **project registry** at `$XDG_CONFIG_HOME/code-review-annotator/projects.json` (default `~/.config/...`) lets a single HTTP server serve many projects / worktrees — each MCP server registers its `--dir` on startup, and the browser UI lists every registered project in a dropdown. Stale entries (dir missing) are filtered on read; the file is safe to hand-edit.

### Diff model — GitHub-style

The base is a **branch ref** (e.g. `main`), not a frozen commit. On every diff/comment fetch the server re-runs:

```
git diff $(git merge-base HEAD <baseBranch>)
```

This mirrors how GitHub PRs work:
- Feature branch advances → diff expands
- Base branch advances → merge-base shifts → diff narrows
- Working tree + unstaged changes are always included (local-tool concession — GitHub has no "working tree")

Comments anchor to `(file, startLine, endLine, side)` plus a captured `commitSha` and `anchorSnippet` (the exact `sourceLines` when the comment was written). On read, the server re-fetches current `sourceLines` and compares with `anchorSnippet`; mismatch → `outdated: true`.

### Web UI mode (`startHttpServer` in `src/server.ts`)
A plain `node:http` server (no framework) serving:
- `public/index.html` — single-file SPA (vanilla JS, no build step)
- REST API endpoints under `/api/` (meta, diff, comments, replies, export)
- `GET /api/events` — Server-Sent Events stream for live UI refresh. One `ProjectWatcher` per project (shared across subscribers) polls a cheap signature every 1.5 s: comments file `mtime+size`, plus `HEAD sha + base sha + git status --porcelain` for diff state. Emits `comments` / `diff` events on change. First subscriber starts the watcher; last one stops it.

### MCP mode (`startMcpServer` in `src/mcp.ts`)
An MCP stdio server exposing 5 tools to Claude Code:
`get_review_comments`, `get_changed_files`, `get_export_prompt`, `mark_resolved`, `reply_to_comment`

### Core modules

| File | Responsibility |
|------|---------------|
| `src/comments.ts` | `CommentStore` — all state. Reads/writes `.review-comments.json` in the target repo root. Manages comment lifecycle (`open` ↔ `resolved`) and reply threads. Stores `baseBranch` and per-comment `commitSha` + `anchorSnippet`. HTTP server creates a fresh store per request so MCP writes are always visible. |
| `src/gitDiff.ts` | Git diff computation via `simple-git`. `resolveMergeBase(dir, baseBranch)` runs `git merge-base HEAD <baseBranch>`. `detectDefaultBase` tries `main` then `master` for the CLI auto-detect. Also exports `resolveBaseSha` and `getPorcelainStatus` (used by the watcher signature). |
| `src/fileTree.ts` | Directory scanner respecting `.gitignore` and `.claudeignore`. Used by `/api/files` but not the sidebar (sidebar uses diff summary). |
| `src/registry.ts` | Central project registry. Atomic tmp+rename writes. `registerProject(dir, baseBranch)` is idempotent (upserts by abs path). `listProjects()` filters entries whose `dir` no longer exists. |
| `src/watcher.ts` | `startProjectWatcher(dir, baseBranch, onEvent)` — 1.5 s interval comparing cheap signatures for `.review-comments.json` and git state; invokes `onEvent({ type: 'comments' \| 'diff' })` on change. Returns a stop function. |

### Data model

`.review-comments.json` is written to the **target project's root** (not this repo). It stores:
```
{
  baseBranch: "main",
  comments: [{
    id, file, startLine, endLine, side, body, status, createdAt,
    commitSha,        // HEAD when comment was written
    anchorSnippet,    // string[] — sourceLines captured at write time
    replies: [...]
  }]
}
```

### CLI flags

- `--port <n>` — HTTP port (default `8080`, HTTP mode only)
- `--dir <path>` — project root (must be a git repo). Optional in HTTP mode — if provided, auto-registers the project into the registry at startup.
- `--base <ref>` — base branch; omit to auto-detect `main` then `master`. Used when `--dir` is being registered.
- `--mcp` — run as MCP stdio server instead of HTTP. MCP mode registers `--dir` into the shared registry on startup so it shows up in the browser UI.

**MCP project-dir resolution order** (first match wins):
1. `--dir <path>` flag
2. `$CLAUDE_PROJECT_DIR` env var — forwarded by `scripts/run-mcp.sh` as `--dir` when the value is an existing directory. `.mcp.json` requests this var under `env` so Claude Code can substitute the current session's project.
3. `process.cwd()` — works when launched directly with `tsx src/cli.ts --mcp` from a git repo.
4. Registry fallback in `src/cli.ts` — if the resolved cwd has no `.review-comments.json`, the most recently registered project from `~/.config/code-review-annotator/projects.json` is used. This handles plugin-mode MCP servers whose cwd is the plugin install path.

HTTP mode resolves the project per request by reading the registry and matching the `?project=<abs-dir>` query param (or picking the first registered project when absent). MCP mode resolves `baseBranch` once at startup and passes it to the `CommentStore`. `CommentStore` persists it to `.review-comments.json` but the CLI flag always takes precedence — on next launch the file is overwritten with the flag value.

### Outdated detection

`server.ts` `enrichComments()` and `mcp.ts` both re-fetch current `sourceLines` for each comment and compare with `anchorSnippet`. UI shows an `outdated` badge + the original snippet when `outdated: true`. MCP `get_review_comments` includes `outdated` in every returned comment.
