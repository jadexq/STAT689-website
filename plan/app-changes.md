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

## 2026-08-23 · A person's name, everywhere the character's placeholder shows

**Status:** **planned, not built.** Blocks the redeploy — see
[`gcp-deployment-plan.md`](./gcp-deployment-plan.md) §15, which depends on it.

### What prompted it

A second test account is being added, so for the first time two slots belong to real people
rather than to AI stand-ins. Writing the deploy config surfaced two things at once: the
instructor misread their own `STUDENTS` variable, and the name a real person is given only
reaches one of the four places it is displayed.

### A slot is a character, and the character's name is a placeholder

`roster.ts` already says it: six slots, each an office and a character, played by an AI
stand-in until a real address is assigned to it. The placeholder names exist so that a real
student **takes a character over** rather than arriving beside it.

That half works. The other half does not: `ROSTER` renames the avatar and nothing else.

| Surface | Reads from | Correct today |
|---|---|---|
| Avatar label in the world | `ROSTER` → slot name → email | yes |
| Office label on the map | hardcoded string, `map.ts` | **no** |
| Handout dashboard, incl. `?names=1` | `slot.name`, `handouts.ts` | **no** |
| `Roster:` startup line | `slot.name`, `rosterSummary()` | **no** |

So a real person assigned to a slot gets their own name on their avatar while standing in an
office labelled after a character who no longer exists, and the instructor's handout dashboard
lists their responses under that character's name. The office is the worse of the two — the
stand-in is *gone*, so the label names nobody at all.

**The office must follow whoever holds the slot.** That is not a preference; it is what the
stand-in design already implies, and only the avatar half was implemented.

### Why the names cannot simply be edited into `roster.ts`

Because they are real people's names, and this file and that one are both tracked:

> Addresses live in the environment, never in this file. This file is tracked in git and
> student addresses are not ours to publish. — `roster.ts`

Editing a display name into `SLOTS` would put a real person's name into git history, which
outlives the decision to keep the repo private. So the fix has to make `ROSTER` genuinely
load-bearing rather than route around it. That also means **`ROSTER` becomes required** for any
assigned slot, which the last change below enforces.

### Six changes

1. **`ROSTER` parsing moves from `identity.ts` into `roster.ts`,** which exports
   `displayNameFor(email)`. `identity.ts` already imports `roster.ts`, so the reverse would be a
   cycle — and `roster.ts` is where the slot fallback lives anyway, so the whole precedence chain
   (`ROSTER` → slot placeholder → name guessed from the address) ends up in one function.

2. **Office labels are patched at boot,** in `roster.ts`, for every slot with an assigned
   address. `ROOMS` is handed to the client wholesale and `roomById().label` feeds eight prose
   sites, so patching the one array covers every consumer for free. Doing it in `map.ts` instead
   would invert the import and create the cycle.

3. **`handouts.ts` and `rosterSummary()` go through `displayNameFor`** rather than reading
   `slot.name` directly.

4. **Slot id `jade` → `s6`, and room id `office-jade` → `office-s6`.** Every other slot id is an
   opaque handle; this one looked like a name, so `STUDENTS=<address>=jade` read as *"call this
   person jade"* when it means *"give this person that office"*. The instructor read it that way,
   which is enough evidence. Uniform ids make the format self-explaining. No data migration —
   `boards.json` keys on `library` and `announcements`, and session logs are historical records.

5. **Behind IAP, an assigned slot with no `ROSTER` name is a boot failure.** Once `ROSTER` drives
   four surfaces, a missing entry silently labels a real person with a character's name — the
   same shape as `open-issues.md` **D5b**, which already costs an afternoon. `roster.ts` throws at
   boot on an unknown slot id and on a duplicate slot; this is the third check in that idiom.
   Locally it warns instead, matching how `HANDOUT_SALT` and `ADMIN_EMAILS` are strict behind IAP
   and forgiving on a laptop — otherwise every suite would need a `ROSTER`.

6. **The possessive test in `MainRoom.ts` is broadened from `/^\S+'s\s/` to `/'s\s/`.** It picks
   between "Sam's Office door is shut" and "*the* Library door is shut" by looking for a
   possessive on the **first** token, so any two-word display name produces "the X Y's Office door
   is shut". The test account's name was going to trigger it immediately. "the Library" and "the
   Computer Lab" still come out right.

### One bug this uncovered, which is not new

**E6 is only three-quarters fixed.** Filed as **E8** rather than reopened, so the resolved
record of what E6 was stays intact. `MainRoom.ts:392` still walks an idle
occupant of the TA office home to a hardcoded `roomById("office-jade")`; lines 185, 240 and 414
were all converted to `homeRoomFor(email)` and this one was missed. E6's own text predicted the
symptom — "the new idle timer would have returned all five students to the same tile" — and on
this path it is still true. It is invisible while exactly one account holds a slot, and the
second test account makes it reachable. One line, same pattern as 414.

### Consequences to accept

- **Display names should be short, by convention rather than by enforcement.** An office is 6×6
  tiles and the label is drawn inside it. A full "Firstname Lastname's Office" will not fit
  comfortably. A first name or a short handle is the intent; nothing checks it.
- **Renaming a slot mid-semester leaves older prose inconsistent** in the session logs. Acceptable:
  `logEvent` records room *ids*, so only conversational text is affected, and that text is a
  point-in-time record anyway.
- **An office belongs to its assignee whether or not they are online.** Consistent with the
  existing rule that an absent occupant's office is empty rather than staffed by an impostor.

### Verification

- Two accounts assigned to two slots, with `ROSTER` names: each avatar, each office label, the
  `Roster:` startup line, and the handout dashboard under `?names=1` all show the same name.
- A slot assigned with no `ROSTER` entry: boots with a warning locally, refuses to boot with
  `TRUST_IAP_HEADER=1`.
- Walking into a shut TA office reports the occupant's office correctly for a two-word name.
- Idling out of the TA office returns the occupant to **their own** office, not `s6`'s (E8).
- `smoke.ts` and `integration.ts` pass — both are likely to assert on the old hardcoded label and
  will need updating; that is expected, not a surprise.
- `handout-test.ts` still passes with its six-address roster; its `STUDENTS` builder references
  the old `jade` slot id and moves to `s6`.

### Not in scope

