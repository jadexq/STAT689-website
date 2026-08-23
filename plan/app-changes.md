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

## 2026-08-22 · Announcements, a real Library, and the project repo

**Status:** **planned** — no code written. This entry exists to be reviewed before any is.
**Scope:** three of the four features the instructor described. The fourth — interactive
handouts that students fill in and submit — is deliberately held back; see *Held back*.

### What the instructor asked for

1. **Shared course material and a course agenda**, available to every student, in the Library —
   and readable by the TA, so questions can be answered from them.
2. **A GitHub repo** (or a few) shared in the Computer Lab for a class project everyone
   contributes to.
3. **A board in each student's room** carrying messages from the instructor — homework posted,
   deadlines, and so on.

### Three decisions taken during review, which shrank the work considerably

**Google Drive is out.** Two facts settle it. The TA's grounding pipeline reads *files on disk*
listed in `manifest.json` (`virtual_ta/server/materials.ts`); a Drive URL is opaque to it, and
making it readable means a service account, the Drive API, Docs→text export, and change
polling. And Google stopped serving HTML from Drive in 2016 — a `.html` there previews as source
or downloads, it does not execute. So the interactive-handout idea, which is the only thing
Drive was really being asked to enable, **cannot work on Drive at all.** Drive stays useful as
the instructor's own authoring and archive space. The app does not read from it.

**The project repo is public.** The instructor's call, and it removes invitations, GitHub
username collection, and the read-only-`GITHUB_TOKEN` problem in one move. It also lets the app
fetch the README with no credentials. Two costs, both outside the app and both accepted: commit
metadata makes class enrollment publicly inferable, and branch protection on `main` matters more
rather than less when the repo is a public portfolio piece.

**Announcements are class-wide, not per-student.** The instructor's own simplification and the
most valuable of the three. A per-student board would have needed a visibility rule — a board in
an office is readable by whoever is standing in the office, and students will be able to walk
around once real ones sign in. That is a FERPA rule wearing a feature's clothes. One class-wide
feed has no such rule to get wrong. Per-student privacy returns only for handout submissions,
which is precisely where it belongs, and which is feature 4.

### The TA does not write announcements. The TA reads them.

An `announce` skill already exists (`virtual_ta/server/skills/announce.ts`) and is unreachable:
`SINGLE_SKILL` returns `coach` at the top of `route()`, and the `compose` admin action was
deleted earlier today. **Leave it dormant.** An announcement the model drafts is an announcement
the instructor has to proofread, and a wrong due date on a board is worse than no board. Typing
it takes ten seconds and is correct by construction.

The *reverse* integration is the one worth building. Today, pin "HW1 due Friday" to a board and
the TA has no idea it happened — posts live in `virtual_space/server/boards.ts` and never reach
the brain. A student asking "when is HW1 due?" gets a shrug, or worse, a guess. Putting the
announcements into the TA's prompt is a small change that does two things at once: the TA can
answer about logistics, and it stops contradicting the board.

### Two constraints that dictate the shape of the work

**Only the space server is reachable from a browser.** `docker/start.sh:40` runs the TA on
`127.0.0.1:3000`; Cloud Run exposes one port and it is the space's. So anything a student
clicks — a reading, the agenda — must be served *by the space*, proxying to the TA. This is why
step 2 opens with a proxy commit rather than a UI commit.

**The TA owns the corpus.** `virtual_ta/materials/` plus `manifest.json` is what `searchMaterials`
indexes. A second copy anywhere, for the Library to render from, would drift within a month. The
Library renders whatever `GET /api/materials` reports — one list, two consumers.

---

### Step 1 — Announcements

The admin UI needed here mostly exists: the **"📌 Pin to a board"** card
(`client/static/index.html:164`) is a textarea, a board dropdown, and a Pin button, and it is
location-independent — the message names its target, so the instructor posts from wherever they
are standing. No walking, no puppeting the TA. It has two gaps.

