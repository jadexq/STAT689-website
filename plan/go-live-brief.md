# STAT 689 — go-live execution brief

**Status:** open · **Written:** 2026-08-23 · **Author:** Claude, for Jade Wang

> **No secrets. No real student names or email addresses.** The second test account appears
> only as `<test-2>` / `<Test2Name>`; the real address is recoverable from
> `gcloud iap web get-iam-policy`. The instructor's own addresses are written out.

**Scope:** current deployed state and the numbered actions left, as of the date above. The
durable checklist — per-student runbook, what to tell the class, what not to change — is
[`go-live.md`](./go-live.md); this file is its current-state companion and goes stale.
Deployment history is [`gcp-deployment-plan.md`](./gcp-deployment-plan.md) §15.

## Accounts
- second test account : `<test-2>` — REMOVED from the roster 2026-08-23 21:42Z, but STILL
  HOLDS an IAP grant. See item 4.
- instructor student   : jadewang@tamu.edu = slot s6, ROSTER name "Tester"
- admin                : jadexqwang@gmail.com
- salt (recoverable)   : `gcloud secrets versions access latest --secret=handout-salt --project=stat689`

## Live state, verified 21:50Z — do not re-derive, but re-check before acting
- serving `stat689-00005-5db` at 100%, url https://stat689-56ctiriivq-uc.a.run.app
- `STUDENTS=jadewang@tamu.edu=s6`, `ROSTER=jadewang@tamu.edu:Tester`, `ADMIN_EMAILS=jadexqwang@gmail.com`
- startup line: `Roster: 6 student slots — 1 assigned (Tester), 5 played by stand-ins (Sam, Ben, Chloe, Dev, Grace)`
- bucket has ONLY a fresh empty-boot snapshot (`state/current.tar.gz`, `state/daily/2026-08-23.tar.gz`).
  A pre-wipe backup was taken to the session scratchpad under `/private/tmp`, which macOS
  clears — assume it is gone. <test-2>'s four response records are gone
  deliberately — an address dropped from STUDENTS strands its records as an unresolvable hash.
- IAP accessors: JadeXQWang@gmail.com, jadewang@tamu.edu, **<test-2>** (item 4)
- revisions for rollback: 00004-ggc (<test-2> still rostered), 00003-t7c, 00002-c5j (pre-roster code)
- working tree clean at `480dce0`; 6 commits unpushed (this file makes 7)

## CORRECTIONS carried into this brief
Earlier in the session I said "80 commits unpushed". Wrong — that was `origin/main..HEAD`,
i.e. commits ahead of *main*. The branch has an upstream and is on GitHub. **Only 5 commits are
unpushed** (6 after the comment fix): 480dce0, 79a56ad, 4867703, d0fd921, 8a44d3b, 27cdf84.
The laptop-is-the-only-copy risk was overstated; the real gap is that `main` is 80 behind,
which item 5 closes.

Two more caught while double-checking this brief, both mine:
- I cited `transformer-notes.md` as "a real reading in the corpus" to justify the KaTeX change,
  **in a committed code comment** (`render.ts:22`, commit `4867703`). No such file. No reading
  has math at all. The change is still right, but pre-emptive rather than a bug fix; the comment
  is corrected and committed as `480dce0`.
- I wrote `npm run test:idle` in the first draft of item 3. No such script.
Treat unverified filenames and script names in this brief as suspect until run.

---

## 1. Push — DONE 2026-08-23 (`ca985c6..213aadb`)
Blocked twice by the auto-mode classifier, then succeeded on a later attempt with the user
present; the denial was transient, not a standing rule. Note the wizard's `--propose` output claimed "no remotes
configured": it scanned the PARENT dir `/Users/jadewang/Documents/teaching/STAT689`, which is
not a git repo. The repo and its `origin` live in `course_website/`. Anything in that proposal
resting on "no remotes" is built on a wrong premise — say so before it gets applied.

