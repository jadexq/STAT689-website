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

## 2026-08-22 · Simplify the TA: one room, one mode, one job

**Status:** **shipped 2026-08-22**, verified locally. Six commits, `6d241cc`..`3ee84f6`.
**Not deployed** — the running revision still serves the pre-change app.
**Supersedes:** the room-as-mode-selector design (`map.ts` `forcedSkill`) and the
LLM-composed board post (`admin` action `compose`).

### What the instructor asked for

1. The TA is displayed as **"TA"**, not "Terra".
2. The TA **never leaves the TA office**.
3. Students must **walk into the office** to talk; consider auto-returning an idle student.
4. **One student at a time** — the door closes while the office is occupied.

Plus two simplifications decided during review:

5. The TA has **one job**: answer questions grounded in course material, either searching the
   collection or focusing on a document the student names.
6. Board posts are **written by the instructor directly**, not composed by the model.

### The collisions this had to resolve first

**The instructor *is* the TA.** Since `MainRoom.focusEntity`, an admin has no avatar and their
keys drive the TA. "The TA never moves" therefore also means "the instructor never moves".
Decision: **hard lock, nobody moves them.** The rule is only worth having if it is true — a soft
version leaves students able to bump into the TA in the commons, which un-does requirements 3
and 4. Accepted cost: no more walking the TA into a student's office to speak as them.

**The bottom rooms *were* the mode switch.** `forcedSkillAt()` maps Prep Room → `author`,
Library → `announce`, Computer Lab → `review`. A TA pinned to their office is never in any of
them, so that mechanism goes dark on the same day. Rather than replace it with a dropdown, the
instructor chose to collapse the modes instead — see below. This is the better outcome: a
dropdown would have preserved four modes nobody asked for.

### Mode collapse: five skills → one

| Skill | Today | After |
|---|---|---|
| `coach` | default fallback; `/coach` | **the only mode** |
| `author` | `/notes`, `/slides`, Prep Room | dormant |
| `review` | `/review`, PR link, Computer Lab | dormant |
| `announce` | `/announce`, Library | dormant — replaced by typing the post |
| `classroom` | already disabled | unchanged |

**Dormant, not deleted** — the same pattern `classroom` already uses (`CLASSROOM_ENABLED`). The
code stays, the routing does not. Reversible in one flag, and deleting working code to express a
scope decision is how you lose it.

**The router disappears with them.** `route()` exists to choose among skills; with one skill
there is nothing to choose. `taChat` forces `coach` and the classification call is skipped —
**one fewer LLM round trip on every single student message**, plus its latency and tokens. This
is the largest performance win in the batch and it falls out of the simplification for free.

### Requirement 5 — grounding in course material

Today: `materials/manifest.json` lists readings; `matchReading()` matches one by title words;
`loadReading()` puts up to 28,000 characters of it into the prompt. One reading at a time, named
by the student. That covers "ask about a certain document" and nothing else.

What is missing is search. **Recommendation: keyword retrieval over chunks, no new
dependencies.** Split each document into ~1,500-character chunks at startup, score them against
the question (title match weighted above body match), and put the best handful in the prompt.

Deliberately *not* embeddings yet. `materials.ts:4` already nominates vector retrieval as "the
later upgrade", and it is — but it needs an embedding provider, a store, and a rebuild step, and
the collection is currently **one file**. Keyword-over-chunks is a few dozen lines and no infra.
Revisit past roughly twenty documents.

Chunking earns its keep regardless of retrieval quality: loading two or three whole documents at
28k characters each would blow out prompt cost and latency, so *something* has to select
sub-document context the moment there is more than one reading.

