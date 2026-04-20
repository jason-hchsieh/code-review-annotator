---
name: review-workflow
description: Read inline code review comments left by a human reviewer in the browser, then apply the requested fixes. Comments carry a scope (line / file / multi-file / view), one or more anchors (file + optional line range + blobSha + anchorText), and a viewContext saying which view the reviewer was in (tool-call / git-range / browse). Use when the user asks to "fix review comments", "apply review feedback", "read the review", or "address comments". Requires the code-review MCP server to be connected.
---

# Code Review Workflow

Use this skill when the user wants you to read and act on inline code review comments.

## Model

A comment has a **scope** that declares what it targets:

- **line** — one line range in one file. `anchors: [{ file, blobSha, startLine, endLine, anchorText }]`.
- **file** — a whole file, no line range. `anchors: [{ file, blobSha }]`. The reviewer wants a change somewhere in this file; decide where yourself.
- **multi-file** — a cross-cutting concern spanning N files (shared refactor, duplicated bug). `anchors: [{ file, blobSha }, …]` (>= 2 entries). The reviewer wants a coherent change touching all listed files; plan your edits holistically.
- **view** — review-level / architectural note. `anchors: []`. No file is pinned. Typical content: missing tests, module-level concerns, design direction. Plan before editing.

The `viewContext` on a comment is metadata describing which UI perspective the reviewer was in when writing, with three sources:

- **tool-call** — reviewer was looking at a captured `Edit` / `Write` / `MultiEdit` / `NotebookEdit`. `viewContext = { source: 'tool-call', side: 'before' | 'after', toolCallId }`.
- **git-range** — reviewer was looking at a diff between two refs (branch / SHA / `HEAD` / `INDEX` / `WORKTREE`). `viewContext = { source: 'git-range', side: 'before' | 'after', fromRef, toRef }`.
- **browse** — reviewer was looking at a worktree file directly (no diff). `viewContext = { source: 'browse', side: 'current' }`.

Anchors' `startLine` / `endLine` are 1-based file line numbers inside the referenced snapshot (before / after / worktree), not diff positions.

## Steps

1. **Fetch open comments**:
   ```
   get_review_comments()                                       // all open comments
   get_review_comments({ scope: 'line' })                      // only line-level
   get_review_comments({ scope: 'view' })                      // only architectural / review-level
   get_review_comments({ viewSource: 'tool-call' })            // only tool-call comments
   get_review_comments({ toolCallId: "..." })                  // one tool call's comments
   get_review_comments({ viewSource: 'git-range', fromRef: 'main', toRef: 'HEAD' })
   get_review_comments({ viewSource: 'browse' })
   get_review_comments({ file: "src/foo.ts" })                 // any anchor targets this file
   get_review_comments({ status: "resolved" })
   ```
   Each comment includes `id`, `scope`, `anchors[]`, `viewContext`, `body`, `status`, `replies`. For scope `line`, each anchor additionally carries `startLine` / `endLine` / `anchorText` / `sourceLines` (the lines the reviewer pointed at). Tool-call comments additionally include a compact `toolCall` summary.

2. **Understand the scope** (optional):
   ```
   get_tool_calls()                         // all captured tool calls
   get_tool_calls({ file: "src/foo.ts" })   // calls on one file
   get_tool_calls({ status: "complete" })   // pending | complete | orphan
   ```

3. **Apply fixes** — approach depends on scope:
   - **line** — Read `sourceLines` / `anchorText` to see exactly what the reviewer pointed at. `side: "after"` / `"current"` lines may still be at the same line numbers in the current file, but not guaranteed — the file can have drifted since the snapshot was taken. Use Read to confirm before editing. `side: "before"` references the file as it was before your edit ran (tool-call) or at the `fromRef` (git-range); the comment is usually asking you to revert or alter something you introduced.
   - **file** — The reviewer wants a change somewhere in this file. Read the current file, identify what the comment implies, and decide the minimal scope of the edit yourself.
   - **multi-file** — The reviewer wants a coherent change across the listed files. Read all of them first, plan the change (extract a helper? rename a symbol? fix the same bug pattern in each?), then edit.
   - **view** — No file is pinned. Plan the change: may involve creating new files, adding tests, or a larger refactor. Consider asking the user for confirmation on scope before a big change.

4. **Verify your fix before declaring it done.** Closing the "I think I fixed it" gap is the whole point — never `mark_resolved` on faith. Run the project's standard check / test / lint:
   - **Detect the command** from manifests at the project root: `package.json` scripts (`typecheck` / `test` / `lint`), `Cargo.toml` → `cargo check` + `cargo test` (+ `cargo clippy` if the repo uses it), `pyproject.toml` → `pytest` / `mypy` / `ruff`, `go.mod` → `go build ./... && go test ./...`. Check for a `Makefile`. If you can't pick one confidently, **ask the user once** ("What's the verify command for this project?") and reuse the answer for the rest of the session.
   - **Scope the run** to what you touched when possible (`cargo test -p foo`, `pytest path/to/test.py`, `npx tsc --noEmit -p tsconfig.json`). Whole-suite is fine if narrowing is unclear — don't skip because it's slow.
   - **On pass** → step 5.
   - **On failure** → `reply_to_comment` with a one-line summary plus the relevant failure snippet, **leave the comment `open`** (do **not** `mark_resolved`), and move on to other comments. The user will triage.
   - Skip verify only when the change cannot affect runtime (`.md`-only edits, removing dead comments). When in doubt, run it.

5. **Reply on the thread** explaining what you changed:
   ```
   reply_to_comment({ id: "<comment-id>", body: "Extracted into helper `fooBar()`." })
   ```
   Keep replies short.

6. **Mark resolved** after the fix is verified and replied:
   ```
   mark_resolved({ id: "<comment-id>" })
   ```

7. **Generate a summary prompt** (optional):
   ```
   get_export_prompt({ mode: "report" })
   ```

## Tips

- Line-scope `startLine` / `endLine` are **file line numbers inside the referenced snapshot** (1-based), not diff positions.
- Group comments by file and fix them together before moving on, to minimise line-number drift.
- If you disagree with a comment, reply explaining why and leave it `open` — don't silently resolve.
- Existing `replies` on a comment may include earlier back-and-forth — read them before replying again.
- A tool call with `status: "orphan"` means the PostToolUse hook never fired (e.g. the tool errored or Claude Code was killed mid-edit). The `after` snapshot may be missing.
- **Browse-view comments** (`viewContext.side: "current"`) point at a live worktree file — always Read before editing; the file may have changed since the comment was left.
- **Git-range comments** whose `fromRef` / `toRef` is `WORKTREE` or `INDEX` are re-resolved per request: `sourceLines` reflect the file as it currently is, not a frozen snapshot. Commit SHAs / branches / `HEAD` are stable points in history.
- A line-scope anchor is by blob SHA, so it follows the content. If the reviewer's original content has since been rewritten (the `blobSha` no longer matches any current side), the UI flags the comment as "migrated" — double-check `anchorText` against the current file before editing.
- For **view**-scope comments, consider whether the change genuinely needs to be made now or whether it's better tracked as a follow-up. Ask the user if the scope is large.
