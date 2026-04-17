---
name: review-workflow
description: Read inline code review comments left by a human reviewer in the browser, then apply the requested fixes and reply on each thread. Use when the user asks to "fix review comments", "apply review feedback", "read the review", or "address comments". Requires the code-review MCP server to be connected.
---

# Code Review Workflow

Use this skill when the user wants you to read and act on inline code review comments.

## Steps

1. **Fetch open comments** via the MCP tool:
   ```
   get_review_comments()          // open comments across all files
   get_review_comments({ file: "src/foo.ts" })
   get_review_comments({ status: "resolved" })
   ```
   Each comment includes `id`, `file`, `startLine`, `endLine`, `side`, `body`, `status`, `replies`, and `sourceLines`.

2. **Understand the scope**:
   ```
   get_changed_files()            // all changed files + open comment counts
   ```

3. **Apply fixes** — for each open comment:
   - Read `sourceLines` to understand the current code at that location
   - Apply the change requested in `body`
   - Use `side: "new"` line numbers to locate the code in the current working file
   - Use `side: "old"` line numbers to locate code in the pre-change version (for context only)

4. **Reply on the thread** explaining what you changed:
   ```
   reply_to_comment({ id: "<comment-id>", body: "Extracted into helper `fooBar()` — no longer duplicated." })
   ```
   Keep replies short (one or two sentences). The reviewer sees replies inline in the browser.

5. **Mark resolved** after the fix and reply:
   ```
   mark_resolved({ id: "<comment-id>" })
   ```

6. **Generate a summary prompt** (optional):
   ```
   get_export_prompt({ mode: "report" })
   ```

## Tips

- `startLine`/`endLine` are **file line numbers** (1-based), not diff positions.
- `side: "new"` → line number in the current file on disk.
- `side: "old"` → line number in the file before changes (use `git show <baseCommit>:<file>` for context).
- Fix all comments in a file before moving to the next to minimise line-number drift.
- If you disagree with a comment, reply explaining why instead of silently resolving. Leave `status: open` so the reviewer can respond.
- Existing `replies` on a comment may include prior human feedback — read them before replying again.