**Posture — decided: answer directly.** `coach` was deliberately Socratic ("do NOT hand over
full answers"), which conflicts with request 5. The instructor chose direct answers grounded in
the material, citing which document each claim came from. The Socratic framing goes; the skill
keeps its name and its per-reading question digest.

The skill name `coach` now under-describes it, but renaming it would churn the session store
(`session.mode` is persisted and restored from logged turns). Left alone deliberately.

### Requirement 6 — posting to the board

`admin` action `post` already accepts raw text and pins it; only `compose` calls the model. So
this is mostly deletion: remove `compose`, and the existing preview textarea becomes a plain
write-and-post form.

Rejected: an HTTP endpoint driven by `curl`. It sits behind IAP, so every call needs the
identity-token minting from `open-issues.md` B1 — real cost, no gain over a textarea. A
git-tracked seed file read at startup remains a reasonable *later* option for material decided
before the semester, but it costs a redeploy per edit, so it cannot be the main path.

**This probably closes E1** ("the TA cannot post to the Library board"). Under the old design,
posting meant composing through the announce skill; the local evidence said that path worked, so
"wrong mode, not a defect" was the leading explanation. A form with no mode cannot be in the
wrong mode.

### Requirement 4 — the door

Single occupancy on `office-ta`, counting humans only. The TA lives there and never counts.

Enforcement has to happen in three places, because occupancy changes while people are walking:

- `handleStep` — refuse a step onto the door tile or into the room when it is taken.
- `handleGoto` — path with the door tile blocked, so BFS refuses rather than routing through it.
- inside `walk()` — re-check each step; someone may have claimed the room mid-walk.

Client gets a new `notice` message (rendered as a system line, like the "under construction"
one) and draws the door closed. Occupancy is broadcast **only when it changes**, not per move —
`MainRoom.ts:522` documents why per-move full-state broadcasts were the dominant egress cost.

**This also addresses E2.** A student messaging a busy TA currently gets silence, because the TA
serialises on a `busy` flag. The door makes that queue visible and fair: you are told the office
is occupied at the threshold instead of having your message vanish.

### Requirement 3 — idle auto-return

Recommended: **yes, and it is not optional.** Without it requirement 4 is a lockout bug — a
student who walks in and closes their laptop holds the only door shut indefinitely.

- Warn at 4 minutes, walk them home at 5. Reuses the existing `walk` and `findPath`.
- **Free the door immediately on disconnect**, before `allowReconnection` is awaited. Otherwise
  a dropped socket holds the office for the full `RECONNECT_WINDOW_S = 120`.
- Roughly 30 lines.

Note the throughput this implies: one student at a time, so five students is a queue. That
constraint already existed invisibly (the `busy` flag); this makes it explicit. If it bites,
the lever is the idle timeout, not the door.

### What shipped

| Commit | What |
|---|---|
| `6d241cc` | Rename Terra → TA: display name, persona, `agent-ta`, `TA_ID`, pronouns |
| `7845269` | TA immovable for everyone; modes collapsed to one; router short-circuited; board posts typed; Prep Room sealed |
| `260c578` | Single occupancy on the TA office, enforced in three places; door freed on disconnect |
| `82fff27` | Idle warn at 4 min, walk home at 5, windows env-tunable |
| `ea9bb22` | Render the TA's bold/code/links in the chat bubble instead of showing the markers |
| `3ee84f6` | Chunked keyword retrieval over the materials; sources reported as a chip |
| `cf8bdb4` | The TA office is 1:1 including agents — see the first addendum below |
| `3788935` | Six student characters, one office each; `send` removed; `.env` load order — see the second addendum |

**Two of those were not in the plan.** Both were found by watching the thing work rather than by
reasoning about it, which is the argument for running it before calling it done:

- `ea9bb22` — the TA brain writes light markdown and the space showed it raw. Tolerable while the
  TA was one feature among several; unmissable once talking to them is the whole application.
- The sources chip in `3ee84f6` — the first grounded answers did not name their source despite
  the prompt asking them to, and arrived as bulleted essays. The prompt was tightened, but the
  citation moved to something the server reports rather than something the model must remember.
  **A citation the model has to write is a citation it will sometimes skip.**

### The part that is not small — tests

Three of four suites move the TA around, so they encode exactly the behaviour being removed:

| Suite | What breaks | Becomes |
|---|---|---|
| `smoke.ts` | step 4 sends the TA to the commons; step 5 chats there | student walks *in*; chat happens in the office |
| `integration.ts` | step 2 drives the TA by arrow key; step 6 walks both to the lab; step 7 speaks as the TA in Sam's office | step 2 asserts the TA **cannot** be moved; steps 6–7 rewritten or dropped |
| `multiuser.ts` | the whole TA-placement block added for A2 | deleted — a fixed TA is what that block was faking |
| `ghost-test.ts` | agent-count assertion only | unaffected beyond the id rename |

New coverage owed: door refuses a second student, door reopens on exit, idle student is returned,
disconnect frees the door immediately.

**A2 dissolves rather than being fixed.** That failure existed because the TA's position
persisted across suites and nothing sent them home. A TA that cannot move has no position to
persist. The placement block added in `7eedc2a` becomes dead weight the day this ships.

### Consequences to accept

- No walking the TA into a student's office to speak as them. The five virtual students can
  still be dispatched and directed anywhere.
- The admin camera no longer follows anything; manual pan and the minimap still work.
- **Prep Room is sealed**, using the same flag the Classroom already uses — it existed only to
  put the TA in `author` mode. **Computer Lab stays open**: its board survives the change, and
  a room students can walk into and read is still worth having.
- Students can no longer reach `author` / `review` / `announce` by slash command.

### Decisions taken 2026-08-22

1. **Posture** — direct grounded answers with citations, not Socratic.
2. **Timeout** — in scope; 4-minute warning, 5-minute return, as proposed.
3. **Empty rooms** — seal the Prep Room; leave the Computer Lab open.

### Addendum, same day — six students, six rooms

The instructor tested as a student and found every human spawning in "Jade's Office" —
`MainRoom.onJoin` had one hard-coded home for all humans. Since the role change that room is
named after someone who can no longer be in it, and the idle timer would have returned five
students to the same tile.

**The decision: six student characters, one office each.** Five keep the existing names as
placeholders; the sixth is the instructor's test account.

| Slot | Office | Today |
|---|---|---|
| `s1`–`s5` | Sam's, Ben's, Chloe's, Dev's, Grace's | AI stand-ins |
| `jade` | Jade's Office | the instructor's test student account |

**A slot is a character, not a person.** That distinction is the whole design: when a real
student's address is assigned to `s1`, they do not arrive *alongside* Sam — they take Sam over,
same office, same name, until a real name is known. That is why the five names are placeholders
rather than decoration, and it is why assigning an address removes the stand-in.

Addresses live in the environment (`STUDENTS="addr=s1,…"`), never in `roster.ts`. The file is
tracked in git and student addresses are not ours to publish. The server refuses to start on a
slot assigned twice or an unknown slot id — the same fail-fast reasoning as the IAP audience
check, because "two students share an office" is a discovery nobody should make in class.

**An unassigned address still gets in**, but lands in the Common Area with a warning logged.
Refusing a student at class time over a config gap is the wrong failure; putting them in
somebody else's office is the failure we just fixed.

**Nothing moves any more except humans.** The `send` action is gone entirely, for every
character. Directing a stand-in to *speak* still works — it speaks where it lives. This retires
the persistent-position bug class rather than narrowing it again; the previous addendum narrowed
it and it fired within the day.

**Two idle rules, deliberately different:**

| Where | Activity that counts | Window | Why |
|---|---|---|---|
| TA office | speaking only | warn 4 min, out at 5 | a shared resource — someone silent in there is blocking the queue |
| anywhere else | any operation | 10 min | nobody is harmed by loitering in the hall; this is the world tidying itself |

Both return the student to **their own** office.

**Found on the way: `.env` was being ignored.** `dotenv.config()` sat partway down `index.ts`,
but ES imports are hoisted — every module reading `process.env` at module scope had already been
evaluated. The roster reported zero assigned students while `.env` plainly assigned one. Now
`server/env.ts` is the first import. Nothing in the cloud depended on it (Cloud Run sets real
environment variables), which is exactly why it could sit there unnoticed: it only ever broke
local development, where it looks like your config is being ignored rather than unread.

### Addendum, same day — the TA office is 1:1 including agents

The instructor tested as a student and a virtual student joined the conversation. Cause and fix
in `open-issues.md` E5; the design point belongs here.

**Solo occupancy counts humans only, deliberately** — the TA lives in the room and must not block
themself. That exemption silently covered the other five agents too. "One student at a time" was
therefore only true of *humans*, which is not what the words mean to anyone reading them.

So the room is now 1:1 in the sense a person would expect: one student, the TA, nobody else.
Enforced twice on purpose — agents are refused the destination, *and* excluded from replying
there — because a rule with one gate gets walked around the first time some other path places an
agent in the room.

The general lesson is about the fix, not the bug: making the TA immovable did not retire the
persistent-position problem, it narrowed it to the five agents that can still move. A narrowed
problem still fires, and this one fired within a day, from the test written to verify the change
that narrowed it.

### Verification — done 2026-08-22

All four suites green, twice, plus two new ones:

| Suite | Covers |
|---|---|
| `smoke` | TA refuses to be walked; a virtual student still can be; student walks in and is answered; typed post reaches the board verbatim |
| `integration` | Both movement paths refused (keyboard *and* panel); Classroom and Prep Room sealed; the TA does not answer from another room; speak-as-TA heard in the office |
| `multiuser` | Door shut behind the first student, naming who is inside; reopens when they leave; separate TA conversations per student |
| `ghost-test` | Unchanged — rejoin still replaces a stale avatar |
| `idle-test` (new) | Warned before moved, walked home, door reopens, speaking resets the clock. Run with `SOLO_WARN_S=4 SOLO_IDLE_S=8` |
| `materials-test` (new) | Index builds, passages are labelled, budget respected, nonsense matches nothing. No LLM, no server |

End-to-end check of the thing the change is actually for: *"What are queries, keys and values in
attention?"* — no document named — came back as four conversational sentences grounded in the
attention reading, tagged with its title.

**Tracker effects:** A3 dissolved (the rendezvous assertion is gone, not diagnosed), E2 resolved,
E1's reported path removed but still open pending a deployed check, E3 and E4 opened.

### Rollback

Each commit reverts independently. The riskiest is `7845269`, because it changes what the
instructor can do; reverting it restores movement and the room-based modes together, since they
are the same mechanism.

---

## 2026-08-22 · Make the test suites order-independent (A1, A2)

**Status:** **shipped 2026-08-22** — `7eedc2a`, verified locally
**Tracker:** resolved `open-issues.md` A1 and A2; opened A3 and E2 along the way.

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

**Fix as planned — and it was wrong.** The plan said to make the caller retry. Implemented, it
failed **8 times in 180 s**, which disproved the diagnosis rather than fixing the suite.

**The actual cause, found by then asking where Terra was.** Her position **persists between
suites and nothing sends her home.** Her home is `office-ta`, but smoke and integration walk her
elsewhere, and a suite that dies mid-run strands her — she was found in Jade's Office at (39,6)
while the TA office spans y 14-19. `scheduleReplies` picks only agents whose room matches the
speaker's, so Ana was talking to an empty room. **No timeout and no retry count could ever have
worked.**

**The fix that works:** the suite *places* Terra in the TA office through its own admin
connection and waits for her to arrive, retrying the send because the server refuses it while
she is busy. It no longer assumes where she is.

**The retry helper was kept** — busy-drop is genuine behaviour, so it is honest belt-and-braces,
and its diagnostic ("never answered across 8 attempts — she may be stuck busy rather than merely
slow") is precisely what exposed the wrong diagnosis. A plain timeout would have said "waiting
for Terra" a second time and invited the same wrong conclusion a third time.

**Worth keeping as a lesson:** a wait that *cannot* succeed is indistinguishable from a wait
that is *too short*. Two diagnoses in a row read this as impatience. Before lengthening any
timeout, check that the thing being waited for is possible at all.

**Deliberately not doing two things.** Not raising the timeout — it cannot work. Not changing
the server so that a busy agent queues or acknowledges — that is a product change, and making
one inside a test fix is how you lose track of what broke what.

### Found while diagnosing A2 — record, do not fix here

A student who messages Terra while she is busy with someone else gets **complete silence**: no
reply, no "one moment", no typing indicator. The admin path has a courtesy line for this
(`MainRoom.ts:339-341`, "(one moment — mid-conversation)") and the student path has nothing.
With five students sharing one Terra this will happen in class. To be filed as a new
`open-issues.md` entry under section E, and fixed separately.

### Verification — done 2026-08-22, both bars met

- **`smoke → integration → multiuser → ghost-test` all green in one run** from a fresh server
- **`ghost-test` green twice**: standalone against a fresh server (7 entities) and as the fourth
  suite (9 entities) — two different totals, which is exactly what the old assertion could not
  tolerate
- multiuser step 5 now reports `✓ Terra is in the TA office (put there by this suite, not
  assumed)`, and both students were answered on the first attempt

**One thing this run did not settle.** In the *previous* sequence, `integration` failed once on
`TIMEOUT waiting for: Jade & Terra in the Computer Lab`, then passed here. Filed as A3 rather
than dismissed as a flake: one failure in two runs is data. It is not attributable to this work,
which touches no server code and not `integration.ts`.

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
