---
name: review-workflow
description: Read inline code review comments left by a human reviewer in the browser, then apply the requested fixes. Use when the user asks to "fix review comments", "apply review feedback", "read the review", or "address comments". Requires the code-review MCP server to be connected.
---

# Code Review Workflow

Use this skill when the user wants you to read and act on inline code review comments.

## Steps

1. **Fetch open comments** via the MCP tool:
   ```
   get_review_comments()          // current round, open only
   ```
   Each comment includes `file`, `startLine`, `endLine`, `side`, `body`, and `sourceLines`.

2. **Understand the scope**:
   ```
   get_changed_files()            // see all changed files + comment counts
   ```

3. **Apply fixes** — for each open comment:
   - Read `sourceLines` to understand the current code at that location
   - Apply the change requested in `body`
   - Use `side: "new"` line numbers to locate the code in the current working file
   - Use `side: "old"` line numbers to locate code in the pre-change version (for context only)

4. **Mark resolved** after each fix:
   ```
   mark_resolved({ id: "<comment-id>" })
   ```

5. **Generate a summary prompt** (optional):
   ```
   get_export_prompt({ mode: "report" })
   ```

## Tips

- `startLine`/`endLine` are **file line numbers** (1-based), not diff positions.
- `side: "new"` → line number in the current file on disk.
- `side: "old"` → line number in the file before changes (use `git show <baseCommit>:<file>` for context).
- Fix all comments in a file before moving to the next to minimise line-number drift.
- After all fixes, the user can open a new round in the browser: `start_new_round()` via MCP or the "New Round" button in the UI.
