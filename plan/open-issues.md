# STAT 689 deployment — open issues

**Companion to [`gcp-deployment-plan.md`](./gcp-deployment-plan.md).** That file explains *why*
decisions were made and is written as a narrative. This one tracks *what is still outstanding*
and is meant to be skimmed and ticked off. Deliberate changes to the app — as opposed to
things that are broken — are planned in [`app-changes.md`](./app-changes.md).

**The split exists for a reason.** Status buried in a 1,100-line narrative goes stale: on
2026-08-22 two sections had to be corrected because §14g still read "NOT yet applied" for work
shipped two days earlier and §14i still read "Still open" for closed items. **This file owns
status. The plan owns rationale.** When something is resolved, tick it here and leave the plan's
account of it alone.

Last reviewed: **2026-08-22** (updated after the TA simplification — see
[`app-changes.md`](./app-changes.md))

---

## A. Test failures

A1 and A2 were found while verifying the pre-Phase-C changes and both were reproduced on a clean
checkout of `09f5e81`, so neither was a regression from that work. Neither was fixed at the time,
because fixing tests inside an auth change is how you lose track of what broke what. **Both were
resolved on 2026-08-22 in `7eedc2a`** — see [`app-changes.md`](./app-changes.md) for the plan
and what the diagnosis got wrong twice. **A3 was dissolved rather than diagnosed** — see below.

### A1. `ghost-test.ts` asserts a stale entity count
- [x] **Resolved 2026-08-22, `7eedc2a`.** The absolute total was removed rather than corrected:
  leftover avatars are seats inside their 120s reconnection window, not ghosts, so a suite that
  fails on them asserts something untrue. It now asserts one avatar per identity (the real
  ghost check, which already passed), exactly 6 agents, and no duplicate human names.
  Green against a fresh server (7 entities) **and** as the fourth suite (9 entities) — two
  different totals, which is the point.
- **Symptom:** `GHOST TEST FAILED ❌: expected 12 entities, got 10` (and `got 7` at baseline).
- **Cause:** the hardcoded `12` in `virtual_space/scripts/ghost-test.ts:37` was last touched in
  `fd767cb` and was never updated when `60c4e5f` reduced the virtual cast.
- **Second problem underneath it:** the count drifts between runs (7 vs 10) because entities
  accumulate in a long-running server. Hardcoding *any* number is the wrong shape for this
  assertion — it should count what it expects relative to the cast, or run against a fresh room.
- **Resolved when:** the suite passes twice in a row, both against a fresh server and as the
  fourth suite in a sequence.

### A2. `multiuser.ts` fails when it is not run first
- [x] **Resolved 2026-08-22, `7eedc2a`.**
- **Symptom:** `TIMEOUT waiting for: Terra answered Ana (and is free again)`.
- **Reproduction:** passes against a freshly started server; fails when run third, after `smoke`
  and `integration` have already queued LLM work through the same agent. Identical behaviour at
  baseline.
