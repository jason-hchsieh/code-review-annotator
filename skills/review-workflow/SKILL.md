---
name: review-workflow
description: Read inline code review comments left by a human reviewer on specific tool calls (Edit / Write / MultiEdit / NotebookEdit), apply the requested fixes, and reply on each thread. Use when the user asks to "fix review comments", "apply review feedback", "read the review", or "address comments". Requires the code-review MCP server to be connected.
---

# Code Review Workflow

Use this skill when the user wants you to read and act on inline code review comments.

## Model

Every Edit / Write / MultiEdit / NotebookEdit you run is captured as a **tool call** with a `before` and `after` file snapshot. Reviewers comment on lines of either snapshot. A comment is anchored to `(toolCallId, side, startLine..endLine)` where `side` is either `"before"` (the file before your edit) or `"after"` (the file after your edit).

## Steps

1. **Fetch open comments**:
   ```
   get_review_comments()                      // all open comments
   get_review_comments({ toolCallId: "..." }) // comments on a single tool call
   get_review_comments({ status: "resolved" })
   ```
   Each comment includes `id`, `toolCallId`, `side`, `startLine`, `endLine`, `body`, `status`, `replies`, `toolCall` (tool/file/startedAt/status), and `sourceLines` (the actual lines the reviewer was pointing at).

2. **Understand the scope** (optional):
   ```
   get_tool_calls()                        // all captured tool calls
   get_tool_calls({ file: "src/foo.ts" })  // calls on one file
   get_tool_calls({ status: "complete" })  // pending | complete | orphan
   ```

3. **Apply fixes** — for each open comment:
   - Read `sourceLines` to see exactly what the reviewer was pointing at.
   - `side: "after"` lines may still be at the same line numbers in the current file, but not guaranteed — the file can have drifted since the edit. Use Read to confirm before editing.
   - `side: "before"` lines reference the file as it was **before** your edit ran. Usually the comment is asking you to revert or alter something you introduced.
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
- Fix all comments on one tool call's file before moving on, to minimise line-number drift.
- If you disagree with a comment, reply explaining why and leave it `open` — don't silently resolve.
- Existing `replies` on a comment may include earlier back-and-forth — read them before replying again.
- A tool call with `status: "orphan"` means the PostToolUse hook never fired (e.g. the tool errored or Claude Code was killed mid-edit). The `after` snapshot may be missing.
