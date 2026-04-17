# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start web UI (default port 8080, target the repo to review)
npx tsx src/cli.ts --dir /path/to/repo --port 8080

# Start MCP stdio server (used by Claude Code via `claude mcp add`)
npx tsx src/cli.ts --mcp --dir /path/to/repo
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

The tool has two runtime modes, both sharing the same core modules:

### Web UI mode (`startHttpServer` in `src/server.ts`)
A plain `node:http` server (no framework) serving:
- `public/index.html` — single-file SPA (vanilla JS, no build step)
- REST API endpoints under `/api/` (diff, comments, replies, export)

### MCP mode (`startMcpServer` in `src/mcp.ts`)
An MCP stdio server exposing 5 tools to Claude Code:
`get_review_comments`, `get_changed_files`, `get_export_prompt`, `mark_resolved`, `reply_to_comment`

### Core modules

| File | Responsibility |
|------|---------------|
| `src/comments.ts` | `CommentStore` — all state. Reads/writes `.review-comments.json` in the target repo root. Manages comment lifecycle (`open` ↔ `resolved`) and reply threads. Auto-migrates legacy round-based stores. |
| `src/gitDiff.ts` | Git diff computation via `simple-git`. Uses `--numstat` for accurate line counts and falls back to `--cached` for newly staged files. Parses unified diff into typed `ParsedHunk[]` / `ParsedLine[]`. |
| `src/fileTree.ts` | Directory scanner respecting `.gitignore` and `.claudeignore`. Used by `/api/files` but not the sidebar (sidebar uses diff summary). |

### Data model

`.review-comments.json` is written to the **target project's root** (not this repo). It stores:
```
{ baseCommit, comments: [{ id, file, startLine, endLine, side, body, status, createdAt, replies: [...] }] }
```
`baseCommit` is the HEAD commit hash captured on first use — diffs are computed relative to this commit, not HEAD. Each comment has a `replies[]` thread for Claude Code ↔ reviewer dialogue.

### Diff computation flow

`getChangedFiles` / `getFileDiff` first try `git diff <baseCommit>`, then fall back to `git diff --cached <baseCommit>` when the working tree diff is empty (covers newly staged files not yet in HEAD).

### Migration from round-based stores

`CommentStore.load()` detects legacy stores (those containing `rounds` or `currentRound`) and collapses them into the current flat shape, preserving `baseCommit` from the first round and mapping any non-`resolved` status to `open`.
