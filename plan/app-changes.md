# STAT 689 — application changes

**What this file is for:** deliberate changes to the *application itself* — what we decided to
change, why, and what it cost. Written before the change and kept afterwards, because the
reasoning is the part that gets lost. "Why can't the instructor walk around as a student?" is
exactly the kind of question that gets re-litigated from scratch six months later if only the
diff survives.

**Third of three documents. The split is by question asked:**

| File | Owns | Tense |
|---|---|---|
| [`gcp-deployment-plan.md`](./gcp-deployment-plan.md) | How the app reaches production — infrastructure, IAP, the deploy runbook | mostly past |
| [`open-issues.md`](./open-issues.md) | What is broken or outstanding, and when it was resolved | present status |
| **this file** | What we are changing about the app, and why | future intent |

**Where things go, so this stays navigable:**

- Design rationale for an app change → **here**.
- Something broken, unverified, or owed → **`open-issues.md`**. That file owns status.
- Anything about GCP, IAP, deploys or quotas → **`gcp-deployment-plan.md`**.
- When a change ships: mark it shipped here with its commit, and open a tracker item there if
  it created one. Do not restate status in both places.

**Dated entries, not a narrative.** This is deliberate. The deployment plan became three layers
of correction (`open-issues.md` D4) because new material kept being stapled onto a running
story, and sections went stale in place. An append-only list of dated entries cannot rot the
same way: an old entry is *supposed* to describe how things were on that date.

> **This file is tracked in git.** No secrets, no API keys, and **no real student names or
> email addresses** — the repo is private today, but git history outlives that decision. Use
> role words ("a student", "the test account") instead.

---

## 2026-08-22 · Make the test suites order-independent (A1, A2)

**Status:** planned — awaiting review
**Tracker:** resolves `open-issues.md` A1 and A2. Status gets ticked there, not here.

### Why now, before the next batch of changes

While `multiuser` and `ghost-test` are red, every change is verified against "fails the same way
as before". That is a weak signal and it decays: a genuine regression in either suite reads as
the known failure and gets waved through. It has already cost real time once — the Phase C auth
change had to be stashed and re-run at baseline `09f5e81` purely to prove it had not broken
them. With several changes queued, that tax repeats per change. It is cheapest to fix now, with
nothing else in flight to confuse the result.

Neither is a product bug. Both are test-quality problems.

### A1 — `ghost-test.ts` asserts an absolute entity count

**Cause.** `scripts/ghost-test.ts` ends with `if (world.entities.length !== 12)`. That total has
been observed as 7, 9, 10 and 12. Humans accumulate in a long-running server because
`allowReconnection` holds a seat for `RECONNECT_WINDOW_S = 120`, so a re-run inside that window
legitimately starts with extra avatars. **Hardcoding any total is the wrong shape for this
assertion** — the number is not a property of the thing being tested.

**Fix.** Assert what the suite is actually about, and nothing else:

- exactly one avatar for the joining identity — *already present* (`Ana avatars: 1`), and this
  is the real ghost assertion
- `entities.filter(kind === "agent").length === 6` — the stable invariant, already used at
  `scripts/multiuser.ts:100` (5 virtual students + Terra)
- no two humans share a display name — closer to what "ghost" means than any count is

Remove the absolute total. Leftover humans from a recent run then cannot fail the suite, which
is correct: they are not ghosts, they are seats inside their reconnection window.

### A2 — `multiuser.ts` fails when it is not run first

**Cause, and it is not what the tracker assumed.** The tracker records this as a wait expiring.
It is not a slow reply, and the timeout is *already* 180 s. The real mechanism:

- `MainRoom.scheduleReplies` (line 287) builds its reply set from
  `agents.filter(a => ... && !a.busy)` — a busy agent is filtered out entirely
- `agentRespond` (line 297) returns early if `agent.busy`
- so a message sent to Terra while she is mid-LLM-call is **silently dropped**. This is stated
  as deliberate in the comment at `scripts/multiuser.ts:147`.

When `smoke` and `integration` have run first, Terra is still finishing their work, Ana's
message is dropped, and **no amount of waiting can succeed** — there is nothing in flight to
wait for. Raising the timeout cannot fix this, which is worth stating because it is the obvious
first thing to try.

