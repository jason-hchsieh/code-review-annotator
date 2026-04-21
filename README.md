# code-review-annotator

Tool-call review for [Claude Code](https://claude.ai/code). Every `Edit` / `Write` / `MultiEdit` / `NotebookEdit` Claude Code runs is captured as a before→after snapshot, rendered in a browser UI as a timeline of cards. Leave inline comments on specific lines of either side, then let Claude Code read them via MCP and apply fixes.

Beyond the tool-call timeline, you can also create ad-hoc **git diff** review sessions (compare any two refs — branch / HEAD / SHA / `INDEX` / `WORKTREE`) and **browse** sessions (annotate any file in the worktree, no diff). Comments made in each mode are kept independent of one another.

Comments support four **scopes**: `line` (a specific line range), `file` (a whole file), `multi-file` (cross-cutting change across N files), and `view` (review-level / architectural note).

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

The header has a three-way **mode switcher**:

- **Tool calls** — the default live timeline. Each captured `Edit` / `Write` / `MultiEdit` / `NotebookEdit` is a card. Click one to open its before→after diff. Newest at top. Status badges: `pending` / `orphan`.
- **Git diff** — user-created sessions that compare any two refs. Pick from branches / commits / `HEAD` / `INDEX` (staged) / `WORKTREE` (current files incl. untracked), or paste a SHA. A warning appears if the two refs have no ancestor relationship — that case is outside this tool's design but still renders `A..B`. Each session is saved; switch between sessions via the sidebar dropdown.
- **Browse** — a user-created session that lists every worktree file (tracked + untracked, respecting `.gitignore`). No diff; pick a file, leave comments on any line.

In any mode:
- **Click** any line to add a line-scope comment. Clicking the same line again deselects.
- **Shift+Click** a second line on the same side to select a range.
- **+ Comment ▾** button in the file header opens a menu for `file` / `multi-file` / `view` scopes. Multi-file activates sidebar multi-select so you can pick the N files with checkboxes before writing the comment.
- Comments anchor by `(file, line-range, blobSha, anchorText)` — independent of the view. The `viewContext` records which perspective the reviewer was in when writing.

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
| `get_review_comments` | Fetch comments. Filters: `toolCallId`, `viewSource`, `fromRef`, `toRef`, `file`, `scope`, `status` (defaults to `open`). Each result carries `scope` (`line` / `file` / `multi-file` / `view`), `anchors[]` (each with `file`, `blobSha` and — for `line` scope — `startLine`, `endLine`, `anchorText`, `sourceLines`), `viewContext`, and (for `viewContext.source='tool-call'`) a compact `toolCall` summary. Comment / reply `body` fields are GitHub-flavored Markdown. |
| `get_export_prompt` | Generate a fix / report / both prompt string grouped by scope. Filters: `toolCallId`, `viewSource`, `fromRef`, `toRef`, `scope`, `mode`. |
| `mark_resolved` | Mark a comment as resolved by ID. |
| `reply_to_comment` | Add a reply to a comment thread (authored as `claude`). Use after fixing to explain what changed. Body is rendered as GitHub-flavored Markdown — fenced code blocks with a language tag get syntax-highlighted in the browser. |

`get_review_comments` parameters:

```ts
get_review_comments(
  toolCallId?: string,                       // filter to a single tool-call's comments
  viewSource?: 'tool-call' | 'git-range' | 'browse',
  fromRef?:    string,                       // match viewContext.fromRef (git-range only)
  toRef?:      string,                       // match viewContext.toRef (git-range only)
  file?:       string,                       // matches if any anchor targets this file
  scope?:      'line' | 'file' | 'multi-file' | 'view',
  status?:     'open' | 'resolved',          // default: 'open'
)
```

Line numbers on line-scope anchors are **1-based file line numbers inside the referenced content** — not diff positions. `viewContext.side` on the comment says which snapshot the reviewer was looking at:
- `side: "after"` → line in the file after the edit ran / at the to-ref
- `side: "before"` → line in the file before the edit ran / at the from-ref
- `side: "current"` → line in the worktree file (browse mode)

---

## REST API

The HTTP server also exposes a REST API for custom integrations:

Every project-scoped endpoint takes a `project=<abs-dir>` query parameter identifying which registered project to act on. If omitted, the first registered project is used.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | `[{ id, dir, displayPath, name, httpPort, updatedAt }]` — the registry |
| `GET` | `/api/meta` | `{ dir, displayPath, name, isGitRepo }` for the resolved project |
| `GET` | `/api/tool-calls` | All captured tool calls (filters: `file`, `status`) |
| `GET` | `/api/tool-calls/:id` | One tool call including full `before` / `after` text |
| `POST` | `/api/tool-calls/start` | **Hook endpoint** — PreToolUse: `{ toolUseId, sessionId, tool, file, before, startedAt? }` |
| `POST` | `/api/tool-calls/complete` | **Hook endpoint** — PostToolUse: `{ toolUseId, after, completedAt? }` |
| `GET` | `/api/git/refs` | `{ isGitRepo, refs[] }` — branches + recent commits + special refs (`WORKTREE`, `INDEX`). |
| `GET` | `/api/git/graph?limit=80` | `{ isGitRepo, commits[], headSha, headRef }` — commit topology across all branches for the visual range picker. Each commit has `{ sha, parents, author, date, subject, refs, isHead }`. |
| `POST` | `/api/git/check-ancestor` | `{ fromRef, toRef }` → `{ ancestor: boolean \| null, mergeBase: sha \| null }`. `ancestor: null` means one side is `WORKTREE`/`INDEX`. |
| `GET` | `/api/view/files?view=browse` | `[{ file, status }]` — all worktree files. |
| `GET` | `/api/view/files?view=git-range&from=&to=` | `[{ file, status }]` — changed files between refs. |
| `GET` | `/api/view/file?view=browse&path=` | `{ file, before:'', after, beforeSha:'', afterSha, isBrowse:true }` — worktree file contents. |
| `GET` | `/api/view/file?view=git-range&from=&to=&path=` | `{ file, before, after, beforeSha, afterSha, isBrowse:false }` — resolved blobs at each ref. |
| `GET` | `/api/comments` | Comments (filters: `toolCallId`, `view`, `from`, `to`, `file`, `scope`, `status`) |
| `POST` | `/api/comments` | Add a comment. Preferred shape: `{ scope: 'line'\|'file'\|'multi-file'\|'view', anchors: Anchor[], viewContext: { source, side, toolCallId?, fromRef?, toRef? }, body }` where `Anchor = { file, blobSha, startLine?, endLine?, anchorText? }`. `scope='view'` requires 0 anchors, `line`/`file` exactly 1, `multi-file` >= 2. Convenience shape for tool-call line comments: `{ toolCallId, side, startLine, endLine?, body }`. |
| `PATCH` | `/api/comments/:id` | Update body or status |
| `DELETE` | `/api/comments/:id` | Delete a comment |
| `POST` | `/api/comments/:id/replies` | Add a reply to a comment thread |
| `PATCH` | `/api/comments/:id/replies/:replyId` | Update a reply's body |
| `DELETE` | `/api/comments/:id/replies/:replyId` | Delete a reply |
| `GET` | `/api/export?mode=fix\|report\|both&toolCallId=?&view=?&from=?&to=?&scope=?` | Generate prompt string (grouped by scope) |
| `GET` | `/api/events` | Server-Sent Events stream. Sends `hello` on connect; `log` when `.review-log.json` changes; `worktree` when the git state (HEAD / index / tracked or untracked worktree files) changes. 20 s `: ping` heartbeat. |

### Live updates

The browser UI opens an `EventSource` against `/api/events` and auto-refetches when the server pushes an event. The server runs one shared watcher per project (1.5 s tick). First SSE subscriber starts the watcher; last one disconnects it. Two event types:

- `log` — `.review-log.json` `mtime+size` changed. Comments / replies / tool-call snapshots may have moved; the client refetches the full payload.
- `worktree` — the git state changed. The signature folds `.git/HEAD` mtime, `.git/index` mtime, `git status --porcelain` output, and the mtimes of every file that status lists, so it catches commits, staging, branch switches, and repeated edits to an already-modified file. The client only refreshes the file list + the currently-open file's content (Browse / Git-diff modes), not comments.

---

## Data

State is split across two sibling paths in the project root. Add both to `.gitignore`.

- `.review-log.json` — thin metadata: tool-call entries (ids, files, SHAs, timestamps), comments, replies.
- `.review-log-blobs/<sha>` — content-addressed blob store. Each unique `before` / `after` file content is written once, keyed by its git blob SHA. Consecutive edits to the same file naturally dedupe (one blob shared by N tool calls).

```jsonc
{
  "toolCalls": [
    {
      "id": "abc",
      "toolUseId": "toolu_01...",
      "sessionId": "sess_...",
      "tool": "Edit",
      "file": "src/parser.ts",
      "beforeSha": "1a2b3c…",      // git hash-object of before — content stored at .review-log-blobs/1a2b3c…
      "afterSha":  "4d5e6f…",      // git hash-object of after  — content stored at .review-log-blobs/4d5e6f…
      "status": "complete",
      "startedAt":   "2026-04-17T09:00:00.000Z",
      "completedAt": "2026-04-17T09:00:00.240Z"
    }
  ],
  "comments": [
    {
      "id": "c1",
      "scope": "line",
      "anchors": [
        {
          "file":       "src/parser.ts",
          "blobSha":    "4d5e6f…",     // git hash-object of file contents when the comment was written
          "startLine":  42,
          "endLine":    45,
          "anchorText": "function foo() {\n  …\n}"  // verbatim text at the anchor (fuzzy-relocate fallback)
        }
      ],
      "viewContext": {
        "source":     "tool-call",
        "side":       "after",
        "toolCallId": "abc"
      },
      "body": "This match block can be extracted into a helper",
      "status": "open",
      "createdAt": "2026-04-17T09:01:00.000Z",
      "replies": []
    },
    {
      "id": "c2",
      "scope": "multi-file",
      "anchors": [
        { "file": "src/parser.ts", "blobSha": "7e8f…" },
        { "file": "src/lexer.ts",  "blobSha": "9a0b…" }
      ],
      "viewContext": {
        "source":  "git-range",
        "side":    "after",
        "fromRef": "main",
        "toRef":   "HEAD"
      },
      "body": "These two files share token-table logic that should be factored out.",
      "status": "open",
      "createdAt": "2026-04-17T10:10:00.000Z",
      "replies": []
    },
    {
      "id": "c3",
      "scope": "view",
      "anchors": [],
      "viewContext": { "source": "browse", "side": "current" },
      "body": "No tests cover the error-path branches. Add them before merging.",
      "status": "open",
      "createdAt": "2026-04-17T10:15:00.000Z",
      "replies": []
    }
  ]
}
```

Pre-v0.19 logs (comments with flat `{ file, startLine, endLine, blobSha, anchorText }` shape) are migrated to the new `scope` + `anchors[]` shape on load, and the file is rewritten on next save.

The HTTP server, MCP server, and hook scripts all read/write this file. Install the plugin so all three land together — they share state through the JSON file.

---

## Restart after upgrading

`.review-log.json` is read once into memory by every long-lived process (the MCP stdio server most importantly) and only re-loaded when its `mtime+size` signature changes (`syncFromDisk`, added in v0.21.1). **A long-lived process running an older build does not have that re-sync** — its in-memory snapshot is frozen at the moment it started, and any write it makes will overwrite whatever's currently on disk with that frozen state. After upgrading the annotator (or any time you've changed `src/log.ts`), kill any MCP/HTTP server processes started against the old code:

