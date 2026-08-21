# Improvement records

One folder per behavioral improvement to the Virtual TA. Each record captures the
**old behavior → problem → change → verified new behavior** cycle, with the raw
session logs as evidence, so these records can inform future system design (and,
eventually, serve as training/eval data for a dedicated TA model — see
requirement 7 in the requirements doc).

## Format

Each record lives in `YYYY-MM-DD-short-slug/` and contains:

- `README.md` — the record itself:
  1. **Issue as reported** — the user's words, verbatim.
  2. **Old behavior** — the actual transcript showing the problem.
  3. **Root causes** — why the system behaved that way, per component.
  4. **Change** — what was modified, with before/after code.
  5. **Verified new behavior** — the same scenarios replayed after the fix.
  6. **Design lessons** — the generalizable rules for future agent design.
- `old-session.jsonl` (and similar) — raw log files copied from `data/logs/<run>/`
  as evidence, since `data/` is git-ignored and sessions get overwritten.

## How to create a record (instructions for an AI assistant)

This is the exact procedure used to create the first record. When the user
reports a behavioral issue, follow it end to end — the record is only complete
once the fix is *verified* and both logs are copied in.

1. **Capture the evidence before touching anything.** Find the session
   demonstrating the issue in `data/logs/*/*.jsonl` (newest run directory first; the user's
   real sessions have UUID names, test sessions have short names). Create the
   record folder `docs/improvements/YYYY-MM-DD-short-slug/` and copy the raw
   log in as `old-session.jsonl` immediately — `data/` is git-ignored and
   ephemeral, and the fix itself may generate new logs.
2. **Name every distinct failure in the transcript**, not just the one the
   user reported. Give each an ID (F1, F2, …) and a one-line description.
   (The first record's reported issue came bundled with two more failures
   visible in the same four-message transcript.)
3. **Diagnose root causes per component** — which file, which code path, and
   *why* it produced that behavior. "The router misrouted" is not a root
   cause; "the router prompt had no label covering materials meta-questions"
   is.
4. **Implement the fix** and run `npm run typecheck`. Quote before/after code
   in the record — the diff context will be lost to history otherwise.
5. **Verify each failure individually.** Restart the server (it does not
   watch-reload under the preview launcher), then hit `POST /api/chat` with
   `curl` — one fresh `sessionId` per scenario — and check both the routed
   `skill` and the reply content. Paste the actual replies into the record,
   not paraphrases.
6. **Replay the original session verbatim.** Send the user's old prompts, in
   order, in one fresh session; copy its log from `data/logs/<run>/` in as
   `new-session.jsonl`. This is the step that finds residual gaps — replies
   that made sense against the old behavior can land differently against the
   new one.
7. **Write `README.md`** with the six sections from the format above. In
   "Verified new behavior", include a turn-by-turn old-vs-new table for the
   replay. Document residual gaps honestly and mark them "candidate next
   record" — do not fix them silently or leave them out.
8. **Update the index table below** and add a link from the project
   `README.md` if this is a new kind of record.

Example prompt to trigger this procedure:

> "The TA did X wrong when I said Y — fix it and log the improvement under
> docs/improvements/ the usual way."

## Index

| Date | Record | One-line summary |
|---|---|---|
| 2026-07-07 | [coach-answer-first](2026-07-07-coach-answer-first/README.md) | Coach stonewalled questions until a reading was picked; clarify menu didn't accept its own option numbers |