**Fix.** Make the caller retry, which is what the product contract actually requires: send, wait
~25 s for a reply, re-send if none arrived, within the existing overall budget. Fail with a
message that distinguishes "Terra never answered across N attempts" from "Terra answered late".

**Deliberately not doing two things.** Not raising the timeout — it cannot work. Not changing
the server so that a busy agent queues or acknowledges — that is a product change, and making
one inside a test fix is how you lose track of what broke what.

### Found while diagnosing A2 — record, do not fix here

A student who messages Terra while she is busy with someone else gets **complete silence**: no
reply, no "one moment", no typing indicator. The admin path has a courtesy line for this
(`MainRoom.ts:339-341`, "(one moment — mid-conversation)") and the student path has nothing.
With five students sharing one Terra this will happen in class. To be filed as a new
`open-issues.md` entry under section E, and fixed separately.

### Verification — the definition of done A1 and A2 already state

- `smoke → integration → multiuser → ghost-test` green end to end in **one** run
- `ghost-test` green twice in a row: once against a freshly started server, once as the fourth
  suite in the sequence

### Scope

`virtual_space/scripts/` only. No server or client changes, no deploy.

### Rollback

Revert the commit; the suites return to their current red baseline.

## 2026-08-22 · The instructor is always the TA, never a student

**Status:** **shipped 2026-08-22** — `dc57bf8`, verified locally, not yet deployed
**Origin:** noticed by the instructor during Phase C browser verification

### The decision

If `identity.isAdmin` is true, the account **is** the TA: no avatar, keyboard and mouse drive
Terra, and there is no way to switch to a student view. Previously the admin role was *opt-in* —
the client asked for it with `?role=admin` and the server granted it to allowlisted instructors
only. The grant stays; the asking goes away.

### Why

- **The choice had no right answer.** The instructor is not a student on that account, so the
  student mode existed without a use.
- **The default was the wrong way round.** Joining without the parameter gave you a student
  avatar, so the *instructor* experience was the one you had to remember to request. A mode you
  can be in by accident is a mode that will be entered by accident.
- **It already cost real time.** Signed in as the instructor without the parameter, board
  posting appeared broken — the Library board could not be posted to. Nothing was broken: the
  admin panel is only rendered in admin mode, and posting is gated server-side. See the E1
  hypothesis below.
- **The usual objection does not apply here.** Normally, removing the ability to see what a
  student sees would be a real loss. But a second real Google account already exists as an
  IAP-granted student, and it is *strictly better* for that purpose — it exercises the genuine
  student auth path rather than an instructor pretending. The capability moves, it does not
  disappear.

### Plan

**Enforce server-side, not by hiding the control.** Otherwise the rule holds only while the UI
cooperates, and `?role=student` still works.

`virtual_space/server/rooms/MainRoom.ts`
- line 114 — `const isAdmin = id.isAdmin && options?.role === "admin";` becomes
  `const isAdmin = id.isAdmin;`
- lines 10-16 — the `Roles:` doc block says the role is "Requested by the client, GRANTED only
  to an allowlisted instructor". After this it derives from the allowlist alone.
- **Keep** the `isAdmin` field in the `init` payload even though it becomes redundant with
  `role`. `scripts/multiuser.ts` asserts it is `false` for an impostor, and that assertion is
  still worth making — it is the client-facing proof that asking got them nothing.

`virtual_space/client/src/main.ts` — removing a dead concept, not changing behaviour
- line 54 — drop `WANT_ROLE`
- line 693 — drop `role:` from `JOIN_OPTS` (keep `devUser`; the function is used at three join
  sites including reconnect, so it stays a single function)
- lines 553-565 — remove the role-switch wiring, keep the `role-sub` text
- lines 7-14 — the header comment documents `?role=admin`
- **No change needed** at lines 66, 568, 604, 856. They already read `role` from `init`, never
  from the URL, which is why this change is as small as it is.

`virtual_space/client/static/index.html`
- lines 128-134 — remove the `Role (testing)` row

