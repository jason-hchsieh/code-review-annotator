---
name: review-workflow
description: Read inline code review comments left by a human reviewer in the browser, then apply the requested fixes. Comments are anchored to (file, line-range, blobSha, anchorText) and carry a viewContext saying which view the reviewer was in (tool-call / git-range / browse). Use when the user asks to "fix review comments", "apply review feedback", "read the review", or "address comments". Requires the code-review MCP server to be connected.
---

# Code Review Workflow

Use this skill when the user wants you to read and act on inline code review comments.

## Model

A comment's **anchor** is `(file, startLine–endLine, blobSha, anchorText)` — it identifies exactly which text the reviewer pointed at, independent of any view. The `viewContext` on a comment is metadata describing which UI perspective the reviewer was in when writing, with three sources:

- **tool-call** — reviewer was looking at a captured `Edit` / `Write` / `MultiEdit` / `NotebookEdit`. `viewContext = { source: 'tool-call', side: 'before' | 'after', toolCallId }`.
- **git-range** — reviewer was looking at a diff between two refs (branch / SHA / `HEAD` / `INDEX` / `WORKTREE`). `viewContext = { source: 'git-range', side: 'before' | 'after', fromRef, toRef }`.
- **browse** — reviewer was looking at a worktree file directly (no diff). `viewContext = { source: 'browse', side: 'current' }`.

Line numbers are 1-based file line numbers inside the referenced snapshot (before / after / worktree), not diff positions.

## Steps

1. **Fetch open comments**:
   ```
   get_review_comments()                                       // all open comments
   get_review_comments({ viewSource: 'tool-call' })            // only tool-call comments
   get_review_comments({ toolCallId: "..." })                  // one tool call's comments
   get_review_comments({ viewSource: 'git-range', fromRef: 'main', toRef: 'HEAD' })
   get_review_comments({ viewSource: 'browse' })
   get_review_comments({ file: "src/foo.ts" })                 // one file
   get_review_comments({ status: "resolved" })
   ```
   Each comment includes `id`, `file`, `startLine`, `endLine`, `viewContext`, `anchorText`, `blobSha`, `body`, `status`, `replies`, and `sourceLines` (the lines the reviewer pointed at). Tool-call comments additionally include a compact `toolCall` summary.

2. **Understand the scope** (optional):
   ```
   get_tool_calls()                         // all captured tool calls
   get_tool_calls({ file: "src/foo.ts" })   // calls on one file
   get_tool_calls({ status: "complete" })   // pending | complete | orphan
   ```

3. **Apply fixes** — for each open comment:
   - Read `sourceLines` / `anchorText` to see exactly what the reviewer was pointing at.
   - `side: "after"` / `"current"` — lines may still be at the same line numbers in the current file, but not guaranteed — the file can have drifted since the snapshot was taken. Use Read to confirm before editing.
   - `side: "before"` — references the file as it was **before** your edit ran (tool-call view) or at the `fromRef` (git-range view). The comment is usually asking you to revert or alter something you introduced; for git-range, it may be commentary on historical code.
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

- `startLine` / `endLine` are **file line numbers inside the referenced snapshot** (1-based), not diff positions.
- Group comments by file and fix them together before moving on, to minimise line-number drift.
- If you disagree with a comment, reply explaining why and leave it `open` — don't silently resolve.
- Existing `replies` on a comment may include earlier back-and-forth — read them before replying again.
- A tool call with `status: "orphan"` means the PostToolUse hook never fired (e.g. the tool errored or Claude Code was killed mid-edit). The `after` snapshot may be missing.
- **Browse-view comments** (`viewContext.side: "current"`) point at a live worktree file — always Read before editing; the file may have changed since the comment was left.
- **Git-range comments** whose `fromRef` / `toRef` is `WORKTREE` or `INDEX` are re-resolved per request: `sourceLines` reflect the file as it currently is, not a frozen snapshot. Commit SHAs / branches / `HEAD` are stable points in history.
- A comment's anchor is by blob SHA, so it follows the content. If the reviewer's original content has since been rewritten (the `blobSha` no longer matches any current side), the UI flags the comment as "migrated" — double-check `anchorText` against the current file before editing.