- **Cause — and the first two diagnoses were both wrong, which is why this is written out.**
  It is *not* that Terra is still busy and the wait expires (this entry's original claim), and
  it is *not* that she silently drops messages while busy (the second guess, which led to a
  retry that failed 8 times in 180s and thereby disproved itself). Busy-drop is real —
  `scheduleReplies` filters busy agents out and `agentRespond` returns early — but it is not
  what breaks this suite.
  **The actual cause: Terra's position persists between suites and nothing sends her home.**
  Her home is `office-ta`, but smoke and integration walk her elsewhere, and a suite that dies
  mid-run leaves her stranded — she was found in Jade's Office at (39,6) while the TA office
  spans y 14-19. `scheduleReplies` only picks agents whose room matches the speaker's, so Ana
  was talking to an empty room. **No timeout and no retry count could ever have fixed that**,
  which is the useful lesson: a wait that cannot succeed looks exactly like a wait that is too
  short.
- **Fix:** the suite now *places* Terra in the TA office via its own admin connection and waits
  for her to arrive, retrying the send because it is refused while she is busy. It no longer
  assumes where she is.
- **Why it matters anyway:** a suite that only passes in one order will eventually be believed
  when it shouldn't be, and it masked whether the auth change had broken something. It cost real
  time today to prove it hadn't.
- **Verified:** `smoke → integration → multiuser → ghost-test` all green in one run from a
  fresh server, with `✓ Terra is in the TA office (put there by this suite, not assumed)` and
  both students answered on the first attempt.

### A3. `integration.ts` step 6 failed once in two runs
- [x] **Closed 2026-08-22 — the assertion no longer exists. NOT diagnosed.** Step 6 was rewritten
  when the TA became immovable: it now walks only the student, so there is no rendezvous to miss
  and no un-retried `admin send` in the path. The suite has run green five times since. Recording
  this honestly matters: if a comparable two-entity wait is ever added back, this is unproven
  ground, not settled ground. The original analysis is kept below for that day.
- **Symptom:** `TIMEOUT waiting for: Jade & Terra in the Computer Lab` (2026-08-22). The same
  code passed on the run before and the run after, so it is intermittent, not broken.
- **Not caused by the A1/A2 work**: those commits touch only `ghost-test.ts` and
  `multiuser.ts` — no server code, no `integration.ts`.
- **The fragile assertion** (`scripts/integration.ts:137`) waits up to 40s for
  `at(me(), spawnOf("computer-lab")) && at(terra(), spawnOf("computer-lab"))` — i.e. for a
  student **and** Terra to occupy the *same tile* at the same 200 ms poll. It also relies on a
  single un-retried `admin send`, which the server refuses outright while Terra is busy
  (`MainRoom.ts:390`). The adminAck in the failing run said she was walking, so the send was
  accepted; beyond that the logs do not say which of the two never arrived.
- **Do not "fix" this by raising the timeout** until the cause is known — A2 is the cautionary
  tale: there, a wait that could never succeed was mistaken twice for a wait that was too short.
- **Next step when it recurs:** log both positions on timeout so the failure names who was
  missing, instead of only that the pair never met.
- **Resolved when:** either it is reproduced and the cause fixed, or the sequence runs green
  enough times to call the assertion sound. Neither is true yet at 1 failure in 2 runs.

---

## B. Unverified assumptions

Things currently believed but not demonstrated. Each names what would actually settle it.

### B1. `IAP_JWT_AUDIENCE` has never been checked against a real Google token
- [x] **Resolved 2026-08-22, Phase C.** A real Google-minted assertion was driven through
  `MainRoom.onAuth` -> `identify()` -> `verifyIapJwt` on the deployed service: the upgrade
  logged `GET 101`, the client received its first frame, and the audience diagnostic fired
  **zero** times. The deployed value is correct:
  `/projects/343454961473/locations/us-central1/services/stat689`.
- **How, for next time.** No browser is needed. Mint a bearer token for a throwaway service
  account and drive a real WebSocket join:
  `gcloud auth print-identity-token --audiences=<OAUTH_CLIENT_ID>
  --impersonate-service-account=<SA> --include-email`.
  **`--include-email` is not optional.** Without it IAP answers
  `401 Invalid IAP credentials: JWT 'email' claim isn't a string`, which looks like a wrong
  audience and is not. Cost half an hour to diagnose; do not repeat it.
- **`onAuth` runs on the WebSocket upgrade, not on matchmaking** (Colyseus 0.15 `Room._onJoin`).
  A plain `POST /matchmake/joinOrCreate/main` returns 200 without ever calling `identify()`, so
  it proves nothing about auth. The probe must open the socket.
- The 16 cases in `scripts/iap-jwt.ts` mint tokens with a *local* ES256 key. They prove the
  verification logic; they do not prove Google's tokens satisfy it. Claim shapes were copied from
  the real assertion captured in plan §14l.4, but the spike is torn down.
- A wrong audience means **every login fails** with "assertion is for a different service".
- **When to verify: during Phase C, as its first step — it cannot be done before, since it needs
  a live IAP-fronted service.** Order matters: deploy with IAP enabled and `TRUST_IAP_HEADER`
  still **off**, make one request, decode the `x-goog-iap-jwt-assertion` it carries, read its
  `aud`, set `IAP_JWT_AUDIENCE` to exactly that, *then* turn verification on.
- **Self-diagnosing as of `f8a9098`.** A mismatch now logs the expected value, the received
  value and the variable to change, once per process, so step 2 above can be read straight out
  of the server log instead of decoding a token by hand:

  ```
  [identity] IAP_JWT_AUDIENCE does not match the assertion.
               expected: /projects/343454961473/locations/us-central1/services/stat689
               received: /projects/1/locations/us-central1/services/other
               Set IAP_JWT_AUDIENCE to the received value — it is the Cloud Run
               resource path, not the OAuth client ID.
  ```

  This lowers the cost of getting it wrong; it does not make it verified. The item stays open
  until a real Google token has been checked.

### B2. Natural IAP session expiry has only been simulated
- [ ] **Open — low risk, no cheap test**
- §14l.6 established the failure mode by clearing the cookie via
  `/_gcp_iap/clear_login_cookie`, not by waiting for a real expiry. The client sees the same
  thing either way (no valid credential at upgrade time), so app behaviour should be identical.
- Untested: whether Google adds a re-auth prompt at the reload step. A UX detail, not a design
  risk.
- `reauthSettings.maxAge` would compress the test but **is rejected on this project** — see C1.
- **Resolved when:** someone is left logged in past a real session expiry and the auto-reload is
  observed recovering. Realistically this happens by accident during a class.

### B3. The auto-reload guard has not been exercised against a real IAP redirect
- [ ] **Open**
- The reload path (`90bbf1d`) was reasoned from the §14l.6 evidence and typechecks, but the
  five-minute `sessionStorage` guard has not been watched doing its job in the deployed setting.
- **Resolved when:** an expired session in Phase C produces exactly one reload, and a
  deliberately stopped server produces one reload and then the fallback message — not a loop.

### B4. The OAuth client's redirect URI has not been independently confirmed
- [x] **Resolved 2026-08-22, Phase C.** Both `jadexqwang@gmail.com` and `jadewang@tamu.edu`
  completed a real browser sign-in. No `redirect_uri_mismatch`, so the URI registered in the
  Console matches what IAP sends. (The `302` also showed IAP sending exactly the expected
  string, but only a completed sign-in proves Google has it registered.)
- The instructor added the IAP redirect URI in the Console on 2026-08-22. It cannot be verified
  from here: the downloaded client JSON is a creation-time snapshot that never updates, and the
  OAuth client admin API was shut down 2026-03-19 (plan §14l).
- **A dead end worth not repeating:** probing
  `accounts.google.com/o/oauth2/v2/auth` unauthenticated proves nothing. Google defers
  `redirect_uri` validation until after sign-in, so a deliberately bogus URI and the real one
  both return an identical `302`. A negative control is what exposed this; the first probe
  looked like confirmation and was not.
- **Expected value:**
  `https://iap.googleapis.com/v1/oauth/clientIds/343454961473-93ljojsu6q8r5u1ro6lviums1f5j0n74.apps.googleusercontent.com:handleRedirect`
  Typical mistakes: truncated client id, missing `:handleRedirect`, trailing slash, `http`.
- **Resolved when:** a real sign-in completes. If it is wrong the symptom is
  `Error 400: redirect_uri_mismatch`, which names the URI Google received — unlike the spike's
  502, this failure explains itself, which is why it is fine to leave until then.

### B5. `--no-allow-unauthenticated` alongside `--iap` is unverified
- [x] **Resolved 2026-08-22, Phase C.** Deployed with both flags; a bearer-authenticated
  `GET /` returned **200**. No 403, no redeploy needed. The stricter combination works.
- The Phase B spike deployed `iap-spike` *without* `--no-allow-unauthenticated` and IAP still
  intercepted, so that combination is proven. The runbook uses the stricter one, which is what
  Google's design intends: `--iap` grants the IAP service agent `run.invoker`, and denying
  unauthenticated invocation stops anything else reaching the container directly.
- **Symptom if wrong:** sign-in succeeds, then every request 403s.
- **Fallback:** redeploy without the flag. Losing it is a defence-in-depth loss, not a hole —
  IAP still fronts the service either way.
- **Resolved when:** a signed-in request reaches the app with the flag set.

---

## C. Accepted limitations — not bugs, do not re-litigate

Recorded so they are not rediscovered as if they were new problems.

### C1. `reauthSettings` cannot be set on this project
- **Accepted.** Four variants all returned 400 (plan §14l.6). Same organisation-less limitation
  as the OAuth client. Session lifetime is therefore whatever Google defaults to, and cannot be
  shortened for testing or policy.

### C2. `max-instances=1` is a correctness constraint, not a cost one
- **Accepted.** Colyseus room state lives in one instance's RAM. A second instance scatters
  reconnecting students across instances and breaks rooms silently. Either stay at one instance
  or move room state out of process; there is no third option. Fine at five students.

### C3. Close code 1006 is ambiguous by nature
- **Accepted.** The routine request-timeout cut and a dead session are indistinguishable at the
  socket layer. Consecutive-failure count is the only usable signal, which is what `90bbf1d`
  keys on.

---

## D. Debt and prerequisites

### D1. The runtime still inherits `roles/editor`
- [x] **Resolved 2026-08-22, Phase C.** `stat689-app` created and set as the runtime service
  account, holding only `roles/storage.objectUser` on the bucket and
  `roles/secretmanager.secretAccessor` on `ollama-key`. Cloud Build still uses the default
  compute account, as intended.
- **The `objectUser` trap was verified, not just reasoned about.** Two activity rounds spaced
  past the flush window produced **two** `[sync] flushed (changed)` lines, the second
  overwriting `current.tar.gz`. Under `objectCreator` the second would have failed.
- **The full snapshot round trip is also proven**, which the runbook only asked for in part:
  write -> `[sync] SIGTERM — final flush` on scale-down -> restart -> `[sync] restored 1 files
  (1 KB) from gs://stat689-data/state`. Restore is no longer an assumption.
- Full detail and commands in plan §14m. The default compute service account holds
  `roles/editor` on the whole project; the app should get a dedicated account with object access
  only.
- **Trap recorded there:** use `roles/storage.objectUser`, not `objectCreator` — overwriting an
  existing object needs delete permission, so `objectCreator` lets the *first* snapshot succeed
  and every later one fail. Verification is **two** `[sync] flushed (changed)` lines, not one.

### D2. Artifact Registry has no cleanup policy — the tightest allowance we have
- [x] **Resolved 2026-08-22.** A cleanup policy is now active on `cloud-run-source-deploy`
  (`cleanupPolicyDryRun: false`), applied from a JSON policy file:
  - `keep-recent-versions` — KEEP the 3 most recent versions
  - `delete-untagged` — DELETE untagged versions older than 7 days
  - `delete-stale` — DELETE any version older than 60 days

  **Why the live image cannot be collected:** in Artifact Registry a KEEP rule takes precedence
  over a DELETE rule, and `keep-recent-versions` is age-blind. The serving image is always the
  most recent, so it is always kept — including if the service runs untouched past 60 days.
  Verified by applying with `--dry-run` first, then `--no-dry-run`, then re-listing the image.
- **The one real risk left:** rolling back to a revision whose image has aged out of the newest
  three. Pin or re-deploy rather than assuming an old revision can still start.
- The free allowance is **0.5 GB**. After the Phase C deploy the repository held **one** image
  and measured **191.87 MB**, so on the order of **two further deploys** would reach the free
  line — tighter per image than the 107 MB compressed figure in plan §14d suggests, because the
  repository total includes more than the compressed image.
  *(Two earlier versions of this entry were wrong. The first said ~75 MB and seven deploys —
  that was the throwaway `iap-spike` probe image. The second, and a claim made in conversation
  on 2026-08-22, said the repo held **three** images: that came from piping
  `--format='value(IMAGE)'` into `wc -l`, which counted gcloud's "Listing items under…" header
  and a trailing blank line as images. It held one. **Count with
  `--format='value(version)' | grep sha256`, or read `Repository Size` directly.**)*
- Before the policy, nothing pruned automatically, and `gcloud run services delete` does not
  remove images — that gap already caught us once (plan §14l.7).
- The repo's reported size lags deletions; trust `images list`, not `repositories describe`.
- **Cost footnote, because this was over-weighted in conversation.** Beyond the free 0.5 GB,
  Artifact Registry bills on the order of $0.10/GB/month. Ten stored images would be roughly
  six cents a month. Crossing the free line is a tidiness event, not a financial one — the real
  reason to prefer local iteration over redeploying is the ~5-minute build and the loss of
  direct log access, not storage.

### D2b. The Ollama bill has no limit and is outside the GCP cap
- [ ] **Open — accepted for now, revisit before the class scales up**
- `OLLAMA_BASE_URL` defaults to `https://ollama.com/v1`, so the LLM is a hosted external service.
  It works from Cloud Run, but **the GCP budget alert does not cover it.** The spend cap that
  caught the runaway in §14b would not fire on a runaway here.
- **Decision 2026-08-22: use Ollama, set no limit for now.** Recorded deliberately rather than
  overlooked.
- What would make this urgent: more students than the current handful, agents that call the LLM
  in a loop, or any automated traffic. Each turn is one API call per participating agent.
- **Revisit when:** the roster grows beyond the pilot, or before the space is left running
  unattended. **Resolved when:** either a spend limit exists on the Ollama account, or a
  deliberate decision is recorded that none is wanted at the final class size.

### D3. §6 of the plan was a pre-spike skeleton
- [x] **Resolved 2026-08-22.** §6 rewritten as a five-stage runbook against §14f/§14l/§14m/§14n.
  All seven original steps were stale: the FUSE mount was abandoned, the API and bucket setup
  were already done, and it predated the OAuth client, `IAP_JWT_AUDIENCE` and snapshot storage.

### D4. §8, §9 and §14 are three layers of correction
- [ ] **Open — deliberately deferred**
- Superseded sections are patched with markers rather than rewritten. Consolidation was put off
  until Phase B closed so it would not be done twice. Phase B is now closed.

### D5. Student Google addresses — one supplied for testing, four still outstanding
- [ ] **Partially unblocked 2026-08-22**
- Full class is five students plus the instructor = six accounts. Only the accessor grant and
  the optional `ROSTER` display name need an address; **the email alone is sufficient.**
- **Test account: `jadewang@tamu.edu`** — the instructor's second Google account, confirmed a
  real Google identity (it appears in the Google account chooser). Useful beyond convenience:
  `ADMIN_EMAILS` holds `jadexqwang@gmail.com`, so the tamu.edu account arrives as an ordinary
  student and exercises both roles for real.
- **Confirmed in the deployed app 2026-08-22.** Signed in as `jadewang@tamu.edu`: the TA
  responds and **no admin panel is present**. So `ADMIN_EMAILS` is being applied to the
  JWT-verified email rather than to anything client-supplied, and the student path is not
  merely untested-and-assumed-safe. This was the point of using a second real account instead
  of a `?as=` dev identity, which cannot prove anything about the deployed auth path.
- **Granting one changes nothing else.** IAP grants are per-account and additive, and the five
  student offices `office-s1`…`office-s5` are static geometry in `map.ts`. `ROSTER` only maps
  email to display name in `identity.ts` — nothing derives rooms from it, so the other four
  offices simply stand empty.
- **Keep real student addresses out of this repo** when the other four arrive. Both files here
  are tracked; use a local file or pass them straight to `gcloud`. Git history outlives an edit.

### D6. Cloud Run CPU throttling starves the snapshot writer between requests
- [x] **Resolved 2026-08-22.** `gcloud run services update stat689 --no-cpu-throttling` —
  revision `stat689-00002-c5j`, annotation confirmed `false`. Reused the existing image, so it
  consumed no Artifact Registry (image count stayed at 3).
- **Default Cloud Run allocates CPU only while a request is in flight.** `docker/sync.mjs watch`
  is a background loop, so between requests it runs at near-zero CPU. The service currently has
  no `run.googleapis.com/cpu-throttling: 'false'` annotation, so throttling is **on**.
- **Measured, not theorised.** In the D1 verification the flush that happened right after
  activity took **238 ms**; the one that happened while the instance was otherwise idle took
  **10,200 ms**, and an earlier attempt failed outright:
  `[sync] flush failed, will retry: The operation was aborted due to timeout`. Same payload
  size, ~1 KB, both times. It retried and succeeded, so nothing was lost — this time.
- **A stated reason for this that turned out to be wrong.** The original write-up argued the
  TERM-trap flush in `docker/start.sh` would race the shutdown grace period at ten seconds a
  flush. Evidence contradicts it: the shutdown of the throttled revision logged
  `[sync] flushed (sigterm): 1 files, 1 KB -> 1 KB gz in **126ms**`. Cloud Run allocates CPU
  during the shutdown grace period, so that path was never at risk. Recorded because the fix
  was approved partly on this reasoning — the fix is still justified by the measurements above,
  but not by this.
- **What the fix actually buys:** periodic background flushes that complete promptly instead of
  taking ten seconds and occasionally timing out. Lower risk of a retry backlog during a class,
  not protection against a shutdown race.
- **Recommended fix, and it does not cost an image:**
  `gcloud run services update stat689 --region=us-central1 --project=stat689 --no-cpu-throttling`
  This makes a new revision from the **existing** image, so it does not consume Artifact
  Registry against D2.
- **Spend impact is small but real.** CPU is then billed for the instance's whole lifetime
  rather than per request. With `min-instances=0` the instance still scales to zero after
  roughly fifteen idle minutes, so the exposure is bounded by actual class hours. At a handful
  of hours a week this stays inside the 180,000 vCPU-second free allowance (about 50 instance
  hours a month), which is the binding limit.
- **Still worth watching:** confirm an idle-period flush on the new revision completes in the
  same order of time as one during activity. Not yet observed under `cpu-throttling: false`.

### D7. Verification artefacts are in the production bucket — WIPE BEFORE THE FIRST CLASS
- [ ] **Open — action required, and the safe window is now closing**
- The Phase C probes joined the real room as `iap-probe@stat689.iam.gserviceaccount.com`, so
  that identity appears in the session log inside `gs://stat689-data/state/current.tar.gz` and
  in `state/daily/2026-08-22.tar.gz`.
- Not student-visible — it is a log file, not board or conversation state, and no TA
  conversation or board post was created by the probes. But it is the same category of thing
  Stage 1a had to clean up, and the cheapest moment to remove it is before anyone has real
  state worth keeping.
- Browser verification finished 2026-08-22, so the snapshot now also holds the instructor's
  own test session alongside the probe's.
- **The window.** Right now the bucket contains nothing but test artefacts, so wiping is free.
  Once a student uses the space, the same command destroys their work and there is no undo —
  the bucket has no versioning. **After that point this item should be closed as "won't do"
  rather than executed late.**

  ```
  gcloud storage rm -r gs://stat689-data/state --project=stat689
  ```

  The service recreates the prefix on the next flush; `restore` handles a missing snapshot by
  design (proven at the Stage 2 first boot).
- **Resolved when:** either the wipe is done before the first class, or a student has used the
  space and the item is deliberately closed unexecuted.

---

## E. Functional defects found in the deployed app

Product bugs, as distinct from deployment problems. Found by using the thing, not by testing it.

### E1. The TA cannot post to the Library board
- [ ] **Open, but the reported path no longer exists (2026-08-22).** Posting used to mean: ask the
  `announce` skill to compose, review a preview, then pin. The compose step is gone — the
  instructor types the post and pins it (`7845269`). Whatever was failing in the composed path
  cannot fail in a textarea, and `smoke` and `integration` both now assert the pinned text arrives
  at a student's board **worded exactly as typed**.
  **Still open because it was reported against the deployed service and nothing is deployed yet.**
  Close it by pinning one post in the cloud, not by reasoning about it.
- **Symptom as reported:** signed in and walking the space works, but the TA does not manage to
  post anything to the Library board. Everything else seemed fine.
- **Not yet reproduced or diagnosed.** What follows is where to start, not a cause. Do not treat
  any of it as established.
- **The moving parts:**
  - `virtual_space/server/map.ts:53` — `library` is `kind: "special"` with `hasBoard: true` and
    `forcedSkill: "announce"`. So posting is meant to run through the `announce` skill, not
    ordinary chat.
  - `virtual_space/server/boards.ts` — board storage, capped at `MAX_ITEMS = 50`, persisted to
    `DATA_DIR/boards.json`.
  - `virtual_space/server/rooms/MainRoom.ts:418` — falls back to `"library"` when the TA's
    current room has no board.
  - `virtual_space/client/src/main.ts:305` — client-side branch on `r.id === "library"`.
- **Two questions worth answering before touching code:** does it fail the same way locally, and
  does it fail for the admin as well as for a student? The board is written by the TA *on the
  admin's behalf*, so a permission or role check is a plausible place to look — but that is a
  guess, and the local-vs-deployed answer is what makes it cheap to narrow.
- **Worth checking `boards.json` reaches the snapshot.** It lives under `DATA_DIR`, which
  `docker/sync.mjs` watches, so it should — but if posts ever do work and then vanish across a
  restart, that is a different bug from this one and should not be confused with it.
- **Evidence 2026-08-22, after the role change (`dc57bf8`):** the `smoke` suite step 6 —
  compose, preview, pin to the Library, student walks in and sees it — **passes locally**. The
  board path is not broken. This makes "wrong mode, not a defect" the leading explanation, but
  it is not proof: smoke runs locally, the report was against the deployed service. See
  [`app-changes.md`](./app-changes.md), 2026-08-22 entry.
- **Resolved when:** the TA pins a post to the Library board **in the deployed app**, a student
  walking in sees it, and it survives an instance restart.

### E2. A student who messages the TA while they are busy gets silence
- [x] **Resolved 2026-08-22 in `260c578` — by removing the contention, not by apologising for it.**
  The TA office admits one human at a time. A second student never reaches the room to be ignored
  in it: they are stopped at the door and told who is inside. The dropped-message path still
  exists in `scheduleReplies` — it is simply no longer reachable for the TA, because there cannot
  be a second student in the room to trigger it.
  Two consequences worth keeping in view. The wait is now visible but also *longer*: one
  conversation at a time is a real throughput limit with five students, and the lever for that is
  the idle timeout (`SOLO_IDLE_S`), not the door. And the silence is still there for the five
  virtual students, who share rooms freely — nobody has complained, and nothing depends on it.
- **Behaviour.** `MainRoom.scheduleReplies` (line 287) builds the reply set from
  `agents.filter(a => ... && !a.busy)`, and `agentRespond` (line 297) returns early if the agent
  is busy. So a message sent to Terra while she is mid-LLM-call is dropped: **no reply, no
  acknowledgement, no typing indicator.** Nothing tells the student anything happened.
- **The admin path already handles this.** `adminPrivateChat` (lines 339-341) answers
  "(one moment — mid-conversation)" when Terra is busy. Only the student path is silent.
- **Why it will show up.** Five students share one Terra, and each turn is one LLM call taking
  seconds. Two students asking at once is not an edge case, it is a Tuesday. The failure looks
  exactly like "the TA is broken", and the student's only recourse is to guess and retry.
- **Not a regression.** Pre-existing; it simply had not been noticed because single-user testing
  never contends for the agent.
- **Options, cheapest first.** (a) mirror the admin courtesy line for students; (b) a typing/
  busy indicator in the world state — `busy` is currently **not** exposed in `broadcastWorld`;
  (c) queue one pending message per student. (a) is the smallest honest fix; (c) is the one that
  actually matches what a student expects.
- **Deliberately not fixed inside the A1/A2 test work** — a product change made inside a test
  fix is how you lose track of what broke what.
- **Resolved when:** ~~a student messaging a busy Terra gets some visible response, and two
  students asking at once both end up answered or both told to wait.~~ Met: the second student is
  told, at the door, that someone is with the TA and who. Verified by `multiuser` steps 6-7.

### E5. A virtual student stood in the TA office and joined every conversation
- [x] **Resolved 2026-08-22 in `f2f36d3` — reported by the instructor while testing as a student.**
- **What happened.** Sam was standing at (38,16), inside the TA office, so `scheduleReplies` —
  which picks up to two virtual students present in the speaker's room — had him answer alongside
  the TA. The 1:1 conversation was not 1:1.
- **How he got there.** The `integration` suite walked him in to prove the admin's `direct` action
  still worked, and never walked him out. Agent positions persist for the life of the server, so
  a suite that leaves one somewhere makes it a fixture of everyone else's world. **This is A2's
  failure mode exactly** — the one that was supposedly retired by making the TA immovable. It was
  not retired; it was narrowed to the five agents that can still move, and then re-created by the
  very commit that narrowed it.
- **Two fixes, because one would not have been enough.** The server now refuses any
  solo-occupancy room as a destination for an agent, and excludes non-TA agents from replying in
  one — so even an agent placed there by some future path stays quiet. Separately, `smoke` and
  `integration` send agents home before exiting.
- **The canary already existed.** `smoke` step 3 asserts no agent answers from another room; with
  Sam loose in the commons it failed immediately. It had simply never been run after a suite that
  moved an agent and stopped.
- **Resolved when:** ~~a full four-suite run leaves every agent in their own office.~~ Met, checked.

### E3. Bullet lists and headings still arrive as raw markdown in the space chat
- [ ] **Open — cosmetic, low cost to live with, cheap to finish.**
- The chat bubble renders bold, inline code and links (`ea9bb22`), which covers most of what the
  TA writes. Lists (`- `), numbered lists and `##` headings still show their markers.
- Mitigated from the other side: the coach prompt now asks for conversational sentences rather
  than documents, which is why this went from constant to occasional. A prompt is a request, not
  a guarantee — a long enough answer still reaches for a list.
- **Resolved when:** either the renderer handles lists, or a stripping pass runs on TA replies
  before they leave the server. Do not do both.

### E4. Cross-document retrieval has never been exercised
- [ ] **Open — not a defect. A gap in what the evidence can support.**
- `materials/manifest.json` lists **one** reading, so every part of `searchMaterials` that exists
  to choose *between* documents — the idf weighting, the title boost, `MAX_CHUNKS_PER_DOC` — is
  running but has nothing to discriminate. `scripts/materials-test.ts` says so out loud rather
  than passing quietly.
- The risk is not that search breaks; it is that it looks fine now and ranks badly the week the
  instructor adds ten readings, with no baseline to compare against.
- **Resolved when:** the real corpus is in place and a handful of course questions are checked to
  see whether the passage that comes back is the one a human would have picked.

---

## Resolved

Kept in place above with a `[x]` and a dated note, rather than moved here — a record of what
turned out to be a non-issue is worth as much as the open list.

**2026-08-22, Phase C deploy:** B1 (real Google token satisfies `IAP_JWT_AUDIENCE`),
B5 (`--no-allow-unauthenticated` + `--iap`), D1 (least-privilege runtime account, with the
`objectUser` overwrite actually exercised). D3 was resolved earlier the same day.

**2026-08-22, browser verification:** B4 (redirect URI) closed by a real sign-in on both
accounts. The admin/student split was confirmed for real — `jadexqwang@gmail.com` gets the
admin panel, `jadewang@tamu.edu` interacts with the TA and does not (see D5). D6 (CPU
throttling) closed the same day.

Still open: **B2** and **B3** (both resolve by accident during a class), **D7** (bucket wipe,
time-limited — see the note there), **A1**/**A2** (pre-existing test failures), **D2**/**D2b**
(allowances), **D4** (plan consolidation), **D5** (four student addresses), and new from using
the deployed app: **E1** (TA cannot post to the Library board).
