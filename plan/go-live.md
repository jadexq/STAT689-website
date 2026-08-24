# STAT 689 — go-live checklist

**Status:** open · **Written:** 2026-08-23 · **Author:** Claude, for Jade Wang

> **No secrets. No real student names or email addresses.** The repo is private today; git
> history outlives that decision. Real addresses go straight to `gcloud`, never into this file.
> Placeholders below are `<student-N>` / `<StudentNName>`.

> **This is the durable half.** Its companion [`go-live-brief.md`](./go-live-brief.md) holds a
> dated snapshot of deployed state — revisions, env values, commit hashes — and goes stale by
> design. Keep this file; retire that one once the class is running.

**Scope:** everything between "the app is deployed" and "students are using it". Deployment
itself is done — see [`gcp-deployment-plan.md`](./gcp-deployment-plan.md) §15 for how the
service is built and §15l for rollback. Live status of individual issues lives in
[`open-issues.md`](./open-issues.md); do not restate it here.

---

## The one thing that decides everything else

**How many students, and what are their Google addresses?** Nothing below can be finished
without it, and two things depend on the *count* specifically:

- **There are six offices** (`office-s1` … `office-s6` in `server/map.ts`). One is reserved for
  the instructor's test account (`s6`). **Five are available for students.** A sixth student
  needs a new office, which is a map change and therefore a code change, not config.
- **The handout rotation is exact at six** readers against six version-cells and degrades
  correctly below that.

A student with **no slot** is not merely office-less: `studentIndex()` returns `undefined`, so
they are **refused every handout**. Capacity is a coursework question, not a cosmetic one.

---

## Per student — do BOTH, per person

This is D5b, and it has already caused one incident. The two grants live in different places
and fail in ways that look nothing alike:

| Missing | Symptom |
|---|---|
| IAP grant | cannot sign in at all — Google refuses them before the app is reached |
| `STUDENTS` slot | signs in fine, lands in the **Common Area**, refused every handout |

**1. IAP access** — one command per person, additive and safe to repeat:

```
gcloud iap web add-iam-policy-binding \
  --resource-type=cloud-run --service=stat689 --region=us-central1 --project=stat689 \
  --member="user:<student-N>@gmail.com" --role="roles/iap.httpsResourceAccessor"
```

**2. Slot and display name** — `STUDENTS` and `ROSTER`, both set on the service.

> **`--set-env-vars` REPLACES the entire environment.** Adding one student means resending
> every variable, not appending one. Read the current set first:
> `gcloud run services describe stat689 --region=us-central1 --project=stat689 --format=json`
> then edit and resend the whole block. The `^~^` prefix makes `~` the delimiter so the commas
> inside `STUDENTS` and `ROSTER` survive.

`ROSTER` is **required behind IAP** for every address `STUDENTS` assigns — the server throws at
boot rather than showing a student a character placeholder. That is deliberate: a missing name
is a misconfiguration, and a container that will not start is a louder signal than an office
labelled "Student 6".

**3. Confirm the address is a real Google identity.** **`@tamu.edu` is confirmed to work** —
on 2026-08-23 the instructor's TAMU account signed in through IAP and wrote a handout record, so
TAMU is on Google Workspace and students do not need a personal Gmail. Any *other* domain still
has to be checked: verify it appears in Google's account chooser *before* class, not during it.
That cannot be checked from the deploy side — IAP accepts the grant whether or not the identity
resolves, and the failure shows up as a student who simply cannot get in.

---

## Before the first real student signs in — DO IT IN THIS ORDER

The items below are not independent, and two of the dependencies are easy to get backwards:

- **The wipe destroys uploaded course materials.** They live in `DATA_DIR/materials`, which is
  bucket-backed. Upload before the wipe and you upload twice.
- **Only a `--source=.` deploy rebuilds the image.** `gcloud run services update` changes env
  vars against the *existing* image, so a code fix that has not been deployed stays undeployed
  while everything looks freshly updated.

So the ordering is: decide → wipe → deploy → upload → verify → tell them.

### Step 0 — decide, before you ask anyone for anything

- [ ] **Slot count.** Five students fit (`s1`–`s5`); `s6` is the instructor's test account. A
      sixth student needs a new office in `server/map.ts` — a code change, and the top band is
      full at x=1..41, so it is a layout redesign rather than a new entry. **If you have six
      students, the cheap answer is to give up `s6`** and test as a real student instead.
- [ ] **Collect the addresses.** `@tamu.edu` works — proven 2026-08-23, when the instructor's
      TAMU account signed in through IAP and wrote a handout record. TAMU is on Google
      Workspace, so students do not need a personal Gmail. Any *other* domain still has to be a
      real Google identity, and that cannot be checked from the deploy side — verify it appears
      in Google's account chooser before class, not during it.

### Step 1 — wipe the bucket

- [ ] **Confirm zero instances first**, via `gcloud logging read`. `docker/sync.mjs` re-uploads
      the whole tree whenever the newest mtime advances, so a wipe against a warm container
      removes nothing (D7).
