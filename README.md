# code-review-annotator

Tool-call review for [Claude Code](https://claude.ai/code). Every `Edit` / `Write` / `MultiEdit` / `NotebookEdit` Claude Code runs is captured as a before→after snapshot, rendered in a browser UI as a timeline of cards. Leave inline comments on specific lines of either side, then let Claude Code read them via MCP and apply fixes.

```
ssh -L 8080:localhost:8080 your-server
npx code-review-annotator --port 8080
```

One HTTP server can serve multiple projects / worktrees. The plugin's MCP server self-registers into a central registry; the browser UI lists every registered project in a dropdown.

---

## Why

When Claude Code is making changes on a remote machine, you want to see each edit it made *individually* — not squashed into a single git diff — so you can comment on decisions at the moment they happen. This tool closes that loop:

1. Claude Code runs `Edit` / `Write` / `MultiEdit` / `NotebookEdit` — Pre/PostToolUse hooks capture the before and after snapshot
2. You SSH port-forward and review the timeline of tool calls in a browser UI
3. You click a card to see its before→after diff, click lines to leave inline comments
4. You tell Claude Code `"fix review comments"` — it reads comments via MCP, applies fixes, and replies on each thread
5. Resolve or push back in the browser, then iterate

There is no base branch, no merge-base. Each tool call is a standalone, frozen snapshot.

---

## Installation

### As a Claude Code Plugin (recommended)

The plugin ships `.mcp.json` and `hooks/hooks.json`, so install via Claude Code's plugin commands:

```
/plugin marketplace add /path/to/code-review-annotator
/plugin install code-review-annotator@code-review-annotator-local
```

The plugin bundles:
- An MCP server that auto-connects — no `claude mcp add` needed
- Pre/PostToolUse hooks that capture every `Edit` / `Write` / `MultiEdit` / `NotebookEdit` Claude Code runs

### Standalone (npx)

```bash
# HTTP server (multi-project — projects register via the plugin's MCP)
npx code-review-annotator --port 8080

# Or pre-seed the registry with a specific project at startup
npx code-review-annotator --dir /path/to/project --port 8080

# MCP server (for projects that aren't using the plugin)
claude mcp add code-review -- npx code-review-annotator --mcp
```

**Note:** standalone MCP mode alone does *not* capture tool calls — you also need the plugin's Pre/PostToolUse hooks (or equivalent hooks wired manually into `.claude/settings.json`) for snapshots to appear in the UI.

---

## Usage

### 1. Start the HTTP server on the remote

```bash
npx code-review-annotator --port 8080
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `8080` | HTTP server port |
| `--dir` | — | Optional in HTTP mode: if set, auto-registers this project at startup. |
| `--mcp` | — | Run as MCP stdio server instead |

Projects register themselves into `$XDG_CONFIG_HOME/code-review-annotator/projects.json` (default `~/.config/...`). The HTTP server also writes its current port into every registered project on startup, so the plugin's hook script knows where to POST snapshots. Stale entries (dir no longer exists) are filtered out of the UI automatically. The registry is safe to hand-edit.

### 2. Open the UI locally

```bash
ssh -L 8080:localhost:8080 your-server
open http://localhost:8080
```

### 3. Review and annotate

- **Timeline** sidebar — every captured tool call, newest at top. Each card shows the tool, file, relative time, status (`pending` / `orphan` badges when relevant), and open-comment count.
- Click a card to open its **before → after** diff in the main panel.
- **Click** any line to add a single-line comment. Clicking the same line again deselects.
- **Shift+Click** a second line on the same side to select a range, then add a multi-line comment.
- Comments appear as inline threads anchored to the snapshot, so they stay put even if the file continues to evolve.

### 4. Ask Claude Code to fix

```
fix review comments
```

Claude Code calls `get_review_comments`, reads the `sourceLines` for context, applies each fix, calls `reply_to_comment` to explain what changed, then calls `mark_resolved`.

---

## Tool-call lifecycle

| Status | Meaning |
|--------|---------|
| `pending` | PreToolUse captured; still waiting for PostToolUse |
| `complete` | Both hooks fired — full before and after are stored |
| `orphan` | Post never arrived within 5 min (tool errored or Claude Code was killed) |

Tool calls are paired by `tool_use_id` across Pre and Post. The HTTP server marks stale pending calls as `orphan` on every `/api/tool-calls` read.

---

## Comment lifecycle

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
| `get_tool_calls` | List captured tool-call snapshots. Filters: `file`, `status`. Returns compact records (id, tool, file, status, timestamps, line counts). |
| `get_review_comments` | Fetch comments. Defaults to `open`. Each result is enriched with `toolCall` context (tool / file / startedAt / status) and `sourceLines` — the actual lines the reviewer was pointing at. |
| `get_export_prompt` | Generate a ready-to-use fix/report/both prompt string, optionally scoped to one `toolCallId`. |
| `mark_resolved` | Mark a comment as resolved by ID. |
| `reply_to_comment` | Add a reply to a comment thread (authored as `claude`). Use after fixing to explain what changed. |

`get_review_comments` parameters:

```ts
get_review_comments(
  toolCallId?: string,           // filter to a single tool call
  status?: 'open' | 'resolved',  // default: 'open'
)
```

Line numbers are **1-based file line numbers inside the captured snapshot** — not diff positions.
- `side: "after"` → line in the file after the edit ran
- `side: "before"` → line in the file before the edit ran

---

## REST API

The HTTP server also exposes a REST API for custom integrations:

Every project-scoped endpoint takes a `project=<abs-dir>` query parameter identifying which registered project to act on. If omitted, the first registered project is used.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | `[{ id, dir, displayPath, name, httpPort, updatedAt }]` — the registry |
| `GET` | `/api/meta` | `{ dir, displayPath, name }` for the resolved project |
| `GET` | `/api/tool-calls` | All captured tool calls (filters: `file`, `status`) |
| `GET` | `/api/tool-calls/:id` | One tool call including full `before` / `after` text |
| `POST` | `/api/tool-calls/start` | **Hook endpoint** — PreToolUse: `{ toolUseId, sessionId, tool, file, before, startedAt? }` |
| `POST` | `/api/tool-calls/complete` | **Hook endpoint** — PostToolUse: `{ toolUseId, after, completedAt? }` |
| `GET` | `/api/comments` | Comments (`?toolCallId=`, `?status=` filters) |
| `POST` | `/api/comments` | Add a comment: `{ toolCallId, side, startLine, endLine?, body }` |
| `PATCH` | `/api/comments/:id` | Update body or status |
| `DELETE` | `/api/comments/:id` | Delete a comment |
| `POST` | `/api/comments/:id/replies` | Add a reply to a comment thread |
| `PATCH` | `/api/comments/:id/replies/:replyId` | Update a reply's body |
| `DELETE` | `/api/comments/:id/replies/:replyId` | Delete a reply |
| `GET` | `/api/export?mode=fix\|report\|both&toolCallId=?` | Generate prompt string |
| `GET` | `/api/events` | Server-Sent Events stream. Sends `hello` on connect; then `log` when `.review-log.json` changes. 20 s `: ping` heartbeat. |

### Live updates

The browser UI opens an `EventSource` against `/api/events` and auto-refetches the timeline when the server pushes a `log` event. The server runs one shared watcher per project (1.5 s tick, cheap signature: `.review-log.json` `mtime+size`). First SSE subscriber starts the watcher; last one disconnects it.

---

## Data

State is persisted to `.review-log.json` in the project root. Add it to `.gitignore`.

```jsonc
{
  "toolCalls": [
    {
      "id": "abc",
      "toolUseId": "toolu_01...",
      "sessionId": "sess_...",
      "tool": "Edit",
      "file": "src/parser.ts",
      "before": "...full file contents before...",
      "after":  "...full file contents after...",
      "status": "complete",
      "startedAt":   "2026-04-17T09:00:00.000Z",
      "completedAt": "2026-04-17T09:00:00.240Z"
    }
  ],
  "comments": [
    {
      "id": "c1",
      "toolCallId": "abc",
      "side": "after",
      "startLine": 42,
      "endLine": 45,
      "body": "This match block can be extracted into a helper",
      "status": "open",
      "createdAt": "2026-04-17T09:01:00.000Z",
      "replies": [
        { "id": "r1", "author": "claude", "body": "Extracted into `parseMatch()`.", "createdAt": "2026-04-17T09:05:00.000Z" }
      ]
    }
  ]
}
```

The HTTP server, MCP server, and hook scripts all read/write this file. Install the plugin so all three land together — they share state through the JSON file.

---

## Plugin Architecture

When installed as a Claude Code plugin:

- `.mcp.json` at the plugin root is auto-discovered — no manual `claude mcp add` required
- `hooks/hooks.json` registers the Pre/PostToolUse capture hooks
- `scripts/run-mcp.sh` is spawned by Claude Code at session start. On first run it copies `package.json` to `${CLAUDE_PLUGIN_DATA}` and runs `npm ci` there — keeps `node_modules` out of the plugin cache and survives plugin updates. It re-installs automatically when `package.json` changes between plugin versions.
- `scripts/hook.js` is spawned by the Pre/PostToolUse hooks. It reads the hook JSON from stdin, looks up the HTTP server's port in the shared registry, and POSTs the snapshot. Silent exit 0 on any failure (server down, no matching project) so Claude Code is never blocked.
- The `review-workflow` skill teaches Claude Code the fix loop: `get_review_comments` → apply edits → `reply_to_comment` → `mark_resolved`

---

## Tech Stack

| Concern | Choice |
|---------|--------|
| Runtime | `tsx` (TypeScript, no build step) |
| HTTP server | Node.js built-in `http` |
| MCP transport | `@modelcontextprotocol/sdk` stdio |
| IDs | `nanoid` |
| UI diffs | `diff@5.2.0` (CDN) for client-side unified diff |
| UI | Vanilla JS, single HTML file, four themes |

---

## License

MIT
