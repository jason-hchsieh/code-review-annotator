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

## Version bumping

**Always bump the version in both files when making changes:**
- `package.json` → `"version"`
- `.claude-plugin/plugin.json` → `"version"`

Use semver: patch for bug fixes, minor for new features.

## Architecture

The tool has two runtime modes, both sharing the same core modules:

### Web UI mode (`startHttpServer` in `src/server.ts`)
A plain `node:http` server (no framework) serving:
- `public/index.html` — single-file SPA (vanilla JS, no build step)
- REST API endpoints under `/api/` (diff, comments, rounds, export)

### MCP mode (`startMcpServer` in `src/mcp.ts`)
An MCP stdio server exposing 5 tools to Claude Code:
`get_review_comments`, `get_changed_files`, `get_export_prompt`, `mark_resolved`, `start_new_round`

### Core modules

| File | Responsibility |
|------|---------------|
| `src/comments.ts` | `CommentStore` — all state. Reads/writes `.review-comments.json` in the target repo root. Manages review rounds and comment lifecycle (`open` → `stale` / `resolved`). |
| `src/gitDiff.ts` | Git diff computation via `simple-git`. Uses `--numstat` for accurate line counts and falls back to `--cached` for newly staged files. Parses unified diff into typed `ParsedHunk[]` / `ParsedLine[]`. |
| `src/fileTree.ts` | Directory scanner respecting `.gitignore` and `.claudeignore`. Used by `/api/files` but not the sidebar (sidebar uses diff summary). |

### Data model

`.review-comments.json` is written to the **target project's root** (not this repo). It stores:
```
{ currentRound, rounds: [{ id, baseCommit, createdAt }], comments: [...] }
```
`baseCommit` is the HEAD commit hash captured when a round is created — diffs are computed relative to this commit, not HEAD.

### Diff computation flow

`getChangedFiles` / `getFileDiff` first try `git diff <baseCommit>`, then fall back to `git diff --cached <baseCommit>` when the working tree diff is empty (covers newly staged files not yet in HEAD).

### Round lifecycle

1. Round 1 is created on first use, capturing HEAD as `baseCommit`.
2. "Start New Round" stales all `open` comments from the current round and captures a new `baseCommit`.
3. The web UI can view comments from any past round (read-only) via the round selector.
