# code-review-annotator

Remote code review tool for [Claude Code](https://claude.ai/code) workflows. Browse git diffs in the browser via SSH port forward, leave inline comments on specific lines, then let Claude Code read them through MCP and apply fixes automatically.

```
ssh -L 8080:localhost:8080 your-server
npx code-review-annotator --port 8080
```

One HTTP server can serve multiple projects / worktrees. MCP servers started via `claude mcp add ... --mcp --dir <path>` register themselves into a central registry; the browser UI lists every registered project in a dropdown.

![UI screenshot showing diff viewer with inline comment threads](https://placeholder)

---

## Why

When using Claude Code on a remote server, you can't easily review the code it generates before telling it to iterate. This tool closes that loop:

1. Claude Code generates changes on the remote server
2. You SSH port-forward and review the diff in a browser UI
3. You leave inline comments on lines that need fixing
4. You tell Claude Code `"fix review comments"` — it reads comments via MCP, applies fixes, and replies on each thread
5. You resolve or push back in the browser, then iterate

The diff model mirrors GitHub pull requests: comparison is `merge-base(HEAD, <base-branch>) → HEAD` + working tree. New commits extend the diff, new commits on the base branch shift the merge-base, and comments are marked **outdated** when the line they anchor to no longer matches what the reviewer saw.

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
# HTTP server (multi-project — projects register via MCP)
npx code-review-annotator --port 8080

# Or pre-seed the registry with a specific project at startup
npx code-review-annotator --dir /path/to/project --base main --port 8080

# MCP server — auto-detects cwd and base branch, registers into the shared registry
claude mcp add review-annotator -- npx code-review-annotator --mcp

# Or pin explicitly when you don't want cwd / auto-detect
claude mcp add review-annotator -- npx code-review-annotator --mcp --dir /path/to/project --base main
```

A single global `claude mcp add review-annotator -- npx code-review-annotator --mcp` works for every project: the MCP server uses `process.cwd()` (the directory Claude Code was invoked in) as its project dir, and auto-detects the base branch (`main` → `master`).

---

## Usage

### 1. Start the HTTP server on the remote

```bash
npx code-review-annotator --port 8080
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `8080` | HTTP server port |
| `--dir` | — | Optional in HTTP mode: if set, auto-registers this project at startup. **Required** in `--mcp` mode. |
| `--base` | auto-detect `main` → `master` | Base branch to diff against (used when registering `--dir`) |
| `--mcp` | — | Run as MCP stdio server instead |

If `--base` is omitted, the tool tries `main` then `master`. If neither exists it errors.

Projects register themselves into `$XDG_CONFIG_HOME/code-review-annotator/projects.json` (default `~/.config/...`). The registry persists across HTTP restarts; stale entries (dir no longer exists) are filtered out of the UI automatically. The registry is safe to hand-edit.

### 2. Open the UI locally

```bash
ssh -L 8080:localhost:8080 your-server
open http://localhost:8080
```

### 3. Review and annotate

- **Files Changed** sidebar — lists all files in `git diff <mergeBase>` with `+/-` stats and comment badges
- **Click** any diff line to add a single-line comment
- **Shift+Click** a second line to select a range, then add a multi-line comment
- Comments appear as inline threads anchored to the diff
- If the code at an anchor later changes, the thread is marked **outdated** and the original snippet is preserved for context

### 4. Ask Claude Code to fix

```
fix review comments
```

Claude Code calls `get_review_comments`, reads the `sourceLines` for context (and `anchorSnippet` if outdated), applies each fix, calls `reply_to_comment` to explain what changed, then calls `mark_resolved`.

---

## Diff Model

The base is a **branch ref**, not a frozen commit — matching GitHub PR semantics:

```
diff = git diff $(git merge-base HEAD <base-branch>)
```

- New commits on the feature branch → diff expands.
- New commits on `main` → merge-base shifts, diff narrows.
- Working-tree + unstaged changes are always included (local-tool scope).

### Comment anchoring & outdated detection

Each comment stores:

- `commitSha` — the HEAD when the comment was written
- `anchorSnippet` — the exact `sourceLines` at the anchor when the comment was written

On every read, the server re-fetches `sourceLines` at the current anchor and compares. If they differ, the comment is flagged `outdated: true`. The original snippet stays visible in the UI so the reviewer (or Claude Code) can see what was originally flagged.

---

## Comment Lifecycle

| Status | Meaning |
|--------|---------|
| `open` | Needs fixing |
| `resolved` | Fixed and marked done |

Each comment has a `replies[]` thread so Claude Code and the human reviewer can have a back-and-forth on a single issue without losing context.

---

## MCP Tools

Claude Code accesses these tools via the `code-review` MCP server:

| Tool | Description |
|------|-------------|
| `get_review_comments` | Fetch comments. Defaults to `open` status. Each result includes `sourceLines` (current file content at the anchor), `anchorSnippet` (content when comment was written), `outdated` (boolean), and any existing `replies`. |
| `get_changed_files` | List all files in the diff with open comment counts. |
| `get_export_prompt` | Generate a ready-to-use fix/report/both prompt string. |
| `mark_resolved` | Mark a comment as resolved by ID. |
| `reply_to_comment` | Add a reply to a comment thread (authored as `claude`). Use after fixing to explain what changed. |

`get_review_comments` parameters:

```ts
get_review_comments(
  file?: string,                 // filter by file path
  status?: 'open' | 'resolved',  // default: 'open'
)
```

Line numbers are **actual file line numbers** (1-based), not diff positions:
- `side: "new"` → line in the current file on disk
- `side: "old"` → line in the file at the merge-base (`git show $(git merge-base HEAD <base>):<file>`)

---

## REST API

The HTTP server also exposes a REST API for custom integrations:

Every project-scoped endpoint takes a `project=<abs-dir>` query parameter identifying which registered project to act on. If omitted, the first registered project is used.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | `[{ id, dir, displayPath, name, baseBranch }]` — the registry |
| `GET` | `/api/meta` | `{ baseBranch, dir, displayPath, name }` for the resolved project |
| `GET` | `/api/files` | Directory file tree (respects `.gitignore` / `.claudeignore`) |
| `GET` | `/api/diff?file=` | Parsed unified diff for a file |
| `GET` | `/api/diff/summary` | All changed files with `+/-` stats |
| `GET` | `/api/comments` | Comments (`?file=`, `?status=` filters), enriched with `sourceLines` + `outdated` |
| `POST` | `/api/comments` | Add a comment (server captures `commitSha` + `anchorSnippet`) |
| `PATCH` | `/api/comments/:id` | Update body or status |
| `DELETE` | `/api/comments/:id` | Delete a comment |
| `POST` | `/api/comments/:id/replies` | Add a reply to a comment thread |
| `PATCH` | `/api/comments/:id/replies/:replyId` | Update a reply's body |
| `DELETE` | `/api/comments/:id/replies/:replyId` | Delete a reply |
| `GET` | `/api/export?mode=fix\|report\|both` | Generate prompt string |
| `GET` | `/api/events` | Server-Sent Events stream. Sends `hello` on connect; then `comments` when `.review-comments.json` changes and `diff` when git state (HEAD / base / working tree) changes. 20 s `: ping` heartbeat. |

### Live updates

The browser UI opens an `EventSource` against `/api/events` and auto-refetches diff / comments when the server pushes an event. The server runs one shared watcher per project (1.5 s tick, cheap signature: `mtime+size` for the comments JSON and `HEAD sha + base sha + git status --porcelain` for the diff). First SSE subscriber starts the watcher; last one disconnects it. If a comment form is open and dirty, a click-to-reload banner appears instead of clobbering the draft.

---

## Data

Comments are persisted to `.review-comments.json` in the project root. Add it to `.gitignore`.

```jsonc
{
  "baseBranch": "main",
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
      "commitSha": "abc123...",
      "anchorSnippet": ["  match x {", "    A => ...", "    B => ...", "  }"],
      "replies": [
        { "id": "r1", "author": "claude", "body": "Extracted into `parseMatch()`.", "createdAt": "..." }
      ]
    }
  ]
}
```

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