## 2. Re-upload the handout bundle (prerequisite for checks 5 and 6)
The wipe took the old one. Regenerate — it is gitignored, so not in the image:
    cd virtual_space && npm run bundle:handout fixtures/handout-sample
Produces `fixtures/handout-sample.handout.json` (~12.7 KB). Upload via the admin panel as
jadexqwang@gmail.com. Then grade at least one section as Tester so check 5 has a row.

## 3. Stage 7 checks (§15i of gcp-deployment-plan.md) — 4, 5, 6 need a signed-in browser; 9 is done
  4. **Maths renders**, not raw `$…$`. CANNOT BE TESTED VIA A READING AS THINGS STAND: the
     corpus is `agenda.md` + `attention-intro.md`, and **neither contains a single `$`**. The
     handout fixture is where the math is (`fixtures/handout-sample/sections/qkv.*.md`), so
     check 4 = open the handout as a student and look at the qkv section. To test the NEW
     reading path from `4867703`, upload a reading containing `$…$` first — worth doing once,
     since it is the only surface where a regression would reach a student before you.
  5. `/admin/handouts/sample-attention?names=1` shows **Tester**, not a bare hash.
  6. **Durability across a restart.** Let it scale to zero (~15 min idle), sign back in,
     confirm the graded record survived. The ONLY test of whether handout responses are durable.
     Cheaper than a redeploy and also exercises the SIGTERM final flush.
  9. **PASSED 2026-08-23** — idle out of the TA office lands you in your OWN office (E8).
     Running it exposed that the step-3 assertion could not prove E8 (Ana has no slot, so her
     "own room" is the commons); `59ff49d` adds step 6, which puts a *rostered* student in the
     TA office and confirms `office-s6`. That is the call site E8 fixed. Re-run with:
         SOLO_WARN_S=4 SOLO_IDLE_S=8 HOME_IDLE_S=10 npm run dev     # server, port 2567
         SOLO_IDLE_S=8 IDLE_TEST_STUDENT=jadewang@tamu.edu npx tsx scripts/idle-test.ts
     **There is no `test:idle` npm script** — virtual_space has only `build:client`, `dev`,
     `start`, `bundle:handout`. (`npm run test:materials` exists, but in **virtual_ta**.)
     Restart the space server between runs; the suite is not idempotent inside the 2-min
     reconnect window.
Check 2's visible half (office labelled with the student's name) can be folded into any of these.
I cannot drive these: the `iap-probe` service account was deleted at teardown 2026-08-22, so
there is no programmatic path through IAP. Offer Claude-in-Chrome against the user's signed-in
Chrome, or have them run it and report.

## 4. <test-2>'s IAP grant — USER'S DECISION, do not act unasked
Still granted. Leaving it lets that person sign into a space containing real students; they
would land in the Common Area (no slot) and be refused handouts, but they can see and chat.
    gcloud iap web remove-iam-policy-binding \
      --resource-type=cloud-run --service=stat689 --region=us-central1 --project=stat689 \
      --member="user:<test-2>" --role="roles/iap.httpsResourceAccessor"
Reversible either way. Decide before students arrive.

## 5. Merge to main — ONLY after Stage 7 passes
Their own Stage 8 rule. `main` is 80 behind. After checks 4/5/6/9 pass:
    git checkout main && git merge --no-ff multi-user-and-deploy-prep && git push origin main
Then tick D5b/D7/D8/D10/D11/E8 in `plan/open-issues.md`.

## 6. When the class list arrives — the mechanical pass
Runbook lives in [`go-live.md`](./go-live.md) ("Per student — do BOTH"). Not repeated here.
The two facts that decide the shape of it: **five offices are available** (s1..s5; s6 stays
with the instructor's test account), and **`--set-env-vars` REPLACES the whole set** — read the
live one first and resend everything.

## Rollback
    gcloud run services update-traffic stat689 --to-revisions=stat689-00004-ggc=100 \
      --region=us-central1 --project=stat689
Reverts code, not the bucket.