- **How many slots real students get.** Six exist; if the two test accounts keep two of them,
  four are left. Deferred by the instructor until the class list is final — tracked as
  `open-issues.md` **D12** so it does not drift past.
- **Naming the offices anything other than after their occupant.** Considered and rejected above.


## 2026-08-23 · Feedback handouts — per-student versions, per-section judgement

**Status:** **shipped 2026-08-23**, verified locally — `b87a6e2` (4a), `ba1c2fe` (4b), `afe0666`
(4c), `b316963` (4d and the suite), then `084baff` (carry `?as=` on every call that depends on
who is asking) and `f0bfbd0` (salt fingerprint, and attribution said plainly — see the two
sections at the end of this entry). All six existing suites green plus a seventh,
`scripts/handout-test.ts`, 94 assertions. **Not deployed**, and until it is, no student can
reach any of it: every part of this is student-facing and students reach the app only through
Cloud Run. Design settled in
[`gpt_student_feedback_handout_model_design.md`](./gpt_student_feedback_handout_model_design.md);
this entry is the executable half, and **diverges from it in two places**: decision 6 drops the
pairwise probe that document recommends, and the attribution section at the end contradicts its
claim that hashing the email makes students "provide more honest feedback" — at one reader per
version it does not, and the app now says so on the page rather than banking on it. Authoring rules for the handouts themselves
live in [`handout-authoring.md`](./handout-authoring.md) — the instructor writes them, the app never
generates them.

**What step 4 cost that the plan did not predict.** Six things, none large, all worth writing down.

1. **`handout-format.ts` is its own module.** The plan listed `server/handouts.ts` and the bundler.
   But the bundler cannot import `handouts.ts` without dragging in `roster.ts` — which throws at
   module load on a malformed `STUDENTS` — and `paths.ts`, and `.env`. A validator that refuses to
   run until the app is configured is a validator nobody runs. The types, the content hash and
   `validateBundle` moved into a module that imports only `crypto`. Same shape as 2b's finding
   that the agenda parser belongs beside `materials.ts` rather than inside it.
2. **The salt check has to run *before* `identify()`.** Decision 3 said the routes 503 without a
   salt; it did not say where in the route. Behind IAP with no salt, `identify()` runs first and
   answers 401, so the failure mode the suite is meant to assert was unreachable without minting a
   JWT. Moved ahead of the identity check on all five routes — which is the truer answer anyway:
   whether the feature is configured has nothing to do with who is asking.
3. **`grade` is nullable, and the record schema above understates it.** A student who types a
   comment and closes the tab before clicking a number has still said the most useful thing on the
   page. Those records export and are skipped when pairs are derived.
4. **The suite has to bring its own server.** The Verification section below says "run against a
   fresh server over `fixtures/handout-sample/`". It cannot: every property worth asserting here is
   about *six* students holding six versions between them, and a developer's `.env` assigns one
   slot — a Latin square asserted against a one-student roster is not asserted at all. So
   `handout-test.ts` spawns the space on a spare port with its own `DATA_DIR` under the system
   temp directory and its own six-address roster, plus a second IAP-mode server with no salt, and
   throws both away. It is also the only suite that needs nothing else running, which is the
   separation from the TA made visible.
5. **`express.json()` ordering, not the route's own limit.** A six-version handout is well past
   body-parser's 100 kB default, and the obvious fix — a bigger limit on the route — never runs,
   because the first parser to touch a request sets `req._body` and every later one returns early.
   The larger parser is registered on `/api/handouts` *before* the global one.
6. **KaTeX is served from the installed package, not copied into `client/static/`.** Decision 5
   assumed the fonts had to be vendored. They do not: `katex` is a runtime dependency, so the
   Dockerfile's `npm prune --omit=dev` leaves it in place, and `express.static` over its `dist`
   keeps a megabyte of woff2 out of git.

**And one found after shipping, by the suite failing in the way it warns other suites about.**
`handout-test.ts` killed `npx` rather than the process *group*, so a run that failed mid-way left
its server holding the port; the next run connected to it and made every assertion against the
previous run's data. It reported "one record so far" against six. Fixed by spawning the local
`tsx` binary detached, killing the group, and refusing to start at all if the port already
answers — the A1/A2 rule turned on the suite that invoked it.

Two smaller decisions taken while building, recorded because they are not obvious from the code:
the panel keys on `init.home` rather than on "their own office", so someone not yet on the roster
— who has no office and lands in the Common Area — still finds out why their links will not open;
and `exportPairs` drops a pair whose two sides share a `version_id`, because two records of one
version compare two readers rather than two approaches.

### What the instructor asked for

Each student receives **their own version** of a handout — lecture-notes prose, LLM-generated by
the instructor outside the app. Six students, six versions, six different approaches to the same
material. After every section the student grades it 1–5 and may leave a comment. The instructor
reads the result and writes better handouts; over a term the records accumulate into a dataset in
a shape that could later support reward modelling or DPO.

**This is the exploration stage, and the design follows from that.** The instructor's students are
PhD-level readers whose judgement is trusted, and the question being asked is not "does approach A
beat approach B" but "which of six routes through this material land, and why". Six versions with
one reader each maximises the number of approaches sampled and the number of considered comments,
at the cost of replication: each (section, version) cell holds exactly one judgement. That is the
right trade while exploring and the wrong one later, which is why nothing here prevents narrowing
to two or three versions once the field of approaches is known — `versions` is an array and the
rotation is `% versions.length`.

The numbers say plainly what this is: six students × ~5 sections × ~10 handouts is a few hundred
records. Far too few to train anything from scratch, and genuinely useful as a held-out set for
answering "did changing the generation prompt produce material students prefer?". **An evaluation
system first and a training corpus second.** Build it for the first purpose; keep the schema
shaped for the second.

### Six decisions the design document leaves open

Each of these would otherwise be guessed, and the first three corrupt the dataset **silently** —
the failure is discovered a term later, in the data, with nothing to recover from.

**1. Version assignment is a deterministic rotation, written down once, never recomputed.**
The design says "randomly assign". A random draw at render time hands a student a *different
version on reload* and destroys the assignment, the resume behaviour, and every record already
collected. Instead:

```
versionIndex = (studentIndex + sectionIndex) % versions.length
```

