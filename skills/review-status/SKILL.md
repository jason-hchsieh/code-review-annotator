---
name: review-status
description: Print a one-screen situational summary of the current code review state — open vs resolved comment counts, the files most-commented-on, recent reviewer activity, orphan tool calls, and threads where Claude has replied but the human hasn't acknowledged. Use when the user asks "what's the review status", "any open comments", "where am I in the review", "summary of the queue", "anything pending", or just wants to pick the work back up after a break. Read-only — does not edit files, reply, or resolve.
---

# Review status

Quick "where am I" snapshot. The user is either coming back to a review after a gap, or scanning whether anything new came in. Goal: one tight screen of facts, no fluff, no actions taken.

## Steps

1. **Pull the data**:
   ```
   get_review_comments({ status: 'open' })
   get_review_comments({ status: 'resolved' })
   get_tool_calls()
   ```

2. **Compute and present** in this order, all in one response:

   **Open comments** — count, then a compact list grouped by file. For each: `<id-prefix> <file>:<line> [scope] — <body excerpt, ~60 chars>`. Sort within each file by `createdAt` ascending so the conversation reads top-down.

   **Recently resolved** — last 5 resolved comments with one-line each. Skip if none in the past 7 days.

   **Tool-call activity** — total captured today + breakdown by status (`complete` / `pending` / `orphan`). Flag orphans by id (they need attention — their post-snapshot is missing).

   **Threads needing the human** — open comments whose **last reply** is from `claude`. These are waiting for the reviewer to read Claude's response and decide (resolve, push back, or close as wontfix). List the IDs explicitly.

   **View-scope open comments** — call out separately (architectural / cross-cutting). They almost always need the user's input; line-scope can usually be machine-fixed.

3. **Stop.** Don't propose a plan, don't open the UI, don't fetch blobs. If the user wants action, they'll say so — and at that point, hand off to `triage-and-plan` (≥ 5 open) or `review-workflow` (smaller).

## Format guidance

- One header per section, no decorative lines
- Counts at the top of each section
- IDs use the first 8 chars (matches what the UI shows)
- Times relative ("3h ago", "yesterday") — use absolute only if older than 7 days
- Skip empty sections silently — don't write "Recently resolved: none" if there's nothing

## Example shape (for tuning, not literal output)

```
Open comments (12)
  src/foo.rs (5):
    abc12345 src/foo.rs:42 [line] — naming: rename `tmp` to something descript…
    …
  src/bar.rs (3):
    …

Recently resolved (3, last 7d)
  def67890 src/baz.rs:120 — extracted into helper, 2h ago
  …

Tool calls today: 18 complete · 1 orphan
  ⚠ orphan: 9bc4xyzw  src/qux.rs  Edit  4h ago

Threads waiting for you (2)
  abc12345 — Claude replied 1h ago
  …

View-scope open (1)
  zzz99999 — "should we split this module?" 6h ago
```
