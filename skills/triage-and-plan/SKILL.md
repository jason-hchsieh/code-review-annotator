---
name: triage-and-plan
description: Read every open code review comment, group them by risk / file / theme, and present a phased fix plan for the user to approve before any edits run. Use when the review backlog is large (rough cutoff ≥ 5 open comments), when the user says "triage the review", "plan the fixes", "what's the plan for the review backlog", "group these comments", or before invoking review-workflow on a big batch. Requires the code-review MCP server to be connected. Read-only — does not edit files or call mark_resolved.
---

# Triage and plan

Use this skill before `review-workflow` when the open-comment backlog is large enough that a head-first fix loop would be reckless. The goal is to surface the *shape* of the work — risk, ordering, who needs to decide what — and get the user's go-ahead before edits start.

## When to skip

- Backlog ≤ 4 open comments → just run `review-workflow` directly. Planning overhead exceeds the win.
- User explicitly asked you to fix and not plan (e.g. "just apply the easy ones") → trust them.

## Steps

1. **Fetch the full backlog**:
   ```
   get_review_comments()                     // all open
   get_review_comments({ status: 'resolved' }) // optional context: what was already done
   get_tool_calls({ status: 'orphan' })      // optional: any captures with missing post-snapshot
   ```

2. **Bucket by axes** — for each comment, jot down:
   - **scope**: line / file / multi-file / view
   - **anchor file(s)**: which file(s) it touches
   - **risk**: low (single-line tweak, dead-code removal, doc fix) / medium (rewrite of one function or one file) / high (cross-cutting refactor, architectural call, view-scope, multi-file). View-scope and multi-file are high by default unless the body says otherwise.
   - **theme** (if obvious from body): naming, dead code, missing tests, comment cleanup, perf, type tightening, etc.

3. **Group into phases** — propose 2 to 4 phases ordered by risk and file affinity:
   - **Phase 1 — quick wins** (low-risk line-scope, often grouped by file to minimise re-reads)
   - **Phase 2 — focused refactors** (file-scope and small multi-file, one theme per batch)
   - **Phase 3 — needs decision** (view-scope, large multi-file, anything where the body says "?", "為什麼", "should we", or otherwise reads as a question rather than an instruction)

   Group line-scope comments on the same file into the same phase to avoid line-number drift between edits.

4. **Present the plan** to the user as a compact table:
   - Phase number + label
   - Comment count + comment IDs (short — first 8 chars is enough)
   - One-line per comment: `<id> <file>:<line> — <body excerpt>`
   - For Phase 3 (decisions), include your read of what the question is and the trade-off.
   - Estimated risk per phase.

5. **Stop and wait.** Ask explicitly: "Approve the plan, or want to re-shuffle? I won't touch anything until you say so." Do not call `mark_resolved`, do not edit files, do not call `reply_to_comment`. This skill is purely planning.

6. **On approval** → hand off to `review-workflow`, working through the approved phases in order. If the user asks to skip a phase or take a different order, follow that.

## Tips

- If a comment has earlier `replies` from `claude` that were never resolved, treat it as higher risk — the previous attempt may have failed verify.
- A comment whose `viewContext.toRef` is `WORKTREE` references live state — re-resolve `sourceLines` at fix time, don't trust your initial read in the planning phase.
- Don't over-engineer: if every comment is genuinely a one-line fix on the same file, one phase is fine. Say so.
- Mention in the plan if any phase will likely need verify (`cargo test`, `npm test`, etc.) so the user can budget time before approving.