`studentIndex` is the roster slot order (`roster.ts` `SLOTS`), `sectionIndex` the position in
`handout.json`. With six students and six versions this is an exact Latin square: within any one
section the six students hold the six versions between them, and no student reads the same version
twice until the handout runs past six sections. Every version is read the same number of times, by
a different student each time, which is what keeps a version effect separable from a rater effect
even at one judgement per cell. Random assignment only approaches that balance in expectation and
never reaches it at n=6.

The same expression stays balanced if the instructor later narrows to two or three versions — it
degrades to three readers per version, or two — so the exploration setting and the replication
setting are the same code.

The resolved assignment is recorded in the student's own response file at first render, and read
back from there forever after. Deriving it again on each request is the same class of bug as
recomputing a sticky `readingId`: it works until the inputs change, and then it rewrites history.
One writer per file, so no read-modify-write race between six students opening at once.

**2. Every feedback record carries a content hash of the exact text shown.** The instructor will
edit a section after feedback exists — a typo, a clarification. Without a hash, those earlier
grades silently describe text that no longer exists. `sha256(body).slice(0, 16)`, stamped at
write time. Costs nothing now; unrecoverable later. This is the same argument the design document
makes for generation provenance, carried one step further.

**3. The student hash must be salted, and the feature fails closed without a salt.**
`hash(email)` over six known addresses is invertible by anyone holding the roster — it is not
pseudonymisation, it is the appearance of it. `sha256(HANDOUT_SALT + email).slice(0, 16)`, salt in
the environment, never in the dataset and never in git. With no salt set the handout routes
return 503 and say why; they do **not** fall back to an unsalted hash, and they do not take the
rest of the campus down with them. In DEV identity mode a fixed dev salt is used and the boot
line says so loudly, because a local suite must still be able to run.

**Added after shipping, because a missing salt was never the dangerous case.** *Changing* one is:
every hash moves, so every recorded version assignment and every collected grade becomes an
orphan under a hash nobody holds, and nothing errors — the dashboard simply shows fewer responses
than it did last week. The first response written now stamps
`DATA_DIR/space/handouts/.salt-fingerprint`, and every handout route checks it, so a changed salt
fails the way a missing one does: 503, naming the fix. Restoring the old value is still the only
real recovery. Tracked as **D8** in [`open-issues.md`](./open-issues.md), which also carries the
one `openssl rand -hex 24` the deploy needs.

**4. Handouts are bundles, not directories, because of how the container is restored.**
`docker/sync.mjs` restores one `current.tar.gz` and overwrites it on the next flush, so files
side-loaded into the bucket do not survive and cannot be dropped in that way. Handouts therefore
arrive the way readings do — uploaded through the app by the instructor. At six versions a
handout is two dozen files, which makes file-at-a-time upload absurd, so
`npm run bundle:handout <dir>` validates a
directory of `.md` files and emits **one** `<handout_id>.handout.json`; the admin uploads that.
The server reads bundles only, one code path, locally and deployed alike.

**5. Math renders. `marked` alone does not do it.** The GPT chapter is nanoGPT — softmax,
attention, cross-entropy — and a handout that cannot set an equation is not usable for it.
KaTeX, server-side, in 4b. Cost: the KaTeX stylesheet inline and ~1 MB of woff2 fonts served
from `client/static/`, on handout pages only and cached after first load. Overturnable: without
it, formulas go in fenced code blocks and look like code, which for this material is worse than
the megabyte.

**6. No pairwise probe. Preference pairs are derived from the grades instead.** The design
document recommends showing selected sections in a second version and asking which the student
would rather have learned from — a direct DPO label. It is dropped, deliberately: at six versions
the probe UI is the most complicated part of the build, it costs the student an extra read of
material they did not need, and the instructor is at the exploration stage where the comments
matter more than a clean contrast.

What replaces it is arithmetic rather than UI. Each section is read in six versions by six
students, each grading 1–5, so per section there are up to **C(6,2) = 15 orderable pairs**;
across ~50 sections in a term that is several hundred derived `(objective, chosen, rejected)`
triples — more than the probe would have produced, and noisier, because they compare across
students rather than within one. Subtracting each rater's own mean before ordering is the standard
correction and is reasonable with six calibrated readers.

**This is why the grade is 1–5 and not 👍/😐/👎.** With replication, three levels are enough and
five are false precision — that was the earlier reasoning and it was right for the earlier design.
With one judgement per cell nothing is being averaged; the grades are being *ordered*, and three
levels tie almost every pair into uselessness. The scale changed because its job changed.

**Nothing in the bookkeeping relaxes.** Derived pairs are only valid if `learning_objective` is
byte-identical across all six versions of a section, and if `content_sha` and `prompt_template`
ride on every record. Dropping the probe simplifies the interface, not the schema.

### Seven gaps closed 2026-08-23, before executing

The audit that step 3 got and this entry had not. Each of these would have been guessed by a
fresh session, and two of them would have been guessed *wrong in a way that corrupts the balance*.

**1. Where any of it lives on disk.** Named nowhere above. It is:

```
DATA_DIR/space/handouts/<handout_id>.handout.json          ← the uploaded bundle
DATA_DIR/space/handouts/responses/<handout_id>/<hash>.json ← one file per student
```

`paths.ts` already appends `space/` to `DATA_DIR`, so this is `handouts/` under it. One writer per
response file, which is what keeps six students clicking at once from clobbering each other — but
a *single* student clicking quickly is a read-modify-write on their own file, so writes to one
file serialise through a per-path promise chain. Six students and a dozen clicks each does not
justify anything more than that.

**2. The rotation has no `studentIndex` for anyone off the roster — including the instructor.**
`slotFor()` returns undefined for any address not in `STUDENTS`, and `homeRoomFor()` drops them in
the commons with no office. Two different people hit this and they need different answers:

- **The admin**, who has no avatar and no slot, gets a **preview**: `?version=C` selects
  explicitly, the first version is the default, and **nothing is recorded**. The handout page is
  where the instructor checks rendering; the dashboard is where they read results.
- **An off-roster student** is refused, loudly — "you are not on the class roster for this
  handout" — and the attempt is logged. *Not* silently given index 0: that is a real student's
  rotation, and two people on one rotation quietly destroys the Latin square that decision 1
  exists to guarantee. The fix is a one-line `STUDENTS` change, which has to happen before the
  first handout regardless. The instructor's own `@tamu.edu` address is exactly this case today.