| # | Commit | What changes | Files |
|---|---|---|---|
| 1a | **`announcements` becomes a board target** | A feed that is not a room. The six offices get `hasBoard: true`; resolving an office's board returns the announcements feed. The dropdown gains **📣 Announcements — all students** above the two rooms. One stored item, six display points — so editing or deleting later stays one action, not six. | `server/boards.ts`, `server/map.ts`, `server/rooms/MainRoom.ts`, `client/src/main.ts`, `client/static/index.html` |
| 1b | **Board posts are signed by the instructor** | Posts are currently attributed to `this.ta().name` (`MainRoom.ts:644`), so text the instructor typed appears over the TA's name. Every board post is typed by a human; all of them get signed **"Jade Wang · Instructor"**. Not cosmetic: students must be able to tell an instructor's statement from an LLM's, and that distinction becomes load-bearing the first time the TA is confidently wrong. | `server/boards.ts`, `server/rooms/MainRoom.ts` |
| 1c | **The TA reads the announcements** | `taChat` gains an optional `context` block; `/api/chat` accepts it; it rides on `Session` as a per-request transient so no skill signature changes. `coach.ts` includes it in all three of its system prompts, with one rule: *for logistics — dates, deadlines, what is assigned — the announcements are authoritative over anything in the readings.* Capped at the 10 most recent items / ~1,500 chars. | `virtual_space/server/ta.ts`, `virtual_space/server/rooms/MainRoom.ts`, `virtual_ta/server/index.ts`, `virtual_ta/server/session.ts`, `virtual_ta/server/skills/coach.ts` |
| 1d | **The instructor can see and unpin what they posted** | The admin has no avatar and stands in the TA office, so they can never *walk* to an announcements board and read it back. The post card lists the current feed with an ✕ per item. New `admin` action `unpin`. Without this, a typo is permanent. | `server/rooms/MainRoom.ts`, `server/boards.ts`, `client/src/main.ts`, `client/static/index.html` |
| 1e | **Tests** | `integration.ts` step 1 asserts board count `=== 2`; becomes 8. New step: admin pins an announcement → a student in their own office sees it → the same student asks the TA about it in the TA office and the answer contains the date. That last leg is the only test that proves 1c end to end. | `virtual_space/scripts/integration.ts`, `virtual_space/scripts/smoke.ts` |

**Why 1d is not optional:** it is the only commit here that exists purely because the instructor
is not embodied. Everything else in step 1 would work without it, and the instructor would
discover on day one that they cannot read their own noticeboard.

### Step 2 — Course material and the agenda

