# STAT 689 deployment — open issues

**Companion to [`gcp-deployment-plan.md`](./gcp-deployment-plan.md).** That file explains *why*
decisions were made and is written as a narrative. This one tracks *what is still outstanding*
and is meant to be skimmed and ticked off.

**The split exists for a reason.** Status buried in a 1,100-line narrative goes stale: on
2026-08-22 two sections had to be corrected because §14g still read "NOT yet applied" for work
shipped two days earlier and §14i still read "Still open" for closed items. **This file owns
status. The plan owns rationale.** When something is resolved, tick it here and leave the plan's
account of it alone.

Last reviewed: **2026-08-22**

---

## A. Test failures — real, reproducible, pre-existing

Both were found while verifying the pre-Phase-C changes and both were reproduced on a clean
checkout of `09f5e81`, so neither is a regression from that work. Neither was fixed at the time,
because fixing tests inside an auth change is how you lose track of what broke what.

### A1. `ghost-test.ts` asserts a stale entity count
- [ ] **Open**
- **Symptom:** `GHOST TEST FAILED ❌: expected 12 entities, got 10` (and `got 7` at baseline).
- **Cause:** the hardcoded `12` in `virtual_space/scripts/ghost-test.ts:37` was last touched in
  `fd767cb` and was never updated when `60c4e5f` reduced the virtual cast.
- **Second problem underneath it:** the count drifts between runs (7 vs 10) because entities
  accumulate in a long-running server. Hardcoding *any* number is the wrong shape for this
  assertion — it should count what it expects relative to the cast, or run against a fresh room.
- **Resolved when:** the suite passes twice in a row, both against a fresh server and as the
  fourth suite in a sequence.

### A2. `multiuser.ts` fails when it is not run first
- [ ] **Open**
- **Symptom:** `TIMEOUT waiting for: Terra answered Ana (and is free again)`.
- **Reproduction:** passes against a freshly started server; fails when run third, after `smoke`
  and `integration` have already queued LLM work through the same agent. Identical behaviour at
  baseline.
- **Cause:** test isolation, not a product bug — Terra is still busy from the previous suites and
  the wait for "free again" expires.
- **Why it matters anyway:** a suite that only passes in one order will eventually be believed
  when it shouldn't be, and it masked whether the auth change had broken something. It cost real
  time today to prove it hadn't.
- **Resolved when:** `smoke → integration → multiuser → ghost-test` passes end to end in one run.

---

## B. Unverified assumptions

Things currently believed but not demonstrated. Each names what would actually settle it.

### B1. `IAP_JWT_AUDIENCE` has never been checked against a real Google token
- [ ] **Open — highest-risk item in Phase C**
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
- [ ] **Open — must be done before the first student logs in**
- Full detail and commands in plan §14m. The default compute service account holds
  `roles/editor` on the whole project; the app should get a dedicated account with object access
  only.
- **Trap recorded there:** use `roles/storage.objectUser`, not `objectCreator` — overwriting an
  existing object needs delete permission, so `objectCreator` lets the *first* snapshot succeed
  and every later one fail. Verification is **two** `[sync] flushed (changed)` lines, not one.

### D2. Artifact Registry has no cleanup policy — the tightest allowance we have
- [ ] **Open — will bite during Phase C, not after**
- The free allowance is **0.5 GB** and the real app image is **107 MB compressed** (measured,
  plan §14d), so **roughly four `--source` deploys fill it**. Phase C means iterating, so this
  is the first free-tier line we will actually hit.
  *(An earlier version of this entry said ~75 MB and seven deploys. That was the throwaway
  `iap-spike` probe image, not the app.)*
- Nothing prunes automatically, and `gcloud run services delete` does not remove images — that
  gap already caught us once (plan §14l.7).
- The repo's reported size lags deletions; trust `images list`, not `repositories describe`.
- **Resolved when:** a cleanup policy exists on the repo, or pruning is part of the deploy habit.

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

### D3. §6 of the plan is a pre-spike skeleton
- [ ] **Open**
- Steps 2 and 4 describe the abandoned GCS FUSE mount; step 5 omits the OAuth client entirely.
  Pointer blocks warn about this, but the step list itself still reads as if runnable.
- **Resolved when:** §6 is rewritten against §14l/§14m/§14n, or deleted in favour of them.

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
  `ADMIN_EMAILS` will hold `jadexqwang@gmail.com`, so the tamu.edu account arrives as an
  ordinary student and exercises both roles for real.
- **Granting one changes nothing else.** IAP grants are per-account and additive, and the five
  student offices `office-s1`…`office-s5` are static geometry in `map.ts`. `ROSTER` only maps
  email to display name in `identity.ts` — nothing derives rooms from it, so the other four
  offices simply stand empty.
- **Keep real student addresses out of this repo** when the other four arrive. Both files here
  are tracked; use a local file or pass them straight to `gcloud`. Git history outlives an edit.

---

## Resolved

Nothing yet. Move items here with the date and the commit or command that settled them, rather
than deleting them — a record of what turned out to be a non-issue is worth as much as the
open list.