**3. Delivery is named but not mechanised, and it must not write to a board.** "A link on their
own office board" was the sentence; `boards.json` holds the instructor's own words pinned verbatim
(1b), and having the app post there would put its wording in the instructor's mouth under their
signature. Instead: `GET /api/handouts` lists what the caller may open, and the client renders a
**📝 Handouts** list in the side panel when the student is in their own office — the third use of
the fetch-on-room-entry idiom, after the Library shelf (2b) and the repo cards (3a). If the
instructor wants to announce it, they announce it themselves, in their own words.

**4. The bundle format itself was never written down.** `handout-authoring.md` describes the
*source directory*; nothing described what the bundler emits. It is the source, flattened, with
the hashes precomputed:

```json
{
  "schema_version": 1,
  "handout_id": "…", "title": "…", "chapter": "…", "term": "…",
  "versions": ["A", "B", "C"],
  "sections": [
    { "section_id": "…", "title": "…", "learning_objective": "…",
      "bodies": { "A": { "markdown": "…", "content_sha": "…", "approach": "…",
                         "generation": { … } } } }
  ]
}
```

`content_sha` is over the **body only**, front-matter excluded — so fixing a typo in an objective
does not invalidate grades on prose that did not change.

**5. Front-matter needs a real YAML parser, and only the bundler needs it.** The authoring format
uses folded scalars (`learning_objective: >`) and a nested `generation:` mapping; hand-rolling
that is how you get a silently truncated objective. Add `yaml` to `virtual_space` as a
**devDependency** — the bundler is a script, and the server only ever reads the JSON bundle. The
runtime parses no YAML, which is worth keeping true.

**6. The suite needs a fixture, and it must be tracked.** `virtual_space/fixtures/handout-sample/`
— two sections × **three** versions, synthetic prose, no student or third-party content. Tracked
in git, unlike `test_material/`: a suite whose fixture lives only in a gitignored directory is
machine-dependent, which is the A1/A2 rule the suites were cleaned of once already. Three versions
rather than six because it makes the "narrowing later still balances" assertion real rather than
hypothetical.

**7. Express 4 does not propagate async rejections.** The space's standing trap — every route
added here needs its own try/catch, or a thrown error hangs the request instead of returning 500.
The TA's express 5 propagates natively; the space's does not, and every route in `index.ts`
already carries the explicit catch for this reason.

**One property to preserve rather than decide:** nothing in this feature talks to the TA. Handouts
are rendered, stored and reported entirely by the space, so a TA outage takes the chat down and
leaves the handouts working. That falls out of decision 6's separation and is worth not breaking
later by reaching for `llm.ts` to summarise comments.

### The commits

| # | Commit | What changes | Files |
|---|---|---|---|
| 4a | **The handout store and its bundler** | Bundle format, loader, and `npm run bundle:handout` — which is also the validator: it refuses a title or a learning objective that differs between versions of a section, a section missing one of the declared versions, a missing `generation` block, or a duplicate `section_id`. Admin-only `POST /api/handouts` taking the bundle as a JSON body, mirroring 2e's guard exactly. Ships `fixtures/handout-sample/`. | `virtual_space/server/handouts.ts`, `scripts/bundle-handout.ts`, `server/index.ts`, `package.json`, `fixtures/handout-sample/*` |
| 4b | **Rendering and assignment** | `GET /handout/:id` — identity from `identify()` (honouring `?as=`), rotation resolved and recorded, sections stitched from the assigned versions, one page. Admin gets the `?version=` preview and writes nothing. `GET /api/handouts` lists what the caller may open; the client renders the **📝 Handouts** panel on entering one's own office. Extends `render.ts` rather than forking it; adds KaTeX. | `virtual_space/server/handouts.ts`, `server/render.ts`, `server/index.ts`, `client/src/main.ts`, `client/static/index.html`, `client/static/katex/*` |
| 4c | **The section widget and the write path** | A 1–5 grade after each section; a grade of 3 or below reveals the tag list — `too_abstract`, `too_difficult`, `too_simple`, `too_long`, `missing_examples`, `poor_organization`, `unclear_notation` — and a comment box is always available. Autosaves on click, no submit button, restores on reload. `POST /api/handouts/:id/feedback` takes the student from `identify()` and **never** from the body. | `virtual_space/server/handouts.ts`, `server/index.ts`, `server/render.ts` |
| 4d | **The instructor's view** | Admin-only `GET /admin/handouts/:id`: response rate per section, the grade each version drew, tag counts, comments verbatim — ordered worst-first, and aggregated by section rather than by person. `?format=jsonl` exports the graded records; `?format=jsonl&pairs=1` exports the derived preference triples, rater-mean-centred, ties dropped. | `virtual_space/server/handouts.ts`, `server/index.ts`, `client/src/main.ts` |

Delivery is part of 4b, and is **not** a board post — see gap 3, which overturned the sentence
that stood here. `GET /api/handouts` lists what the caller may open and the client renders a 📝
Handouts panel in the side panel on entering one's home room. No new room, no new websocket
message; the same lesson 3a learned from 2b.

### The record, which is the actual product

```json
{
  "schema_version": 1,
  "term": "2026F",
  "handout_id": "nanogpt-attention",
  "section_id": "self_attention",
  "section_index": 1,
  "student_hash": "9f2c…",
  "version_id": "A",
  "content_sha": "4a71…",
  "generation": { "model": "…", "prompt_template": "…", "temperature": 0.7, "generated": "2026-09-01" },
  "learning_objective": "…",
  "grade": 2,                                   // 1-5, or null — see finding 3
  "tags": ["too_abstract", "missing_examples"], // only at a grade of 3 or below
  "comment": "…",
  "ts": "2026-09-02T14:11:03Z"
}
```

`generation` and `learning_objective` are **copied onto the record** rather than referenced, so an
exported line is self-contained and a later edit to the source file cannot rewrite the past. The
objective is on every record because it is the *prompt* half of every preference triple derived
from these grades — a pair whose two sides carry different objectives is not a pair.

The derived export is a second shape over the same data, built at export time and never stored:

```json
{
  "prompt": "<learning_objective>",
  "chosen": "<section body, higher grade>",
  "rejected": "<section body, lower grade>",
  "chosen_meta": { "version_id": "C", "content_sha": "…", "prompt_template": "…", "grade_centred": 0.83 },
  "rejected_meta": { "version_id": "A", "content_sha": "…", "prompt_template": "…", "grade_centred": -1.17 }
}
```

