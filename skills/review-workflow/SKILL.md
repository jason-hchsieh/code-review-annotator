---
name: review-workflow
description: Read inline code review comments left by a human reviewer in the browser, then apply the requested fixes. Comments may be anchored to captured tool calls (Edit / Write / MultiEdit / NotebookEdit), to a user-defined git-range diff session, or to a worktree browse session. Use when the user asks to "fix review comments", "apply review feedback", "read the review", or "address comments". Requires the code-review MCP server to be connected.
---

# Code Review Workflow

Use this skill when the user wants you to read and act on inline code review comments.

## Model

Comments can come from three modes. Each comment carries a `target` identifying which mode it belongs to:

- **tool-call** — anchored to a captured `Edit` / `Write` / `MultiEdit` / `NotebookEdit` that you ran. `target = { kind: 'tool-call', id: toolCallId, file: '' }`. `side` is `"before"` or `"after"`.
- **git-range** — anchored to a file in a user-defined git diff session (two refs — can be branch / SHA / `HEAD` / `INDEX` / `WORKTREE`). `target = { kind: 'git-range', id: sessionId, file: 'path' }`. `side` is `"before"` or `"after"`.
- **browse** — anchored to a file in a worktree browse session (no diff). `target = { kind: 'browse', id: sessionId, file: 'path' }`. `side` is `"current"`.

Line numbers are 1-based file line numbers at the relevant snapshot (before / after / worktree), not diff positions.

## Steps

1. **Fetch open comments**:
   ```
   get_review_comments()                                       // all open comments across modes
   get_review_comments({ targetKind: 'tool-call' })            // only tool-call comments
   get_review_comments({ sessionId: "..." })                   // one git-range / browse session
   get_review_comments({ toolCallId: "..." })                  // one tool call
   get_review_comments({ file: "src/foo.ts" })                 // one file across session comments
   get_review_comments({ status: "resolved" })
   ```
   Each comment includes `id`, `target`, `side`, `startLine`, `endLine`, `body`, `status`, `replies`, `file`, and `sourceLines` (the actual lines the reviewer pointed at). Tool-call comments additionally include `toolCall` (tool/file/startedAt/status); session comments include `session`.

2. **Understand the scope** (optional):
   ```
   get_tool_calls()                         // all captured tool calls
   get_tool_calls({ file: "src/foo.ts" })   // calls on one file
   get_tool_calls({ status: "complete" })   // pending | complete | orphan
   get_review_sessions()                    // all user-defined review sessions
   ```

3. **Apply fixes** — for each open comment:
   - Read `sourceLines` to see exactly what the reviewer was pointing at.
   - `side: "after"` / `"current"` — lines may still be at the same line numbers in the current file, but not guaranteed — the file can have drifted since the snapshot was taken. Use Read to confirm before editing.
   - `side: "before"` — references the file as it was **before** your edit ran (tool-call mode) or at the from-ref (git-range mode). The comment is usually asking you to revert or alter something you introduced; for git-range, it may be commentary on historical code.
   - Apply the change.

4. **Reply on the thread** explaining what you changed:
   ```
   reply_to_comment({ id: "<comment-id>", body: "Extracted into helper `fooBar()`." })
   ```
   Keep replies short.

5. **Mark resolved** after the fix and reply:
   ```
   mark_resolved({ id: "<comment-id>" })
   ```

6. **Generate a summary prompt** (optional):
   ```
   get_export_prompt({ mode: "report" })
   ```

## Tips

- `startLine` / `endLine` are **file line numbers inside the captured snapshot** (1-based), not diff positions.
- Group comments by file and fix them together before moving on, to minimise line-number drift.
- If you disagree with a comment, reply explaining why and leave it `open` — don't silently resolve.
- Existing `replies` on a comment may include earlier back-and-forth — read them before replying again.
- A tool call with `status: "orphan"` means the PostToolUse hook never fired (e.g. the tool errored or Claude Code was killed mid-edit). The `after` snapshot may be missing.
- **Browse mode** (`side: "current"`) points at a live worktree file — always Read before editing; the file may have changed since the comment was left.
- **Git-range mode** with a from/to of `WORKTREE` or `INDEX` is re-resolved per request: `sourceLines` reflect the file as it currently is, not a frozen snapshot. Commit SHAs (or branches/`HEAD`) are frozen at session creation.
- A git-range session whose from-ref and to-ref have no ancestor relationship still produces a diff, but the reviewer was warned — treat comments as advisory, not as a strict merge target.