| # | Commit | What changes | Files |
|---|---|---|---|
| 2a | **The space proxies the corpus** | `GET /api/materials` (list, forwarded to `TA_BASE_URL`) and `GET /api/materials/:id/file` (bytes). The browser cannot reach the TA; this is the bridge. Path traversal is already refused inside `materials.ts`, and `:id` is looked up in the manifest rather than joined onto a path, so the proxy adds no new file-system surface. | `virtual_space/server/index.ts` |
| 2b | **The Library board becomes the materials shelf, and `.md` is rendered on the way out** | Cards from the proxied list — title, one line, a link the space serves. Adding a reading to `manifest.json` makes it downloadable in the Library *and* answerable by the TA in one step; that single-source property is the entire reason for 2a. **The file route renders `.md` to HTML before serving it**, because markdown is the best format for the TA and the worst for a student who clicks it — a browser shows raw text or offers a download. Rendering **server-side** keeps it off a client bundle that is already ~1.2 MB. `.html` and `.pdf` are passed through untouched. | `virtual_space/server/index.ts`, `client/src/main.ts`, `client/static/index.html`, `server/rooms/MainRoom.ts` |
| 2c | **`agenda.md`, parsed against the real file** | Columns are the instructor's, not an invented set: `Date \| Week \| Lecture \| Content \| Homework \| Topic`. Three properties the file actually has and a naive parser gets wrong: **`Topic` spans** — it is filled on the first row of a block and blank after, so blank means *continues above*, not *no topic*; **dates carry no year** (`08/24`), so the year is explicit config, never inferred from the clock, or a student opening the page in January is shown next year's course; and **most rows are empty** (weeks 4-15 are placeholders), so the schedule renders them as scheduled-but-unplanned rather than as blanks. | `virtual_ta/materials/agenda.md`, `virtual_ta/server/materials.ts`, `virtual_space/client/src/main.ts` |
| 2d | **The agenda goes into the TA's prompt** | Same channel 1c built, alongside the announcements. Markdown makes this side nearly free: the TA already ingests `.md` from `materials/`, so the agenda is a manifest entry and a pinned-context flag rather than a JSON-to-text generator. Always included rather than retrieved — it is the one document where retrieval missing it yields a *confidently wrong* answer about a deadline instead of a vague one. **Only rows with content go into the prompt** — forty blank placeholder rows are not neutral filler, they invite the model to fill them in, and an invented Week 9 topic stated with the agenda's authority is worse than "not scheduled yet". | `virtual_ta/server/skills/coach.ts`, `virtual_ta/server/materials.ts` |
| 2e | **Upload without a redeploy** *(now recommended — see provenance below)* | Materials are baked into the container, so today a new reading costs a build. Read `DATA_DIR/ta/materials` in addition to the repo directory, with an upload form on the admin card. Last in the step so it can be cut without disturbing 2a–2d. | `virtual_ta/server/materials.ts`, `virtual_ta/server/index.ts`, `virtual_space/server/index.ts`, `client/*` |
| 2f | **Long documents** — *not optional* | The first real reading is **114 KB**, thirty times the only document the pipeline has ever seen. Two limits that were invisible at 3.7 KB now bite. `MAX_READING_CHARS = 28_000` silently truncates a named reading to its **first quarter**, so "in the agentic dev notes, what does it say about MCP?" is answered from a slice that does not contain the MCP section — confidently, with no signal that the rest was cut. And `MAX_CHUNKS_PER_DOC = 4` exists to stop one long document crowding out others; with one document 30× the rest it will bite on nearly every query. Fix: **chunk on headings** (the file has 19 `##` and 106 `###`), which also makes every passage self-describing so the TA can cite *§5 of the notes* rather than just the title; raise the per-doc cap when the corpus is small; and when a named reading does not fit, retrieve within it instead of truncating it. | `virtual_ta/server/materials.ts` |

**On formats.** All three are already supported (`materials.ts` branches on extension: `unpdf` for
PDF, `stripHtml` for HTML, read-as-is otherwise). The house preference is **`.md` for readings**:
no extraction step, so nothing is lost, and it is what the ~1,500-character chunking was tuned
against. `.html` when the rendering *is* the point — layout, images, MathJax, anything
interactive — written by hand rather than exported; a Google Docs HTML export is mostly
`<span class="c17">` wrappers that survive tag-stripping as whitespace noise, and `stripHtml`
strips `<script>`/`<style>` but not nav or footers, so a saved web page brings its chrome into
the index. `.pdf` only for papers that cannot be re-authored: extraction is the lossiest path,
and multi-column layouts interleave.
**On 2f.** This is the value of testing against real material rather than a fixture, and it
lands squarely on `open-issues.md` **E4**, which is open because cross-document retrieval had
never been exercised — the corpus was one file. It is now two real ones of wildly different
size, which is the harder and more honest case.

**On provenance.** The first reading is the instructor's own prose, but it carries references to
Apple-internal tooling picked up at a workshop. Two separate questions, with different answers.
*Serving it* to enrolled students behind IAP is fine — that is a course reserve. *Committing it*
is the risk: `virtual_ta/materials/` is tracked, and the repo is private **today**, a decision
git history outlives. So either scrub the internal references, or keep the corpus out of git and
load it from `DATA_DIR` — which is exactly 2e. That is why 2e moved from droppable to
recommended: it turns out to be a confidentiality boundary, not just a convenience.

**On 2e:** it is the difference between "adding a reading is a git commit and a deploy" and
"adding a reading is a drag and drop". Worth having before the semester, not necessarily before
the next test. Flagged droppable rather than dropped.

### Step 3 — The project repo in the Computer Lab