### Consequences to accept

1. **Handouts stay out of the TA's corpus.** If the TA can read the variants it will describe
   another student's version to a student, and contaminate both the reading and the comparison.
   The cost is that the TA cannot help with the handout — accepted deliberately. A `promote`
   action, moving a winning version into the Library corpus once the comparison is done, is the
   right closing move and is **not** in this plan.
2. **Student responses are FERPA-relevant coursework.** They land in `DATA_DIR`, which is
   gitignored and snapshotted to the private bucket, on the same footing as the conversation logs.
   The salt lives in the environment; the hash→identity mapping is instructor-only and is not part
   of any export.
3. **Feedback is attributed, and students should be told so.** The hash gives deniability against
   a casual reader of the dataset, not against the instructor, who holds the salt. Saying this
   plainly in week 1 is better than implying an anonymity that does not exist.
4. **Six students is the whole sample, and at six versions each cell holds one judgement.** One
   student not responding is 17% of the data and, for the sections they skipped, 100% of what is
   known about those specific versions. The instructor has said response will be required, which is
   what makes the design viable at all. It also means no single grade should be read as a
   measurement — the comments are the evidence, the grades are the index into them.
5. **A second write path opens on the browser-reachable side.** 2e opened the first, for the
   instructor only. This one is open to students — which is correct, and is exactly why the
   identity comes from `identify()` and the record is keyed by it. A student can write their own
   feedback and read their own handout; the dashboard is admin-only.
6. **Preference pairs are derived, not observed.** They compare across students, so they inherit
   every difference between two readers that mean-centring does not remove. Honest for prompt
   selection and for a held-out eval; the kind of thing that needs saying out loud if a number
   from it is ever published.
7. **The grade scale is 1–5 and reverses an earlier decision in this plan.** Recorded rather than
   quietly edited: three levels were right for the design with replication and are wrong for this
   one. See decision 6.

### Verification

`virtual_space/scripts/handout-test.ts` — which **spawns its own** space rather than attaching to
a running one, for the reason in finding 4 above. The tracked `fixtures/handout-sample/` (two
sections × three versions) carries the real prose and is what the bundler is pointed at; the
rotation properties are asserted over synthetic bundles built in the suite, because they need six
versions and six raters. It asserts the properties that cannot be eyeballed:

- all six students, all sections: **each version appears an equal number of times**, and within
  any single section the six students hold six distinct versions;
- the same assertion at two and at three versions, so narrowing later is covered before it
  happens rather than after it breaks;
- a student reloading gets **the same** versions — the assignment is read back, not re-derived;
- adding a section, or a version, does not change what an existing student already saw;
- a student cannot read another student's responses, and cannot reach the dashboard;
- feedback posted with someone else's email in the body is recorded against the **caller**;
- with `HANDOUT_SALT` unset in IAP mode the routes 503 and the rest of the campus is unaffected;
- an **off-roster** address is refused rather than given slot 0's rotation, and the admin's
  `?version=` preview records nothing;
- the bundler refuses each of the malformed fixtures it ships alongside the good one;
- an export line round-trips: every field present, `content_sha` matching the rendered bytes,
  `learning_objective` identical across every version of a section;
- the derived-pairs export produces no pair whose two sides differ in `section_id` or objective,
  and drops ties rather than breaking them arbitrarily, and a version **edited since it was
  graded** drops out of the pairs while its record survives;
- restarting on the same data with the same salt is fine, a **changed** salt stops the routes and
  says why, and a new salt on an empty tree is still free;
- the dashboard names who has answered nothing, counts only **assigned** slots as the cohort,
  shows no names by default, and says in the page that the data is not anonymous to the reader.

Plus the existing six suites unchanged — this adds routes, not behaviour, to anything already
tested.

The suite also **refuses to run against a server it did not start**. That is not tidiness: the
first version killed `npx` rather than the process group, so a failed run left its server holding
the port and the next run asserted against the previous run's data. See the finding above.

### Not in scope

Generation inside the app; promoting a winning version into the corpus; comprehension checks;
dwell time; anything resembling model training. The **pairwise probe** is out by decision 6 rather
than by omission — if the instructor later wants observed rather than derived pairs, it is an
additive commit and the record schema already has room for it. And the deploy, which this depends
on rather than includes.

### The question that was open, and how it was answered

**Whether any of this is intended for publication — deferred, 2026-08-23.** The instructor is not
handling IRB now. Recorded rather than dropped, with the trigger written down in **D9** of
[`open-issues.md`](./open-issues.md): collecting judgements *for teaching* is ordinary classroom
practice and involves no IRB, and it becomes human-subjects research the moment the results are
aimed outside the course. The exemption is routine to obtain and cannot be applied retroactively,
so the deadline is the first *collection*, not the first draft — which is why the condition is
worth keeping visible even while the answer is "not now".

### On attribution, decided the same day

Asked whether the instructor should see which student said what. The honest answer turned out to
be that **the design already makes it visible**, and the code was implying otherwise.

At one reader per version, `version_id` *is* a student id within a section: the dashboard shows
the version beside every grade, and `(studentIndex + sectionIndex) % versions.length` is
arithmetic anyone holding the roster order can redo. The salted hash therefore protects an
exported file from someone who lacks the roster — real, and worth keeping — and protects nothing
from the person reading the dashboard. Labelling rows with a hash while the version column gives
the game away is not privacy; it is a false signal to whoever reads this code next.

So, three changes rather than one:

1. **The dashboard says it plainly** — "not anonymous to you", with the reason — and offers
   `?names=1` instead of pretending it cannot.
2. **Names stay off by default**, for a different reason than privacy: judging the writing goes
   better when you do not know whose reaction you are reading. That is a reading discipline, not
   a protection, and the banner says which it is.
3. **Absences are named outright.** "Not answered at all: Grace, Jade" — chasing a non-responder
   needs a name and attaches it to no opinion, and response being required is what makes the
   whole design viable (consequence 4). The denominator is now the *assigned* slots rather than
   `SLOTS.length`; a slot with no address is a character played by an AI, not a student who has
   not answered.

The corresponding thing to say to students in week 1 is one sentence: the feedback is attributed,
the instructor can see who wrote what and will not go looking, and they will see who has not
answered. With six PhD students who already know they are being read, that costs less candour
than implying an anonymity that does not exist.

---