```bash
pgrep -af 'tsx.*code-review-annotator.*--mcp'
# kill the PIDs that aren't from the current install
```

v0.24.1 added a defensive guard in `LogStore.save()` that aborts (`console.error` + throw) if the on-disk signature changed since the last sync — so a stale current-version process now fails loudly instead of silently clobbering data. Older processes do not have this guard; restart them.

---

## Plugin Architecture

When installed as a Claude Code plugin:

- `.mcp.json` at the plugin root is auto-discovered — no manual `claude mcp add` required
- `hooks/hooks.json` registers the Pre/PostToolUse capture hooks
- `scripts/run-mcp.sh` is spawned by Claude Code at session start. On first run it copies `package.json` to `${CLAUDE_PLUGIN_DATA}` and runs `npm ci` there — keeps `node_modules` out of the plugin cache and survives plugin updates. It re-installs automatically when `package.json` changes between plugin versions.
- `scripts/hook.js` is spawned by the Pre/PostToolUse hooks. It reads the hook JSON from stdin, looks up the HTTP server's port in the shared registry, and POSTs the snapshot. Silent exit 0 on any failure (server down, no matching project) so Claude Code is never blocked.
- Three Claude Code skills cover the review loop end-to-end:
  - `review-workflow` — the fix loop: `get_review_comments` → apply edits → run the project's verify command (typecheck / test / lint) → `reply_to_comment` → `mark_resolved` (or, on verify failure, reply with the failure and leave the comment open)
  - `triage-and-plan` — read-only planner for large backlogs (≥ 5 open). Buckets comments by scope / risk / theme and proposes a phased plan; waits for approval before any edits
  - `review-status` — read-only one-screen summary: open vs resolved counts, hottest files, orphan tool calls, threads waiting for the human, view-scope items needing a decision

---

## Tech Stack

| Concern | Choice |
|---------|--------|
| Runtime | `tsx` (TypeScript, no build step) |
| HTTP server | Node.js built-in `http` |
| MCP transport | `@modelcontextprotocol/sdk` stdio |
| IDs | `nanoid` |
| UI diffs | `diff@5.2.0` (CDN) for client-side unified diff |
| Comment markdown | `marked@4.3.0` + `dompurify@3.0.11` + `highlight.js@11.10.0` (CDN) — comment & reply bodies render as GitHub-flavored Markdown with code-block syntax highlighting |
| UI | Vanilla JS, single HTML file, four themes |

---

## License

MIT