`virtual_space/server/identity.ts`
- a comment at the `ADMINS` set recording that `ADMIN_EMAILS` now removes an avatar as well as
  granting powers

### The part that is not small — tests

`ADMIN_EMAILS` is unset locally, so `identity.ts:65` makes `DEV_USER` (`jade@local`) an admin.
Harmless today because admin must be requested; automatic after this change. Every suite that
joins as `jade@local` expecting an avatar breaks:

| File | Line | Problem | Fix |
|---|---|---|---|
| `scripts/ghost-test.ts` | 12, 25 | joins `{name:"Jade"}` → default `jade@local` → no avatar, and the suite is *entirely* about avatar replacement | join as a non-admin dev identity |
| `scripts/smoke.ts` | 42 | student leg is `jade@local` | non-admin dev identity |
| `scripts/integration.ts` | 52 | student leg is `jade@local` | non-admin dev identity |
| `scripts/multiuser.ts` | — | **no change needed.** The plan said to drop the `role` pass-through; keeping it is strictly better. The impostor still *sends* `role: "admin"` and the suite asserts the server ignores it — which tests more after this change than before | none |

The admin legs (`smoke.ts:98`, `integration.ts:67`, `multiuser.ts:123`) keep passing — sending
`role: "admin"` becomes a no-op rather than an error.

### Consequences to accept

1. **Local dev default changes.** Opening localhost with no `?as=` gives admin with no avatar
   instead of a student. Consistent with the new rule; `?as=someone@local` remains how to be a
   student locally. Flagged rather than buried because it changes the daily loop.
2. **`ADMIN_EMAILS` becomes more load-bearing.** Adding an address silently removes that
   person's avatar. Fine at one instructor; the `identity.ts` comment above exists so it is not
   a surprise if a human TA is ever added.
3. **The TA conversation session id differs between modes** — `space:admin:<email>` versus
   `space:<email>` (`MainRoom.ts:195`). Any TA history built on the instructor account while in
   student mode will not follow into admin mode.

### Verification — done 2026-08-22

`npx tsc --noEmit` clean, and no references to the removed concept remain.

| Suite | Result | Reading |
|---|---|---|
| `smoke` | **passed** | includes board compose → preview → pin to the Library |
| `integration` | **passed** | forced skills, speak-as-Terra, sealed classroom |
| `multiuser` | failed | `TIMEOUT waiting for: Terra answered Ana` — A2, identical to baseline, and it ran third |
| `ghost-test` | failed | `expected 12 entities, got 9` — A1, the stale hardcoded count. **The behaviour it exists to test passed**: `Ana avatars: 1`, so the rejoin did replace the stale avatar |

The bar was "fails the same way as before", not "green" — A1 and A2 were red before this change
and were deliberately not fixed inside it.

**Behaviour verified directly**, rather than inferred from the suites, by joining four ways:

| Join | role | avatar |
|---|---|---|
| bare, default identity (on the allowlist) | `admin` | none |
| **allowlisted account explicitly asking for `role: "student"`** | **`admin`** | **none** |
| ordinary student | `student` | yes |
| non-allowlisted account demanding `role: "admin"` | `student` | yes |

The second row is the important one: the rule is *enforced*, not merely unoffered. The fourth
confirms the pre-existing safety property survived — asking for admin still gets you nothing.

### Not in scope

E1, the instructor's derived display name, and deploying this. A deploy is a separate decision:
it costs one `--source` build and, until the cleanup policy lands, one Artifact Registry slot.

### Rollback

One line on the server. Reverting it restores the old behaviour even with the client cleanup
still in place, since an old client sending `role` is simply ignored again.

### Related — the E1 hypothesis

`open-issues.md` E1 records that the TA could not post to the Library board. The likely
explanation is that the instructor was in student mode, where the admin panel is not rendered
and `MainRoom.ts:370` refuses admin actions.

**Evidence added 2026-08-22:** the `smoke` suite's step 6 — compose, preview, pin to the
Library, then a student walks in and sees the post — **passes**. So the board path works from
admin mode. That is strong support, but it is not yet proof for E1: smoke runs locally against
the dev identity, and the instructor's report was against the deployed service. Settle it by
posting from admin mode in the cloud.