## 2026-08-22 · Announcements, a real Library, and the project repo

**Status:** **steps 1, 2 and 3 shipped 2026-08-23**, verified locally. Step 1 — `30dfd60`,
`a5278ab`, `bf9f13c`, `2786317`, `fd4efa3`. Step 2 — `9602a52` (2a), `2a531b3` (2b), `45fb3b4`
(2c), `9830cd1` (2d), `05ddb35` (2e), `9c8aa52` (2f), plus `f314f8c` (suites). Step 3 — `d19c62c`
(3a), `de60ce5` (3b), all six suites green. **Not deployed.** Two pieces of *enabling* work landed first so the plan could be
checked against real documents rather than a fixture: `7e4b2c0` (a `MATERIALS_DIR` override and
`npm run test:materials`) and `7539de7` (test fixtures gitignored); both are what turned 2f from
an estimate into a measurement.

**What step 2 cost that the plan did not predict.** Four things, none large:

1. **2a is two servers, not one.** The plan listed only `virtual_space/server/index.ts`. There was
   nothing on the TA side to proxy *to* — `/api/materials/:id/file` had to be built there first.
2. **The agenda parser is its own module** (`virtual_ta/server/agenda.ts`), not part of
   `materials.ts` as written. Rows, spans and dates are a separate set of concepts from retrieval,
   and `materials.ts` was already 290 lines.
3. **2e needed an authorization decision the plan had not reached.** The upload is the first
   *write* on the browser-reachable side of the proxy, so it is the first HTTP route that needs an
   identity check at all — every other route is a read. `identify(req)` and a 403, because the TA
   cites every reading as authoritative and a student-supplied "reading" would inherit that.
   The route also honours `?as=…` locally, which is what makes the guard testable.
4. **2c and 2d needed an endpoint the plan had not named:** `GET /api/agenda` on the TA, proxied,
   so the Library can render the schedule. The prompt side reads the corpus directly, as decided —
   this is only the display path.

**Two findings to carry forward, neither fixed here:**

- **There is no way to remove an uploaded reading.** 1d's argument applies exactly: the instructor
  can pin *and* unpin a board post because a mistake must not be permanent. They can upload a
  reading and never take it down. Re-uploading the same id replaces it, which covers a correction
  but not a withdrawal. Small, and out of step 2's scope — but it is the same gap 1d existed to
  close, one system over.
- **The TA now answers dates in ISO.** 2d puts the schedule in the prompt as `2026-11-18`, and the
  model has adopted that as house style even when quoting an announcement that said `11/18`.
  Unambiguous, slightly robotic. Left alone deliberately; noted because it changed a test.

**What step 1 cost that the plan did not predict:** one latent bug, found by building 1d. Board
item ids were `post-<ms>-<list length + 1>`, unique only while lists grew — and unpinning shrinks
one, so a later post could reuse a live id and an unpin would then remove the wrong item. Nothing
could have hit it before there was a way to remove an item. Replaced with a counter.
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
| 2b | **The Library board becomes the materials shelf, and `.md` is rendered on the way out** | Cards from the proxied list — title, one line, a link the space serves. Adding a reading to `manifest.json` makes it downloadable in the Library *and* answerable by the TA in one step; that single-source property is the entire reason for 2a. **The file route renders `.md` to HTML before serving it**, because markdown is the best format for the TA and the worst for a student who clicks it — a browser shows raw text or offers a download. Rendering **server-side** keeps it off a client bundle that is already ~1.2 MB. `.html` and `.pdf` are passed through untouched. **The shelf sits above the Library's existing pinned posts, it does not replace them** — the Library stays a post target, and `smoke` step 6 pins there and expects a student to see it. | `virtual_space/server/index.ts`, `client/src/main.ts`, `client/static/index.html`, `server/rooms/MainRoom.ts` |
| 2c | **`agenda.md`, parsed against the real file** | Columns are the instructor's, not an invented set: `Date \| Week \| Lecture \| Content \| Homework \| Topic`. Three properties the file actually has and a naive parser gets wrong: **`Topic` spans** — it is filled on the first row of a block and blank after, so blank means *continues above*, not *no topic*; **dates must carry the year**. The master in `syllabus/` writes `08/24`; the instructor's test copy writes `2026/08/24`. Standardise on the second and the problem disappears — inferring the year from the clock shows a student opening the page in January next year's course, and a configured year is one more thing to forget each August. A self-describing date needs neither. The parser accepts only the four-digit form and reports a row it cannot date rather than guessing; and **most rows are empty** (weeks 4-15 are placeholders), so the schedule renders them as scheduled-but-unplanned rather than as blanks. | `virtual_ta/materials/agenda.md`, `virtual_ta/server/materials.ts`, `virtual_space/client/src/main.ts` |
| 2d | **The agenda goes into the TA's prompt** | Alongside the announcements, in the block 1c built — `bulletinBlock()` in `coach.ts`, fed by `session.bulletin`. **The TA side does this, not the space.** The announcements come over the wire because only the space knows them; the agenda is already in the TA's own corpus, and round-tripping it out to the space and back would be work in service of symmetry. So `bulletinBlock()` reads it directly and the wire field stays announcements-only. Markdown makes this side nearly free: the TA already ingests `.md` from `materials/`, so the agenda is a manifest entry and a pinned-context flag rather than a JSON-to-text generator. Always included rather than retrieved — it is the one document where retrieval missing it yields a *confidently wrong* answer about a deadline instead of a vague one. **Only rows with content go into the prompt** — forty blank placeholder rows are not neutral filler, they invite the model to fill them in, and an invented Week 9 topic stated with the agenda's authority is worse than "not scheduled yet". | `virtual_ta/server/skills/coach.ts`, `virtual_ta/server/materials.ts` |
| 2e | **Upload without a redeploy** *(now recommended — see provenance below)* | Materials are baked into the container, so today a new reading costs a build. `MATERIALS_DIR` (`7e4b2c0`) already *relocates* the corpus, which is enough for local testing but replaces it wholesale; 2e adds `DATA_DIR/ta/materials` as a **second root** so uploaded and shipped readings coexist, plus the upload form on the admin card. | `virtual_ta/server/materials.ts`, `virtual_ta/server/index.ts`, `virtual_space/server/index.ts`, `client/*` |
| 2f | **Long documents** — *not optional, and measured* | The first real reading is **113,207 chars**, thirty times the only document the pipeline had ever seen. Measured against it: naming the document returns **28,034 chars — 25% of it**, and the §14 content is **not in the slice**. `matchReading` fires on ordinary phrasing (*"in the practitioner's notes, what does it say about MCP?"* → match), and `session.readingId` is **sticky** — `coach.ts` only takes the search path when it is unset — so one such question pins **the whole rest of that conversation** to the first quarter of the document, including questions retrieval would have answered correctly. The search path itself works but hits `MAX_CHUNKS_PER_DOC = 4` on every query. Fix: **chunk on headings** (19 `##`, 106 `###`), which also makes passages self-describing so the TA can cite *§5* rather than a title; raise the per-doc cap while the corpus is small; and when a named reading does not fit, **retrieve within it** instead of truncating it. | `virtual_ta/server/materials.ts`, `virtual_ta/server/skills/coach.ts` |

