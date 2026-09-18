# `plan/` — start here

Planning and status documents for the STAT 689 virtual space + virtual TA. **This file is the
entry point.** It says where the project is, what the next step is, and which of the seven other
documents answers which question, so you do not have to read 5,000 lines to find out.

**If you are Claude, picking this up fresh:** read this file, then §"Where things stand" below,
then the one document that matches the task. Do not read everything. The two large files
(`gcp-deployment-plan.md`, `app-changes.md`) are references to search, not documents to read
front to back.

---

## Where things stand

> **⚠️ This section is a dated snapshot and rots.** Everything else in this file is durable.
> Verify before acting — thirty seconds:
>
> ```
> gcloud run services describe stat689 --region=us-central1 --project=stat689 --format=json
> gcloud iap web get-iam-policy --resource-type=cloud-run --service=stat689 --region=us-central1 --project=stat689
> git log --oneline -3 && git status --short
> ```
>
> **If live state disagrees with what follows, live state is right.** Fix this section.

**As of 2026-08-23.** The app is **deployed and working**. It is not yet open to students.

- Serving `stat689-00005-5db` at <https://stat689-56ctiriivq-uc.a.run.app>, behind IAP.
- **Stage 7 verification passed in full** — all nine checks, 2026-08-23. Handout responses are
  confirmed durable across a real cold start; the salt is confirmed stable across all five
  revisions. Evidence in [`gcp-deployment-plan.md`](./gcp-deployment-plan.md) §15i.
- Branch `multi-user-and-deploy-prep` **merged to `main`** (`ab2e47b`).
- Roster is the instructor's test account only: `STUDENTS=jadewang@tamu.edu=s6`. IAP accessors
  are the instructor's two accounts. The second test account was retired.
- **The serving revision predates the E9 fix.** The next `--source=.` deploy picks it up.

### The next step

**Collect the students' Google addresses, then work through
[`go-live.md`](./go-live.md) §"Before the first real student signs in" in order.**

Two things to know before asking anyone for anything:

1. **Five student slots exist** (`s1`–`s5`); `s6` is the instructor's test account. A sixth
   student needs a new office in `server/map.ts` — a code change and a layout redesign, because
   the top band is full. If there are six students, giving up `s6` is far cheaper.
2. **`@tamu.edu` works.** Confirmed 2026-08-23 by a real IAP sign-in. Students do not need a
   personal Gmail.

The steps are ordered because two dependencies run backwards from intuition: **the bucket wipe
destroys uploaded course materials**, and **only `gcloud run deploy --source=.` rebuilds the
image** (`services update` would set the new roster against the old code). Order is
decide → wipe → deploy → upload → verify → tell them.

### Known, and shipping anyway

- **[E9](./open-issues.md#e9)** — the chat pane renders no maths, so the TA's formulas show as
  markup. The output *dialect* is fixed and guaranteed; the renderer is the missing half.
  Instructor's decision 2026-08-23: leave it, revisit by trying a different LLM.
- **13 of 34 tracked issues are open.** The ones that gate opening the site to students are
  **D5** (addresses), **D12** (class size), **D7** (pre-class bucket wipe). The rest are either
  cosmetic, or notes on gaps in evidence rather than defects.

---

## The seven documents

| File | Owns | Read it when |
|---|---|---|
| **[`go-live.md`](./go-live.md)** | The ordered runbook from "deployed" to "students are using it", plus what to tell the class | **Setting up students. This is the operational doc.** |
| [`open-issues.md`](./open-issues.md) | **Status.** What is broken or outstanding, and when each thing was resolved | Asking "is X still a problem?" — always check here first |
| [`gcp-deployment-plan.md`](./gcp-deployment-plan.md) | **Infrastructure rationale + the deploy runbook.** How the app reaches production, IAP, Cloud Run shape, rollback | Deploying, changing infra, or asking why the infra is shaped this way. §15 is the current runbook; §15i the verification checks |
| [`app-changes.md`](./app-changes.md) | **Application design decisions** — what changed in the app, why, what it cost | Asking why the *app* behaves a certain way, before changing it |
| [`handout-authoring.md`](./handout-authoring.md) | How the instructor writes a feedback handout and bundles it | Authoring a handout |
| [`gpt_student_feedback_handout_model_design.md`](./gpt_student_feedback_handout_model_design.md) | The original design goal for the feedback loop — the *why* behind handouts | Wanting the research intent rather than the implementation |
| [`go-live-brief.md`](./go-live-brief.md) | **Perishable.** A dated snapshot of deployed state, written to survive a context compaction | Rarely. It carries its own staleness warning. **Retire it once the class is running** |

### The split between the first four is deliberate

It exists because status buried in a long narrative goes stale and then misleads — which already
happened twice on this project.

- **`open-issues.md` owns status.** Tick things here.
- **`gcp-deployment-plan.md` and `app-changes.md` own rationale.** Leave their account of a
  thing alone when it gets resolved; do not restate status in them.
- **`go-live.md` owns what to do next**, operationally.

When these disagree, `open-issues.md` wins on *status* and the narrative files win on *why*.

---

## Rules that bind every file here

- **No secrets.** Not the `HANDOUT_SALT`, not API keys, not OAuth client secrets. The salt plus
  the roster is enough to invert every student hash; it lives in Secret Manager and is always
  retrievable with
  `gcloud secrets versions access latest --secret=handout-salt --project=stat689`.
- **No real student names or email addresses.** Use `<student-N>` / `<StudentNName>`. The
  instructor's own two addresses are written out; everyone else is a placeholder. The repo is
  private today, but git history outlives that decision. Real addresses go straight to `gcloud`.
- **Student data is FERPA-relevant.** Conversation logs and handout responses carry names.
  `gs://stat689-data` must stay private.
- **`HANDOUT_SALT` must never change** once responses exist. Every hash moves with it, and the
  app refuses to serve handouts rather than silently orphan the data.

---

## Where everything else is

- **Code:** `../virtual_space` (Colyseus game server + browser client, port 2567) and
  `../virtual_ta` (the TA brain, port 3000, localhost only). One container runs both;
  `../docker/start.sh` is the entrypoint.
- **Infra:** GCP project `stat689` (a **personal** Google account, not TAMU), region
  `us-central1`, service `stat689`, bucket `gs://stat689-data`.
- **The two load-bearing constraints**, before changing anything:
  `maxScale=1` is not a cost setting — Colyseus room state lives in one instance's RAM, and
  raising it splits the world in two. And Cloud Run cuts every WebSocket at **60 minutes**, so a
  class longer than an hour will see a reconnect.
