# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start web UI (default port 8080, target the repo to review)
npx tsx src/cli.ts --dir /path/to/repo --base main --port 8080

# Start MCP stdio server (used by Claude Code via `claude mcp add`)
npx tsx src/cli.ts --mcp --dir /path/to/repo --base main
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

The tool has two runtime modes, both sharing the same core modules.

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

### MCP mode (`startMcpServer` in `src/mcp.ts`)
An MCP stdio server exposing 5 tools to Claude Code:
`get_review_comments`, `get_changed_files`, `get_export_prompt`, `mark_resolved`, `reply_to_comment`

### Core modules

| File | Responsibility |
|------|---------------|
| `src/comments.ts` | `CommentStore` — all state. Reads/writes `.review-comments.json` in the target repo root. Manages comment lifecycle (`open` ↔ `resolved`) and reply threads. Stores `baseBranch` and per-comment `commitSha` + `anchorSnippet`. |
| `src/gitDiff.ts` | Git diff computation via `simple-git`. `resolveMergeBase(dir, baseBranch)` runs `git merge-base HEAD <baseBranch>`. `detectDefaultBase` tries `main` then `master` for the CLI auto-detect. |
| `src/fileTree.ts` | Directory scanner respecting `.gitignore` and `.claudeignore`. Used by `/api/files` but not the sidebar (sidebar uses diff summary). |

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

- `--dir <path>` — project root (must be a git repo)
- `--base <ref>` — base branch; omit to auto-detect `main` then `master`
- `--port <n>` — HTTP port (default `8080`)
- `--mcp` — run as MCP stdio server instead of HTTP

The CLI resolves `baseBranch` once at startup and passes it to `startHttpServer` / `startMcpServer`. `CommentStore` persists it to `.review-comments.json` but the CLI flag always takes precedence — on next launch the file is overwritten with the flag value.

### Outdated detection

`server.ts` `enrichComments()` and `mcp.ts` both re-fetch current `sourceLines` for each comment and compare with `anchorSnippet`. UI shows an `outdated` badge + the original snippet when `outdated: true`. MCP `get_review_comments` includes `outdated` in every returned comment.