**Pinned readings — one decision that 2c, 2d and 2f all depend on.** The agenda is in the corpus
today as an ordinary searchable reading (`id: "agenda"`). Once 2d always-includes it, it would be
in the prompt twice — once pinned, once as a retrieved passage — and it would be chunked, which
for a single markdown table means shredded across rows. Add a manifest flag (`"pinned": true`)
meaning: **excluded from the chunk index, included in every prompt.** That is the whole
mechanism, and it is what makes 2f's heading-based chunking safe to apply corpus-wide — the one
document with no headings is the one document that is never chunked.

**On formats.** All three are already supported (`materials.ts` branches on extension: `unpdf` for
PDF, `stripHtml` for HTML, read-as-is otherwise). The house preference is **`.md` for readings**:
no extraction step, so nothing is lost, and it is what the ~1,500-character chunking was tuned
against. `.html` when the rendering *is* the point — layout, images, MathJax, anything
interactive — written by hand rather than exported; a Google Docs HTML export is mostly
`<span class="c17">` wrappers that survive tag-stripping as whitespace noise, and `stripHtml`
strips `<script>`/`<style>` but not nav or footers, so a saved web page brings its chrome into
the index. `.pdf` only for papers that cannot be re-authored: extraction is the lossiest path,
and multi-column layouts interleave.
**On 2f.** These are measurements, not estimates — the numbers above came from running the real
documents through the real code. That is the value of testing against real material rather than
a fixture: the truncation was invisible at 3.7 KB, and the *sticky* part of it was invisible
even in the plan until the probe ran. It also closes the precondition on `open-issues.md`
**E4**, which was open because cross-document retrieval had never been exercised — the corpus
was one file, and is now two of wildly different size, which is the harder and more honest case.

**Where the test corpus lives.** `virtual_ta/materials/` is tracked, so the real documents do not
go there. `materials.ts` now honours a **`MATERIALS_DIR`** override, and the local `.env` points
it at `test_material/` — which is gitignored, holds the instructor's scrubbed copies and their
own `manifest.json`, and is where `npm run test:materials` reads from. Nothing about the
deployed corpus is decided by this; 2e still owns that.

**On provenance.** The first reading is the instructor's own prose, but it carries references to
Apple-internal tooling picked up at a workshop. Two separate questions, with different answers.
*Serving it* to enrolled students behind IAP is fine — that is a course reserve. *Committing it*
is the risk: `virtual_ta/materials/` is tracked, and the repo is private **today**, a decision
git history outlives. So either scrub the internal references, or keep the corpus out of git and
load it from `DATA_DIR` — which is exactly 2e. That is why 2e moved from droppable to
recommended: it turns out to be a confidentiality boundary, not just a convenience.

**On 2e.** It is the difference between "adding a reading is a git commit and a deploy" and
"adding a reading is a drag and drop" — but that is no longer the main argument for it, and it is
no longer droppable. The provenance note above is: the corpus needs a home that is not the git
repo. Half the mechanism already exists (`MATERIALS_DIR`, `7e4b2c0`); 2e is the rest — a second
root under `DATA_DIR` so uploads and the shipped fixture can coexist, plus the upload form.

### Step 3 — The project repo in the Computer Lab

| # | Commit | What changes | Files |
|---|---|---|---|
| 3a | **Repo cards on the Computer Lab board** | A small `repos.json` (name, one-line description, URL — `github.com/jadexq/STAT689-project`) rendered as cards, instead of a raw pasted link. Config rather than a board post, so it survives a `boards.json` wipe — and D7 wipes state before the first class. | `virtual_space/server/repos.json`, `server/rooms/MainRoom.ts`, `client/src/main.ts` |
| 3b | **The README joins the corpus** | Fetch the public repo's README at boot and on a slow interval, cache it under `DATA_DIR`, register it as a reading. Then "how do I contribute to the project?" is a grounded answer rather than a shrug. Public repo means no token. **The fetch must not block startup** and must fall back to the cached copy — a GitHub outage cannot be allowed to stop the class server from booting. | `virtual_ta/server/materials.ts`, `virtual_ta/server/repo.ts`, `virtual_ta/server/paths.ts` |

**Written 2026-08-23, after step 2 shipped.** Step 2 moved the ground under step 3 in five
places. Each of these was implicit and would have been *guessed* by anyone picking this up cold.

**1. The README cache is a THIRD root, not the upload root.** 2e made `DATA_DIR/materials` a
corpus root with its own manifest, and `saveUpload()` rewrites that manifest **wholesale** — read,
filter, write. A README writer sharing it would clobber any upload that landed between the read
and the write. So: `DATA_DIR/repos`, its own manifest, one writer each. `ROOTS` is already an
array, so this is one entry. Order is **uploads, then repos, then shipped** — first match wins, so
the instructor can override a fetched README by uploading one under the same id, which is the
right precedence and falls out for free.

**2. 3a mirrors the Library shelf; `MainRoom.ts` is not involved.** The file list above named it,
written before 2b existed. 2b settled the pattern: the space serves it over HTTP, the client
fetches on room entry, and the cards render **above** the pinned posts. So `GET /api/repos` reads
`repos.json` per request — no restart to edit it — and the client renders when
`roomId === "computer-lab"`, exactly as it does for `"library"`. No websocket message, no room
state, nothing in `init`. **Reuse the `.shelf-item` idiom** rather than inventing a third card
style for the third board.

