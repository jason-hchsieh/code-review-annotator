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
   Each comment includes `id`, `file`, `startLine`, `endLine`, `side`, `body`, `status`, `replies`, `commitSha`, `anchorSnippet`, `sourceLines`, and `outdated`.

2. **Understand the scope**:
   ```
   get_changed_files()            // all changed files + open comment counts
   ```
   Changed files are computed relative to `merge-base(HEAD, <baseBranch>)` — the same model as a GitHub PR. The base is dynamic: new commits on HEAD or on the base branch automatically expand/adjust the diff.

3. **Apply fixes** — for each open comment:
   - Read `sourceLines` to see the current code at the anchor.
   - If `outdated` is true, the line content has changed since the comment was written — compare `sourceLines` with `anchorSnippet` to understand what the reviewer was pointing at originally. You may need to re-locate the issue or confirm with the reviewer via `reply_to_comment`.
   - Apply the change requested in `body`.
   - Use `side: "new"` line numbers to locate code in the current working file.
   - Use `side: "old"` line numbers to locate code at the merge-base (via `git show $(git merge-base HEAD <baseBranch>):<file>`).

4. **Reply on the thread** explaining what you changed:
   ```
   reply_to_comment({ id: "<comment-id>", body: "Extracted into helper `fooBar()` — no longer duplicated." })
   ```
   Keep replies short. The reviewer sees them inline in the browser.

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
- `side: "old"` → line number in the file at the merge-base.
- If `outdated` is true, always inspect `anchorSnippet` before acting — the line you see now may not be what the reviewer commented on.
- Fix all comments in a file before moving to the next to minimise line-number drift.
- If you disagree with a comment, reply explaining why instead of silently resolving. Leave `status: open` so the reviewer can respond.
- Existing `replies` on a comment may include prior human feedback — read them before replying again.
