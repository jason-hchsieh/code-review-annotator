# code-review-annotator

Remote code review tool for [Claude Code](https://claude.ai/code) workflows. Browse git diffs in the browser via SSH port forward, leave inline comments on specific lines, then let Claude Code read them through MCP and apply fixes automatically.

```
ssh -L 8080:localhost:8080 your-server
npx code-review-annotator --dir /path/to/project --port 8080
```

![UI screenshot showing diff viewer with inline comment threads](https://placeholder)

---

## Why

When using Claude Code on a remote server, you can't easily review the code it generates before telling it to iterate. This tool closes that loop:

1. Claude Code generates changes on the remote server
2. You SSH port-forward and review the diff in a browser UI
3. You leave inline comments on lines that need fixing
4. You tell Claude Code `"fix review comments"` — it reads comments via MCP, applies fixes, and replies on each thread
5. You resolve or push back in the browser, then iterate

---

## Installation

### As a Claude Code Plugin (recommended)

The plugin ships with a `.claude-plugin/marketplace.json`, so install via Claude Code's plugin commands:

```
/plugin marketplace add /path/to/code-review-annotator
/plugin install code-review-annotator@code-review-annotator-local
```

The plugin bundles an MCP server that connects automatically when Claude Code starts. No `claude mcp add` needed.

### Standalone (npx)

```bash
# HTTP server only
npx code-review-annotator --dir /path/to/project --port 8080

# MCP server only (for manual claude mcp add)
claude mcp add review-annotator -- npx code-review-annotator --mcp --dir /path/to/project
```

---

## Usage

### 1. Start the HTTP server on the remote

```bash
npx code-review-annotator --dir /path/to/project --port 8080
```

| Flag | Default | Description |
|------|---------|-------------|
| `--dir` | `cwd` | Project root (must be a git repo) |
| `--port` | `8080` | HTTP server port |
| `--mcp` | — | Run as MCP stdio server instead |

### 2. Open the UI locally

```bash
ssh -L 8080:localhost:8080 your-server
open http://localhost:8080
```

### 3. Review and annotate

- **Files Changed** sidebar — lists all files in `git diff` with `+/-` stats and comment badges
- **Click** any diff line to add a single-line comment
- **Shift+Click** a second line to select a range, then add a multi-line comment
- Comments appear as inline threads anchored to the diff

### 4. Ask Claude Code to fix

```
fix review comments
```

Claude Code calls `get_review_comments`, reads the `sourceLines` for context, applies each fix, calls `reply_to_comment` to explain what changed, then calls `mark_resolved`.

---

## Comment Lifecycle

Comments have two states:

| Status | Meaning |
|--------|---------|
| `open` | Needs fixing |
| `resolved` | Fixed and marked done |

The `baseCommit` (captured on first use and stored in `.review-comments.json`) is the reference point all diffs are computed against. Each comment also has a `replies` thread so Claude Code and the human reviewer can have a back-and-forth on a single issue without losing context.

---

## MCP Tools

Claude Code accesses these tools via the `code-review` MCP server:

| Tool | Description |
|------|-------------|
| `get_review_comments` | Fetch comments. Defaults to `open` status. Each result includes `sourceLines` (actual file content at that line range) and any existing `replies`. |
| `get_changed_files` | List all files in `git diff` with open comment counts. |
| `get_export_prompt` | Generate a ready-to-use fix/report/both prompt string. |
| `mark_resolved` | Mark a comment as resolved by ID. |
| `reply_to_comment` | Add a reply to a comment thread (authored as `claude`). Use after fixing to explain what changed. |

`get_review_comments` parameters:

```ts
get_review_comments(
  file?: string,           // filter by file path
  status?: 'open' | 'resolved',  // default: 'open'
)
```

Line numbers are **actual file line numbers** (1-based), not diff positions:
- `side: "new"` → line in the current file on disk
- `side: "old"` → line in the pre-change file (`git show <baseCommit>:<file>`)

---

## REST API

The HTTP server also exposes a REST API for custom integrations:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/files` | Directory file tree (respects `.gitignore` / `.claudeignore`) |
| `GET` | `/api/diff?file=` | Parsed unified diff for a file |
| `GET` | `/api/diff/summary` | All changed files with `+/-` stats |
| `GET` | `/api/comments` | Comments (`?file=`, `?status=` filters) |
| `POST` | `/api/comments` | Add a comment |
| `PATCH` | `/api/comments/:id` | Update body or status |
| `DELETE` | `/api/comments/:id` | Delete a comment |
| `POST` | `/api/comments/:id/replies` | Add a reply to a comment thread |
| `GET` | `/api/export?mode=fix\|report\|both` | Generate prompt string |

---

## Data

Comments are persisted to `.review-comments.json` in the project root. Add it to `.gitignore` (the tool does this automatically when first run).

```jsonc
{
  "baseCommit": "abc123",
  "comments": [
    {
      "id": "abc",
      "file": "src/parser.ts",
      "startLine": 42,
      "endLine": 45,
      "side": "new",
      "body": "This match block can be extracted into a helper",
      "status": "open",
      "createdAt": "...",
      "replies": [
        { "id": "r1", "author": "claude", "body": "Extracted into `parseMatch()`.", "createdAt": "..." }
      ]
    }
  ]
}
```

Old round-based stores are auto-migrated on load (`currentRound` / `rounds[]` collapse into a single `baseCommit`).

The HTTP server and MCP server are separate processes that both read/write this file. Run the HTTP server for the browser UI and install the plugin (or `claude mcp add`) for the MCP server — they share state through the JSON file.

---

## Ignore Rules

`fileTree.ts` filters the file tree and diff summary using, in order:

1. Hard-coded: `node_modules/`, `.git/`, `dist/`, `*.lock`, `.review-comments.json`
2. `.gitignore` (if present)
3. `.claudeignore` (if present, higher priority)

---

## Plugin Architecture

When installed as a Claude Code plugin:

- `.mcp.json` at the plugin root is auto-discovered — no manual `claude mcp add` required
- `scripts/run-mcp.sh` is spawned by Claude Code at session start
- On first run, the script copies `package.json` to `${CLAUDE_PLUGIN_DATA}` and runs `npm ci` there — keeps `node_modules` out of the plugin cache and survives plugin updates
- The script re-installs automatically when `package.json` changes between plugin versions
- The `review-workflow` skill teaches Claude Code the fix loop: `get_review_comments` → apply edits → `reply_to_comment` → `mark_resolved`

---

## Tech Stack

| Concern | Choice |
|---------|--------|
| Runtime | `tsx` (TypeScript, no build step) |
| HTTP server | Node.js built-in `http` |
| MCP transport | `@modelcontextprotocol/sdk` stdio |
| Git | `simple-git` |
| Ignore filtering | `ignore` package |
| Comment IDs | `nanoid` |
| UI | Vanilla JS, single HTML file, dark theme |

---

## License

MIT