**3. Which URL, and what failure means.** `raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md`
— verified 200 against the real repo, whose default branch is `main`. Use `HEAD`, not a hardcoded
branch, so a default-branch rename does not silently 404. Raw is not the REST API, so the
unauthenticated 60-requests-an-hour ceiling does not apply; no token, as planned. Fetch at boot
and every few hours, never blocking. **On first-ever boot with no network there is no cached copy
to fall back to** — "fall back to the cache" is not a complete rule on day one. Absent README =
the corpus has one fewer reading. That is a normal state, not an error, and must not be a crash.

**4. Only write the cache when the bytes changed.** `indexKey()` is size + mtime, so rewriting a
byte-identical README on every interval would force a full reindex of the whole corpus every few
hours for nothing. Compare first, write only on a difference.

**5. The README is an ordinary reading.** Not `pinned` — it is prose, retrieval handles it, and it
has headings so 2f's chunking applies as-is. Give it `link` = the repo URL so the TA can cite
something clickable.

**Two consequences to accept:**

- **It appears in the Library as well.** 2b's shelf lists everything the manifest reports, so the
  project README shows up on the Library shelf, not only behind the Computer Lab card. That is
  correct — it is course material — but it is a consequence of 2b that step 3 did not intend, and
  it means the Computer Lab card and the Library shelf entry point at the same document by
  different routes.
- **It makes the corpus two searchable documents for the first time.** The fixture corpus is one
  searchable reading plus the pinned agenda, and `materials-test` currently prints *"only one
  searchable document — cross-document ranking is not exercised here"*. 3b turns that on, which is
  what actually closes the precondition on `open-issues.md` **E4** rather than merely arguing it.

**What step 3 cost that the plan did not predict.** Written 2026-08-23, after it shipped.

1. **3b needed a floor on `matchReading`, which was not in the plan.** The plan established that
   the README is an ordinary, non-pinned reading — correct — but `coach.ts` hands a *matched*
   reading over whole and then **stays on it**. A repo whose README is one heading long is a real,
   listed reading that "how do I contribute to the class project?" matches squarely, and matching
   it would have cost the student not just that answer but every later question in the session.
   That is 2f's sticky-`readingId` failure arriving by a second route, and 3b creates it: before
   3b nothing in the corpus was small enough to trigger it. Fixed with `MIN_MATCH_BYTES = 1_000` —
   a document under a kilobyte is left to retrieval instead of being handed over whole. Measured
   on the file, not the extracted text, so a PDF is not parsed just to be rejected.

2. **`materials-test` step 2 was picking the wrong document again.** It used `searchable[0]`, and
   since 3b puts the repos root ahead of the shipped one, `searchable[0]` became the near-empty
   README. Now it ranks by extracted length and tests against whatever actually has prose — the
   same class of fix as the pinned-agenda one in 2c, and the second time root order has silently
   moved this index.

3. **The real README is 17 bytes.** `# STAT689-project`, one heading, no body. So it contributes
   **zero chunks** to the index: the plumbing is right, the reading is listed and it opens from
   the shelf, but the corpus is still effectively one searchable document and `open-issues.md`
   **E4 remains unexercised**. The plan claimed 3b would close that precondition; it closes it
   only when the README is written. The suite now says so out loud and turns the note off by
   itself when there is text to index.

4. **Two lists name the same repository.** `virtual_space/server/repos.json` is what a student
   clicks; `SOURCES` in `virtual_ta/server/repo.ts` is what the TA can quote. Crossing the process
   boundary to share one list would have meant either the TA reading the space's file (a hidden
   filesystem coupling between two processes that otherwise only speak HTTP) or the TA fetching
   from the space at boot (an inverted dependency and a boot-order problem). One line in each
   place, and a comment in each pointing at the other.

**Verified after step 3.** Both dev servers fresh, then: `test:materials` (12 steps), `smoke`,
`integration` (11 steps, +`/api/repos`), `multiuser`, `ghost-test`, and `idle-test` with
`SOLO_WARN_S=4 SOLO_IDLE_S=8 HOME_IDLE_S=10` on the server. Plus two throwaway checks that are
worth naming because they cover states the suites cannot reach: a **cold boot with no network**
(`fetch` stubbed to throw, empty `DATA_DIR`) writes an empty manifest, warns, and leaves the
corpus with zero readings rather than crashing; and **two syncs in a row** leave the cached file's
mtime untouched, which is the whole point of rule 4.

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

**Done 2026-08-23**, all six green in order against a fresh server: `smoke`, `integration`,
`multiuser`, `ghost-test`, `materials`, `idle`. `npx tsc --noEmit` clean in both projects.

**`idle-test` needs three variables on the server, not two** — `SOLO_WARN_S=4 SOLO_IDLE_S=8
HOME_IDLE_S=10`. Its own header says so; running with the first two passes four steps and then
fails step 5 against the real ten-minute window, which reads like a regression and is not one.
Same family as the trap below.

**Run `materials-test` as `npm run test:materials`, never bare.** `virtual_ta` loads `.env` only
through node's `--env-file-if-exists`, which the npm scripts pass and a bare `npx tsx` does not.
Run bare, the suite silently reads the committed fixture instead of the real corpus and reports
**green against the wrong documents** — which it did, once. Same family as the `idle-test` window
variables belonging on the server, and as the `server/env.ts` import-order trap.

| Suite | What it must show after this |
|---|---|
| `smoke` | pin to Library still works; new: pin an announcement, student sees it at home |
| `integration` | board count 2 → 8; the announcement→TA leg from 1e; the corpus over HTTP and the upload guard |
| `multiuser` | unchanged — no new per-student state, which is a consequence of the class-wide decision |
| `materials-test` | agenda parsed with spanning topics and four-digit years, and an undatable row reported rather than guessed; a malformed row still renders; each format (`.md`, `.html`, `.pdf`) extracts to sane text; **a question whose answer lives in the last quarter of the 113 KB reading is answered correctly** — the 2f regression test; README present after 3b |
| `idle-test` | unchanged |

### Held back — feature 4 (handouts with saved answers)

**Superseded 2026-08-23** by the entry at the top of this file. What the instructor actually
wants is not a worksheet with saved answers but per-student *versions* of lecture-notes prose,
judged section by section, to build a preference dataset. The mechanism below was the right guess
about plumbing and the wrong guess about purpose; it is kept because the plumbing argument still
holds. The paragraph below is a 2026-08-22 record, not current intent.

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