- [ ] `gcloud storage rm -r gs://stat689-data/state --project=stat689`
- [ ] This is what removes the three things that have no delete route (E7):
      **`notation-note`**, the test reading — and the urgent one. It is titled "TEST — delete
      before class", but the reason it must go is inside it: it defines a **deliberately
      fabricated term**, the "Reveille factor" for $\sqrt{d_k}$, planted to prove the TA
      grounds its answers in the corpus rather than general knowledge. It does. Left in place,
      the TA will teach a student a term that does not exist, with a citation.
      **Tester's handout responses** for `sample-attention`, so real data does not start life
      mixed with test rows. And **the session logs** from verification.
- [ ] **Do not wipe again after students start.**

### Step 2 — deploy with the class on it

- [ ] Use the full `gcloud run deploy --source=.` form from
      [`gcp-deployment-plan.md`](./gcp-deployment-plan.md) §15, not `services update`. It
      rebuilds, so it also picks up the **E9 fix**, which `stat689-00005-5db` predates.
- [ ] `--set-env-vars` **REPLACES the whole set** — read the live one first and resend
      everything, `^~^` delimiter. See "Per student" above.
- [ ] **IAP grant for every student**, one command each, additive (also above).
- [ ] Check the startup line names the right people:
      `Roster: 6 student slots — N assigned (…)`.

### Step 3 — upload the real course materials

- [ ] Admin panel, signed in as the admin account. **After the wipe, not before.**
- [ ] Until this happens the corpus is the shipped fixture — an 871-byte agenda and a 3.7 KB
      intro pointing at a placeholder `example.edu` link. The TA answers *from the corpus*, so a
      fixture corpus makes its first impression "it does not know anything about this course".

### Step 4 — verify before you send the link

- [ ] **Sign in and ask the TA a real course question.** Confirm it cites a document you
      actually uploaded — this is the only check that the corpus took, and it is also the check
      that would have caught the `notation-note` problem.
- [ ] **One student has actually signed in.** The two grants fail in ways that look nothing
      alike (see the table above), and only a real sign-in exercises both.
- [ ] Confirm the Library shelf shows your readings and nothing titled TEST.

### Step 5 — tell them

- [ ] **The handout data is not anonymous to the instructor.** With one reader per version, the
      version identifies the student. The dashboard says so; they should hear it from you before
      they write a comment they believe is anonymous.
- [ ] The rest of "Tell the students", below.

### Already done — do not redo

- [x] **Stage 7 — all nine checks passed 2026-08-23** (§15i has the table and the evidence).
      Handout responses are durable across a real cold start; the salt is stable across all five
      revisions.
- [x] **Branch merged to main 2026-08-23** (`ab2e47b`, `--no-ff`). Deploy is `--source=.`, so
      production runs a working tree and not a tag — keep the branch pushed so any given
      revision stays reproducible.
- [x] **Second test account retired 2026-08-23** — dropped from `STUDENTS`/`ROSTER` (freeing
      `s1`) and its IAP grant revoked. The accessor list is the instructor's two accounts only.
      The principal is stored **case-sensitively**: `remove-iam-policy-binding` fails with
      "binding not found" unless the member string matches the policy's casing. Their response
      files went with the 21:39Z wipe — an address dropped from `STUDENTS` strands its records
      as a hash nothing can resolve, because `summarise()` maps hash→name by hashing the
      *current* roster forward.

### Knowingly shipping with this open

- **[E9](./open-issues.md#e9) — the chat pane renders no maths.** The TA's output dialect is
  fixed and guaranteed (`normaliseMaths` in `llm.ts`), so equations are correct everywhere they
  are later rendered, including reading digests. But the chat bubble itself still shows the
  markup rather than the formula. **Instructor's decision, 2026-08-23: leave it**, and revisit
  by trying a different LLM. `normaliseMaths` sits on the way out of `chatLLM`, so it is
  provider-agnostic and a switch keeps it.

---

## Tell the students

- **Sign in with the exact Google account you gave me.** If Chrome is already signed into a
  different one it will use that and IAP will refuse with a 403. A separate Chrome profile, or
  an incognito window, is the fix.
- **The first visit of the day takes a few seconds** — the service scales to zero and has to
  cold-start.
- **A tab left idle for 15 minutes disconnects** and offers a Rejoin button. Deliberate: an
  open WebSocket bills an instance, and a laptop left open over a weekend would other­wise cost
  ~48 hours against a free-tier budget of about 50 a month.
- **Every connection is cut at 60 minutes** (a Cloud Run limit). A class longer than an hour
  will hit it. Rejoin works; say so in advance so it reads as expected rather than broken.

---

## Do not change without reading first

- **`maxScale=1` is load-bearing, not a cost setting.** Colyseus room state lives in one
  instance's RAM. Raising it to "handle more students" splits the world in two. One instance
  handles six comfortably.
- **`HANDOUT_SALT` must never change** once responses exist. Every `student_hash` moves with
  it; the app refuses to serve handouts rather than silently orphan the data. It is in Secret
  Manager and always retrievable — there is no reason to ever reissue it.
- **Salt + roster together are the whole secret.** Six known addresses is a trivial space to
  brute-force. The salt protects the records if the bucket leaks; it gives students no
  anonymity from the instructor, and was never meant to.