| # | Commit | What changes | Files |
|---|---|---|---|
| 3a | **Repo cards on the Computer Lab board** | A small `repos.json` (name, one-line description, URL — `github.com/jadexq/STAT689-project`) rendered as cards, instead of a raw pasted link. Config rather than a board post, so it survives a `boards.json` wipe — and D7 wipes state before the first class. | `virtual_space/server/repos.json`, `server/rooms/MainRoom.ts`, `client/src/main.ts` |
| 3b | **The README joins the corpus** | Fetch the public repo's README at boot and on a slow interval, cache it under `DATA_DIR`, register it as a reading. Then "how do I contribute to the project?" is a grounded answer rather than a shrug. Public repo means no token. **The fetch must not block startup** and must fall back to the cached copy — a GitHub outage cannot be allowed to stop the class server from booting. | `virtual_ta/server/materials.ts`, `virtual_ta/server/repo.ts` |

### Consequences to accept

1. **Every student message to the TA now carries the announcements and the agenda.** Small, but
   it is on every single turn. Capped as above; revisit if the feed grows.
2. **Existing posts in `boards.json` are signed "TA"** and 1b does not rewrite them. They are
   local test data, and `open-issues.md` D7 wipes state before the first class anyway.
3. **`/api/chat` gains an optional field.** The TA's own web client on `:3000` will not send it;
   the prompt must degrade cleanly to no-context rather than emitting an empty section header.
4. **`MAX_ITEMS = 50` is now shared** between announcements and the two room boards. Fine for a
   semester; noted so it is not a surprise.
5. **A public repo makes enrollment publicly inferable.** Outside the app. Worth telling students
   in week 1, and letting anyone who objects contribute under a pseudonymous account.

### Verification

Existing suites, plus the new leg in 1e. `npx tsc --noEmit` clean. The order-dependency rule
still holds — the first four suites run against a fresh server, in order.

| Suite | What it must show after this |
|---|---|
| `smoke` | pin to Library still works; new: pin an announcement, student sees it at home |
| `integration` | board count 2 → 8; the announcement→TA leg from 1e |
| `multiuser` | unchanged — no new per-student state, which is a consequence of the class-wide decision |
| `materials-test` | agenda parsed with spanning topics and no year; a malformed row still renders; each format (`.md`, `.html`, `.pdf`) extracts to sane text; **a question whose answer lives in the last quarter of the 114 KB reading is answered correctly** — the 2f regression test; README present after 3b |
| `idle-test` | unchanged |

### Held back — feature 4 (handouts with saved answers)

Not in this plan, by agreement. Recorded here so the shape is not re-derived later: the handout
is an HTML page **served by the app**, given an injected `save()` / `load()` shim, POSTing answers
that land in `DATA_DIR` keyed by student email, with an instructor view of submissions. It is
*less* work than the Drive route and the Drive route cannot do it at all. It is also the feature
that earns a proper instructor console — assigning, and reading six students' submissions, is
form-work that does not belong on a 2-D map. Student answers are coursework: same private bucket
and same FERPA footing as the conversation logs.

### Decisions taken on the instructor's behalf — overturn any of these

1. **Announcements appear in the six offices only, not also in the Library.** Reversed from what
   I said in conversation. Students spawn in their own room, so an announcement is the first
   thing they see at sign-in, and the feed keeps 50 items — the Library copy added a merge rule
   against the materials shelf for no reach the offices did not already have.
2. **All board posts get instructor attribution, not just announcements.** Consistent and honest,
   since a human types all of them. Say so if the Library and Lab posts should stay signed "TA".
3. ~~**The agenda is JSON, not markdown.**~~ **Overturned by the instructor on review** — the
   agenda is markdown with a table convention (2c). The right call: it costs the Library a
   ~20-line table parser and loses the reading-id linkage, but it buys an agenda that is
   pleasant to edit, and it makes the TA side nearly free since `.md` is already ingested. The
   client also avoids a markdown dependency it cannot afford — the bundle is already ~1.2 MB
   against a 1 GiB/month egress allowance.
4. **`repos.json` is config, not a board post** — so a state wipe does not silently empty the
   Computer Lab.
5. **The `announce` skill stays dormant rather than being deleted.** Same pattern as `classroom`.

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
