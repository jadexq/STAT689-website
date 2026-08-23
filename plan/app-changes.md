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

## 2026-08-22 · The instructor is always the TA, never a student

**Status:** planned — reviewed and approved 2026-08-22, not yet implemented
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
| `scripts/multiuser.ts` | 64-66 | the `role` argument to `join()` becomes meaningless | keep the signature so the impostor case still reads as a claim being refused; drop the pass-through |

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

### Verification

Local only. No redeploy, so no Artifact Registry cost.

- `npx tsc --noEmit`
- the four suites against a freshly started server

**The baseline is already red**, which matters for reading the result: `open-issues.md` A1
(`ghost-test` stale count) and A2 (`multiuser` order dependence) fail today. The bar is
"fails the same way as before", not "green". A1 and A2 are deliberately **not** fixed as part
of this — fixing tests inside a behaviour change is how you lose track of what broke what.

### Not in scope

E1, the instructor's derived display name, and deploying this. A deploy is a separate decision:
it costs one `--source` build and, until the cleanup policy lands, one Artifact Registry slot.

### Rollback

One line on the server. Reverting it restores the old behaviour even with the client cleanup
still in place, since an old client sending `role` is simply ignored again.

### Related — the E1 hypothesis

`open-issues.md` E1 records that the TA could not post to the Library board. The likely
explanation is that the instructor was in student mode, where the admin panel is not rendered
and `MainRoom.ts:370` refuses admin actions. **This is a hypothesis, not a finding** — it is
cheap to settle by trying a board post from admin mode before anyone debugs code.
