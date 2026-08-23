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

**3. Confirm the address is a real Google identity.** A `@tamu.edu` address only works if TAMU
is on Google Workspace. Verify it appears in Google's account chooser *before* class, not
during it. This cannot be checked from the deploy side.

---

## Before the first real student signs in

- [ ] **Slot count settled** — five students fit; a sixth needs an office added to the map.
- [ ] **Both grants done for every student** (above), and one of them has actually signed in.
- [ ] **Bucket wiped with zero instances running.** `gcloud storage rm -r gs://stat689-data/state`
      — `docker/sync.mjs` re-uploads the whole tree on mtime advance, so a wipe against a warm
      container removes nothing (D7). Confirm zero instances via `gcloud logging read` first.
      **Do not wipe after students start.**
- [ ] **Retire the second test account.** Removing an address from `STUDENTS` frees the office
      but does **not** remove their response files, and an orphaned hash can never be resolved
      back to a name — `summarise()` maps hash→name by hashing the *current* roster forward.
      Wipe the bucket in the same pass, or accept a permanently anonymous row.
- [ ] **Decide whether the test account keeps IAP access.** Leaving it means that person can
      sign into a space containing real students. Revoking is one command and reversible.
- [ ] **Stage 7 finished.** Seven of nine passed 2026-08-23 (§15i has the table). **Only two are
      left, and both need one thing from you: sign in as the student and answer a handout
      section.** That single act closes check 5 (a real name against a real record) and check 6
      (let it then scale to zero, sign back in, confirm the answer survived). Check 6 is the only
      test of whether handout responses are durable at all — the flush and restore machinery is
      already proven, a *response* is not. The instructor's admin account cannot substitute:
      `?as=` is ignored under IAP, by design.
- [ ] **Branch merged to main.** `multi-user-and-deploy-prep` is pushed; `main` is the one
      lagging. Merge only after Stage 7 passes. Deploy is `--source=.`, so what runs in
      production is a working tree, not a tag — keep the branch pushed so it is reproducible.
- [ ] **Course materials uploaded.** The TA answers from the corpus; a near-empty one makes its
      first impression "it does not know anything about this course".
- [ ] **Test reading `notation-note` removed.** Uploaded 2026-08-23 to prove the corpus path.
      Titled "TEST — delete before class" so it is obvious in the Library. There is no delete
      route (E7), so the bucket wipe above is what takes it — do that wipe *after* this, not
      before.
- [ ] **Decide what to do about [E9](./open-issues.md#e9)** — the TA answers formula questions in
      `\[…\]`, which renders as raw backslashes in the chat. In a course on attention that
      question comes up in week one. The one-line mitigation is to tell the coach prompt to write
      `$…$`; the full fix needs KaTeX in the chat pane.
- [ ] **Class told the handout data is not anonymous to the instructor.** With one reader per
      version, the version identifies the student. The dashboard says so; the students should
      hear it from you before they write a comment they think is anonymous.

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
