# STAT 689 — Google Cloud deployment plan

**Status:** approved 2026-08-20 · **Phase A built and verified** · **Phase B complete
2026-08-22** · **Phase C deployed and verified 2026-08-22** · **redeploy drafted 2026-08-23
(§15), not executed — what is live is 61 commits behind**

> **Status lives in [`open-issues.md`](./open-issues.md), not here.** This line is a coarse
> marker only. It read "Phase C not started" for several hours *after* Phase C was deployed —
> the same drift that D3 and D4 record. Do not restate per-item status in this file.

**Written:** 2026-08-20 · **Author:** Claude, for Jade Wang
**Scope of this doc:** deploy the virtual space + virtual TA to Google Cloud so ~5 students
can log in with their Google accounts.
**Not in this doc:** application design decisions — those live in
[`app-changes.md`](./app-changes.md).

> **This file is tracked in git.** It was moved out of the gitignored `user_requirements/`
> on 2026-08-22 so that the deployment findings have a backup — they are not recorded
> anywhere else. Two rules follow from that:
>
> - **No secrets.** No OAuth client secrets, API keys, or tokens, not even briefly. A secret
>   committed once stays in the history after it is edited out.
> - **No real student names or emails.** §10 needs the five students' Google addresses to do
>   the IAP grants; keep them in a local file or pass them straight to `gcloud`, and leave
>   placeholders here. The sample records in this doc (`ana@tamu.edu`, "Ana Ruiz", `a@b.com`)
>   are invented and should stay that way.

> **Open problems live in [`open-issues.md`](./open-issues.md)**, not in this file. This one
> explains why decisions were made and reads as a narrative; that one tracks what is still
> outstanding and is meant to be ticked off. Status written into a narrative goes stale — two
> sections here had to be corrected on 2026-08-22 for exactly that reason.

---

## 1. Goal & constraints

| | |
|---|---|
| Users | ~5 students + 1 instructor (admin), all with Google accounts |
| GCP project | `stat689`, on a **personal** Google account (TAMU does not enable GCP) |
| Availability | On-demand. Scale to zero when nobody is in class. |
| Budget | Keep it in the "rounding error" range — target < $5/mo |
| Repo | `github.com/jadexq/STAT689-website` (private) |
| Non-goal | Public access, SSO via TAMU, >1 concurrent class section |

---

## 2. Two things I found while writing this plan

These are new and they change the ordering. Both are in the *app*, not in GCP.

### 2a. Right now, every user is literally the same person

`client/src/main.ts:659` hardcodes the identity:

```ts
room = await client.joinOrCreate("main", ROLE === "admin" ? { role: "admin" } : { name: "Jade" });
```

and `server/rooms/MainRoom.ts:87-95` treats one name as one human — a second joiner with the
same name **evicts the first one's avatar**:

```ts
// One human identity per name: a rejoin replaces any stale entity.
for (const [sid, old] of this.players) {
  if (old.name === name) { this.stopWalk(old.id); this.players.delete(sid); ... }
}
```

Consequence: two students on the app today would fight over one avatar and **share one TA
conversation** (`space:Jade`). Multi-user does not work at all yet — independent of auth,
independent of cloud. This is the single largest item in the plan.

### 2b. Admin is a URL parameter

`client/src/main.ts:46`:

```ts
const ROLE: "student" | "admin" = params.get("role") === "admin" ? "admin" : "student";
```

Any student appending `?role=admin` gets: drive Terra, speak as Terra, post to bulletin
boards, and open the lecture mic. Must be server-side and allowlisted before anyone but you
has the URL.

Neither of these is hard to fix. But they mean **"make it multi-user" is the project, and
"put it on Google Cloud" is the easy half.**

---

## 3. Target architecture

```
  student's browser
        │  https://<service>.run.app
        ▼
  ┌───────────────┐
  │  Google IAP   │  ← Google sign-in; allowlist of 6 accounts
  └───────┬───────┘     injects X-Goog-Authenticated-User-Email
          ▼
  ┌──────────────────────────────────────────────┐
  │  Cloud Run service  "stat689"                │
  │  min-instances=0  max-instances=1            │
  │  session affinity on · timeout 3600s         │
  │                                              │
  │   ┌────────────────────┐  ┌────────────────┐ │
  │   │ virtual_space      │  │ virtual_ta     │ │
  │   │ Colyseus + Phaser  │─▶│ Express        │ │
  │   │ listens on $PORT   │  │ 127.0.0.1:3000 │ │
  │   └────────────────────┘  └────────────────┘ │
  └───────────┬──────────────────────┬───────────┘
              │                      │
     GCS bucket (FUSE)        Secret Manager
     logs / boards / output   OLLAMA_API_KEY etc.
                                     │
                              Ollama Cloud (gpt-oss:120b)
```

### Decisions and why

| Decision | Rationale |
|---|---|
| **One container, both processes** | The space already calls the TA at `http://localhost:3000` (`server/ta.ts:6`). Co-locating = zero networking changes, one IAP config, one cold start. Splitting them would mean the space's cold start chains into the TA's cold start on the first message — strictly worse. |
| **`max-instances=1`** | Not cost — *correctness*. Colyseus room state lives in RAM (`MainRoom.players`, `agents`, `history`). Two instances = two disconnected campuses, and students would randomly land in different ones. At 5 students one instance is ample. |
| **`min-instances=0`** | Your call, and right. Cost drops to near zero; price is a ~10–20 s cold start for the first person to arrive. |
| **IAP directly on Cloud Run** | No load balancer. Saves ~$18/mo and a lot of config. Only viable because we don't need a custom domain or a WAF. |
| **GCS FUSE volume mount, not the GCS SDK** | Mounts the bucket as a directory, so `data/` and `output/` keep working with `fs` calls. Rewriting every write site to the SDK is more code and more risk. |
| **Deploy from source (`gcloud run deploy --source`)** | Cloud Build builds the image server-side. You never need Docker installed locally. |

---

## 4. Phase A — make it genuinely multi-user (local, no GCP)

Everything here is testable on your laptop. **This is what I'd do next, on approval.**

### A1 · Server-side identity  ⚠️ largest item

**New file `virtual_space/server/identity.ts`**

```ts
export interface Identity { email: string; name: string; isAdmin: boolean }
export function identify(req: IncomingMessage): Identity
```

- Reads `x-goog-authenticated-user-email` (IAP format: `accounts.google.com:a@b.com`).
- **Only trusts the header when `TRUST_IAP_HEADER=1`.** Otherwise uses `DEV_USER`
  (default `jade@local`). This is deliberate: an untrusted header is a spoofable login.
- `isAdmin` = email ∈ `ADMIN_EMAILS` (comma-separated env var).
- Display name from a small `ROSTER` map (email → "Sam"), falling back to the email's
  local part. Keeps avatar labels readable.
- **Added 2026-08-22:** an address is also mapped to a *student character* — an office and a
  name — by `STUDENTS` (`virtual_space/server/roster.ts`). Precedence for the display name is
  `ROSTER` → the character they took over → a guess from the address. An address with no
  character still gets in, but lands in the Common Area. See **D5b**: this is a second thing
  every account needs, separate from the IAP grant.

**`virtual_space/server/rooms/MainRoom.ts`**

- Add `onAuth(client, options, request)` → returns `Identity`; store on `client.auth`.
- `onJoin` stops reading `options.role` / `options.name` entirely.
- Dedupe by **email**, not name (keeps the ghost-avatar fix; now correctly allows 5 people).
- `handleAdmin`, `handleMic`, `adminPrivateChat` gate on `client.auth.isAdmin`.
- TA session id becomes `space:<email>` — one conversation per student.

**`virtual_space/client/src/main.ts`**

- `joinOrCreate("main", {})` — no name, no role.
- Role dropdown renders **only if the server says you're admin** (so you can still test as a
  student); it disappears for everyone else.

**Verified by:** a new `scripts/multiuser.ts` that joins as two distinct identities and asserts
both avatars coexist, chat is isolated, the non-admin's `admin` message is rejected, and the two
get separate TA sessions.

> ⚠️ **Depends on an unverified assumption** — see §5. If IAP does not forward its header on the
> WebSocket upgrade, only the *transport* of the email changes; `identity.ts` and everything
> downstream stay as written.

### A2 · Make turn logs survive a restart

**`virtual_ta/server/logger.ts`** — delete `RUN_ID` (line 17). Today logs go to
`data/logs/<run>/<session>.jsonl`, so a restart orphans the history. Change to
`data/logs/<session>.jsonl`, with a `run` field on each line to keep runs distinguishable.
Add `readTurns(sessionId, limit)`.

Since sessionIds become emails (A1), they're now stable across restarts — which is exactly the
precondition the current comment says is missing.

### A3 · Rehydrate a session on cold start

**`virtual_ta/server/session.ts`** — add `ensureSession(id)`: on a miss, read the last
`HISTORY_LIMIT` turns via `readTurns` and restore `history`, plus `mode` and `readingId` from
the most recent assistant turn. Called from the `/api/chat` and `/api/listen` handlers.

Without this, every scale-to-zero makes a returning student a stranger.

**Verified by:** send a message, restart the TA, ask a follow-up that only makes sense with
memory, assert the reply reflects it.

### A4 · Client reconnect

Cloud Run terminates *any* connection at 60 minutes, hard. A 75-minute class **will** drop.

- `MainRoom.onLeave` → `allowReconnection(client, 60)` before cleanup.
- `main.ts` → `room.onLeave(code => ...)` reconnects with backoff, shows a system line, and
  falls back to a fresh join if the token is dead.

**Verified by:** kill and restart the space server mid-session; the browser should recover
without a manual reload.

### A5 · Config surface

One `.env.example` documenting: `TRUST_IAP_HEADER`, `DEV_USER`, `ADMIN_EMAILS`, `ROSTER`,
`PORT`, `TA_BASE_URL`, `DATA_DIR`, `OLLAMA_API_KEY`. `DATA_DIR` is new — it lets `data/` and
`output/` point at the GCS mount in prod and stay local in dev.

**Added 2026-08-22:** `IAP_JWT_AUDIENCE`, `SNAPSHOT_URI`, `STUDENTS` (which student character
each address controls — see **D5b**), and the idle windows `SOLO_WARN_S`, `SOLO_IDLE_S`,
`HOME_IDLE_S`. `virtual_space/.env.example` is the current list; this paragraph is not.

**One trap worth knowing:** `.env` is loaded by `server/env.ts`, which **must stay the first
import** of the process. It was a `dotenv.config()` call partway down `index.ts` until
2026-08-22, and because ES imports are hoisted, every module reading `process.env` at module
scope had already run — so `.env` was silently ignored for exactly the settings that are read
once at startup. It never affected the cloud, where Cloud Run sets real environment variables,
which is why it survived this long.

### A6 · Container

- `Dockerfile` (multi-stage, `node:25-slim`): install both projects, run the esbuild client
  bundle, prune dev deps. Note: the two projects differ (space = CJS + `tsx` + Express 4;
  TA = ESM + native type-stripping + Express 5) — the image keeps them separate, no merging.
- `docker/start.sh`: start the TA, wait for `/api/health`, start the space, `wait -n` so the
  container exits if *either* process dies.
- `.dockerignore`: exclude `data/`, `output/`, `.env`, `ref/`, `user_requirements/`.

**Verified by:** `docker build` + `docker run -p 8080:8080` locally, then the full smoke test
against the container.

**Local dev is unchanged throughout.** `npm run dev` in each folder still works exactly as now.

---

## 5. Phase B — the spike (~1 hour, throwaway)

Two things I will not guess at. A hello-world Cloud Run service, no app code:

1. **Does IAP forward `x-goog-authenticated-user-email` on the WebSocket upgrade request?**
   All of A1 rests on it. If not, the fallback is: the browser fetches a short-lived signed
   token over plain HTTP (where the header definitely arrives) and passes it in the join
   options. Contained change; `identity.ts` is unaffected.
2. **Does GCS FUSE tolerate append-only JSONL writes?** FUSE has weak append semantics. One
   writer probably makes it fine — "probably" is not something to discover during your first
   class. If it fails, logs buffer in memory and flush as whole objects on an interval.

---

## 6. Phase C — deploy (runbook, rewritten 2026-08-22)

> ### ⚠ Superseded on one point, 2026-08-23 — the roster variables below are wrong
>
> Stage 2, stage 3 and stage 4 step 4b name **`jadewang@gmail.com`** as the test-student account.
> That address has no IAP grant and is not used. It was also never deployed: the live service was
> brought up with no `STUDENTS` variable at all, so these lines are a stale instruction rather than
> a record of what happened.
>
> The correct pair — `STUDENTS` **and** `ROSTER`, for two real test accounts — is in **§15h**.
> Left in place rather than edited out because `open-issues.md` D5b quotes this history, and
> because rewriting a runbook in place is what D3 records going wrong. Read §15h instead.

The original §6 was written before the Phase B spike and every one of its seven steps was
stale — the FUSE mount it deploys was abandoned, three of its APIs and both its setup steps
are already done, and it predates IAP's OAuth client, `IAP_JWT_AUDIENCE` and the snapshot
storage. This replaces it. Run top to bottom.

**Constants used below**

| | |
|---|---|
| project / number | `stat689` / `343454961473` |
| region | `us-central1` |
| service | `stat689` |
| bucket | `gs://stat689-data` (exists; snapshots under `state/`) |
| OAuth client | `343454961473-93ljojsu6q8r5u1ro6lviums1f5j0n74.apps.googleusercontent.com` |
| admin | `jadexqwang@gmail.com` |
| test student | `jadewang@tamu.edu` |

### Stage 0 — preconditions (all already satisfied as of 2026-08-22)

- [x] APIs enabled: `run`, `iap`, `secretmanager`, `artifactregistry`, `cloudbuild`, `storage`
- [x] `gs://stat689-data` exists
- [x] Secret `ollama-key` exists, verified byte-identical to the local key
- [x] OAuth client created; redirect URI added by hand (unconfirmed — open issue B4)
- [x] `main` fast-forwarded to a known-good state
- [x] Instructor go-ahead on spend

### Stage 1a — clear the spike's leftover snapshot

`gs://stat689-data/state/current.tar.gz` and `state/daily/2026-08-21.tar.gz` are left over from
the Phase B container round-trip. **`sync.mjs restore` runs before the servers start, so the
first production boot would restore that test state** — the spike's conversation and board post
would be sitting in the class space on day one.

```
gcloud storage rm -r gs://stat689-data/state --project=stat689
```

Restoring-from-empty is the normal first-boot path and `sync.mjs` handles it by design (a
missing snapshot exits 0 rather than boot-looping). Restore still gets proven properly at
Stage 4 step 6.

### Stage 1 — the runtime service account (§14m), BEFORE the first deploy

Doing this first avoids deploying twice. This is the *runtime* identity; Cloud Build keeps
using the default compute account, which is why its `roles/editor` must **not** be stripped.

```
gcloud iam service-accounts create stat689-app \
  --display-name="STAT689 app runtime" --project=stat689

gcloud storage buckets add-iam-policy-binding gs://stat689-data \
  --member="serviceAccount:stat689-app@stat689.iam.gserviceaccount.com" \
  --role="roles/storage.objectUser"

gcloud secrets add-iam-policy-binding ollama-key \
  --member="serviceAccount:stat689-app@stat689.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" --project=stat689
```

**`objectUser`, not `objectCreator`.** Overwriting an existing object needs delete permission,
so `objectCreator` lets the *first* snapshot succeed and every later one fail — the worst
possible failure shape. Without the `secretAccessor` grant the container cannot read the key
and never starts.

IAM propagation lags. If the next stage fails on permissions, wait a minute and retry rather
than re-granting.

### Stage 2 — deploy

```
gcloud run deploy stat689 \
  --source=. --region=us-central1 --project=stat689 \
  --service-account=stat689-app@stat689.iam.gserviceaccount.com \
  --min-instances=0 --max-instances=1 \
  --timeout=3600 --memory=1Gi \
  --no-allow-unauthenticated --iap \
  --set-secrets=OLLAMA_API_KEY=ollama-key:latest \
  --set-env-vars='^~^TRUST_IAP_HEADER=1~IAP_JWT_AUDIENCE=/projects/343454961473/locations/us-central1/services/stat689~ADMIN_EMAILS=jadexqwang@gmail.com~STUDENTS=jadewang@gmail.com=jade~HANDOUT_SALT=<generate once, see below>~SNAPSHOT_URI=gs://stat689-data/state~LLM_PROVIDER=ollama~OLLAMA_BASE_URL=https://ollama.com/v1~OLLAMA_MODEL=gpt-oss:120b'
```

> ### ⚠ `STUDENTS` and the IAP grant are a PAIR — one without the other looks like a bug
>
> Every student needs **two** things, in two different places, and the failure modes look
> nothing alike:
>
> | Missing | Symptom |
> |---|---|
> | the IAP grant (stage 3) | cannot sign in at all — Google refuses them |
> | the `STUDENTS` entry (here) | signs in fine, and lands in the **Common Area** instead of their own office |
>
> The second is the dangerous one. Nothing is broken, nothing is logged to the student, and it
> reads as "the app put me in the wrong place" rather than "one environment variable is
> missing". The server does warn — `[roster] <address> has no student slot` — but only in the
> Cloud Run log, which nobody is watching mid-class.
>
> **Do both, together, per person.** Tracked as `open-issues.md` **D5b** for the instructor's
> own test account and **D5** for the four real students.

Why each flag that is not obvious:

- **`STUDENTS=jadewang@gmail.com=jade`** assigns a student character (an office and a display
  name) to an address; see `virtual_space/server/roster.ts`. The value containing a second `=`
  is fine — gcloud splits a `KEY=VALUE` pair on the *first* `=` only. Slots are `s1`…`s5` and
  `jade`. Assigning a slot **removes its AI stand-in**: that office belongs to a person now.

- **`HANDOUT_SALT`** salts the student hash on every feedback record. Generate it once with
  `openssl rand -hex 24`, **write it down with the other secrets**, and never change it. Without
  it the handout routes answer 503 (deliberately — an unsalted hash over six known addresses is
  a lookup table). Changing it after students have answered would move every hash and orphan
  every recorded version assignment and every grade; the app now refuses to serve handouts when
  the salt disagrees with the data on disk, but only the old value actually recovers it. It must
  contain no `~`, or it will break the alternate delimiter below. See open-issues **D8**.
- **`--max-instances=1`** is correctness, not cost. Colyseus room state lives in one instance's
  RAM; a second instance scatters reconnecting students and breaks rooms silently.
- **`--timeout=3600`** is the maximum. B3 proved the cut is wall-clock and unavoidable, so this
  makes it once or twice a class instead of every two minutes.
- **No `--add-volume`.** The FUSE mount is gone (§14f). `SNAPSHOT_URI` drives `docker/sync.mjs`
  instead: restore before boot, periodic flush after.
- **No `--session-affinity`.** Redundant at one instance; add it only if that ever changes.
- **`^~^` delimiter, not `^@^`.** gcloud's alternate delimiter must appear in *no* value
  (`gcloud topic escaping`). `@` is disqualified by `ADMIN_EMAILS=jadexqwang@gmail.com` — it
  would split the email mid-value. `~` appears in none of these values. Quoted, so the shell
  leaves it alone.
- **`DATA_DIR`, `PORT`, `TA_BASE_URL` are already baked into the Dockerfile** — do not pass them.
- **`--no-allow-unauthenticated` is the one flag combination the spike did NOT verify.** It is
  what Google's design intends — `--iap` grants the IAP service agent `run.invoker`, and this
  stops anything else invoking the service — but `iap-spike` ran without it. If sign-in
  succeeds and then every request 403s, this is the flag: redeploy without it, confirm, and
  record the result against open issue B5.

**If the audience is wrong, the log says so.** `f8a9098` prints the expected and received values
once. Read it, redeploy with the corrected string. That diagnostic exists so this does not need
a two-stage deploy — but if a single failed login is unacceptable, deploy once with
`TRUST_IAP_HEADER=0`, capture a real assertion, then re-deploy with it set.

### Stage 3 — point IAP at the OAuth client, then grant access

The client attaches at the **project** level, not the service. The service-level PATCH that
looks right returns 400 (§14l).

```
# settings.yaml written outside the repo, chmod 600, deleted afterwards:
#   access_settings:
#     oauth_settings:
#       client_id: "…"
#       client_secret: "…"
gcloud iap settings set <path>/settings.yaml --project=stat689 --resource-type=iap_web

gcloud iap web add-iam-policy-binding --resource-type=cloud-run \
  --service=stat689 --region=us-central1 --project=stat689 \
  --member=user:jadexqwang@gmail.com --role=roles/iap.httpsResourceAccessor

gcloud iap web add-iam-policy-binding --resource-type=cloud-run \
  --service=stat689 --region=us-central1 --project=stat689 \
  --member=user:jadewang@tamu.edu --role=roles/iap.httpsResourceAccessor

# The instructor's test-STUDENT account. Pairs with STUDENTS=…=jade in stage 2 —
# see the warning box there. Without this grant it cannot sign in; without the
# env var it signs in and lands in the Common Area.
gcloud iap web add-iam-policy-binding --resource-type=cloud-run \
  --service=stat689 --region=us-central1 --project=stat689 \
  --member=user:jadewang@gmail.com --role=roles/iap.httpsResourceAccessor
```

`gcloud run services add-iam-policy-binding --role=roles/iap.httpsResourceAccessor` **errors** —
it must be `gcloud iap web add-iam-policy-binding`. Add the other four students the same way,
one command each — **and add each of them to `STUDENTS` at the same time**, or they sign in to
the wrong room. Updating `STUDENTS` means `gcloud run services update stat689 --update-env-vars`,
which is a new revision; the IAP binding is not.

### Stage 4 — verify, in this order

1. **`curl -sI <url>` → 302 to `accounts.google.com`.** A **502 with
   `x-goog-iap-generated-response: true`** means the OAuth client did not attach — redo stage 3.
2. **Sign in as the admin.** A `redirect_uri_mismatch` here is open issue B4: the error names the
   URI Google received, so fix it in the Console and retry.
3. **Check the startup log** for `Auth: IAP, JWT-verified (aud: …)`. If instead it shows the
   audience diagnostic, take the "received" value and redeploy.
4. **Sign in as `jadewang@tamu.edu`** in a separate profile. It must arrive as a *student* — no
   admin panel — which is the real point of using a second account. It has no `STUDENTS` slot,
   so the Common Area is the *correct* landing spot for this one.
4b. **Sign in as `jadewang@gmail.com`.** This one must land in **Jade's Office**, not the Common
   Area. If it lands in the Common Area the IAP grant worked and the `STUDENTS` variable did
   not — see the warning box in stage 2. Check the startup log line
   `Roster: 6 student slots — 1 assigned (Jade), …`; "0 assigned" names the problem outright.
5. **One full TA conversation and one board post**, to prove the Ollama key resolved from Secret
   Manager.
6. **Snapshot round trip.** Confirm **two** `[sync] flushed (changed)` lines in the log, not one
   — one proves nothing, since `objectCreator` would also produce exactly one.
7. **Leave a tab open past the timeout.** Expect a 1006 close and a silent reconnect with the
   avatar in place. That is B3 confirmed in production.

### Stage 5 — afterwards

- **Prune Artifact Registry.** 0.5 GB free, ~107 MB per image, so about four deploys fills it and
  nothing prunes automatically (open issue D2).
- **Tick off** B1, B3, B4, D1 and D5b in `open-issues.md`.
- Add the remaining four students when the class starts — **IAP grant *and* a `STUDENTS` slot
  each**, per the warning box in stage 2.

## 7. Testing

Written 2026-08-20 as a plan; **rewritten 2026-08-22** to list what actually exists. All paths
are relative to `virtual_space/` unless stated.

| Suite | Covers | Run it with |
|---|---|---|
| `scripts/smoke.ts` | core loop — movement, same-room isolation, walking in to the TA, a typed board post reaching a student | `npx tsx scripts/smoke.ts` |
| `scripts/integration.ts` | TA↔space wiring; nobody can be moved; sealed rooms; speak-as-TA; directing a stand-in | as above |
| `scripts/multiuser.ts` | two identities coexist; admin is granted not claimed; the 1:1 door; separate TA sessions | as above |
| `scripts/ghost-test.ts` | a rejoin replaces a stale avatar rather than adding one | as above |
| `scripts/idle-test.ts` | the TA office frees on silence; idling anywhere else walks you home | **needs short windows on the SERVER**: `SOLO_WARN_S=4 SOLO_IDLE_S=8 HOME_IDLE_S=12 npm run dev` |
| `../virtual_ta/scripts/materials-test.ts` | the material index and passage search | `npx tsx scripts/materials-test.ts` — no LLM, no server |
| Container smoke | A6 | |
| Post-deploy manual | IAP login, one student, one full chat, one board post | §6 stage 4 |

**Run the first four against a FRESH space server, in that order.** Agent and avatar state
persists for the life of the process, and a suite that only passes in one order will eventually
be believed when it should not be (`open-issues.md` A2, E5).

**The two env-tunable ones are deliberately outside the default run.** Their real windows are
minutes long, and a test that sleeps for minutes gets skipped — which is worse than not having
it. Better an honest opt-in than a suite everyone learns to interrupt.

---

## 8. Cost

> **Superseded by §14h.** The estimates below predate the free-tier
> investigation and the $0 spend cap. Kept for the record.

| | Estimate |
|---|---|
| Cloud Run (scale-to-zero, a few class hours/week) | $0–2 /mo |
| Cloud Storage (a few hundred MB) | < $0.10 /mo |
| Artifact Registry | < $0.50 /mo |
| IAP | free |
| **Total GCP** | **~$1–3 /mo** |
| Ollama Cloud | unchanged, billed separately |

---

## 9. Risks

> **Revised by §14e.** The GCS FUSE row is now settled (it fails), and
> instance-hours and egress — absent below — are the two largest risks.

| Risk | Severity | Mitigation |
|---|---|---|
| IAP header absent on WS upgrade | High | Phase B spike; signed-token fallback |
| GCS FUSE + JSONL append | Medium | Phase B spike; buffer-and-flush fallback |
| Cold start (~10–20 s) for the first arrival | Low | Set `min-instances=1` for the hour around class if it annoys you (~$5/mo) |
| 60-min connection cap | Low | A4 reconnect |
| Ollama Cloud latency/outage from GCP | Low | Already the failure mode locally; `TA_OFFLINE_MSG` handles it |
| `max-instances=1` becomes a ceiling | Low | Not at 5 students. A real fix needs external room state — out of scope. |

---

## 10. What I need from you

1. **The Google account that should be admin** — presumably your personal one, since `stat689`
   isn't on TAMU.
2. **The 5 students' Google addresses.** Each one needs an IAP grant *and* a `STUDENTS` slot
   assignment (`s1`…`s5`), which are separate places — see the warning box in §6 stage 2. A
   `ROSTER` display name is optional and can come later; until then the student shows as the
   character they took over (Sam, Ben, …).

Neither blocks Phase A; both block Phase C.

---

## 11. Explicitly out of scope

- Reopening the Classroom skill (on hold at your instruction; `CLASSROOM_OPEN` /
  `CLASSROOM_ENABLED` both `false`).
- Materials-first retrieval improvements (`matchReading` picks one reading by title-word
  overlap and returns nothing on a tie; `loadReading` caps at 28k chars). Real workstream,
  separate from deployment.
- The four design-system workstreams (TA output restyling, avatar palette, side-panel,
  canvas art).
- Custom domain, TAMU SSO, >1 concurrent section, horizontal scaling.

---

## 12. Approval

- [x] Architecture in §3 approved
- [x] Phase A scope (A1–A6) approved
- [ ] Admin account + student emails supplied
- [x] Proceed

---

## 13. Phase A — what was built (2026-08-20)

All of A1–A6 is done, typechecks clean, and passes every test below.

| Item | Landed in |
|---|---|
| A1 identity | `virtual_space/server/identity.ts` (new), `rooms/MainRoom.ts` (`onAuth`, dedupe by email, admin gating, `taSessionKey`), `client/src/main.ts` |
| A2 replayable logs | `virtual_ta/server/logger.ts` — `RUN_ID` out of the path, `readTurns()` in |
| A3 rehydration | `virtual_ta/server/session.ts` — `ensureSession()`; wired into both API handlers |
| A4 reconnect | `MainRoom.onLeave` → `allowReconnection(120s)`; client `wireRoom()` + backoff |
| A5 config | `paths.ts` in both projects (`DATA_DIR`), root `.env.example` |
| A6 container | `Dockerfile`, `docker/start.sh`, `.dockerignore`; `tsx` moved to runtime deps |

**Tests** — all passing:

| | |
|---|---|
| `virtual_ta`: `npx tsx scripts/memory.ts` | new — A3, no server, no LLM calls |
| `virtual_space`: `npx tsx scripts/multiuser.ts` | new — A1 |
| `virtual_space`: `npx tsx scripts/smoke.ts` | unchanged behaviour, passes on host **and** in the container |
| `virtual_space`: `npx tsx scripts/integration.ts` | unchanged behaviour |
| container restart | board post, generated output and TA history all survived; log showed `restored 2 turns for space:jade@local (mode: coach)` |

### Two real bugs the container run exposed

1. **Both servers read `$PORT`.** Cloud Run injects it, so the TA grabbed
   8080 and the space had nothing to bind. Fixed in `docker/start.sh`,
   which gives the TA an explicit internal port. This would have failed on
   the very first deploy.
2. **`OUTPUT_DIR` was never created.** `announce.ts` writes into `output/`
   without `mkdir`; locally that worked only because the folder already
   existed in the repo. On any fresh `DATA_DIR` — i.e. every new container
   — composing a board post failed. Fixed in `initStorage()`.

### Changed behaviour worth knowing

- **`?role=admin` no longer does anything for a student.** The dropdown is
  hidden unless the account is in `ADMIN_EMAILS`, and the server refuses
  admin commands from anyone else.
- **A seat is held for 2 minutes after an ungraceful disconnect.** Good for
  class (the avatar does not vanish and respawn); it means the end-to-end
  tests are not idempotent inside that window — restart the space server
  between runs, as the README already advised.
- **Old TA logs under `data/logs/<run>/` are not replayed.** New history
  goes to `data/logs/<session>.jsonl`. Nothing was deleted.

### Still blocked

Phase B (the spike) needs GCP. Phase C needs the spike **and** the admin
account plus the five student addresses (§10).

**Committed 2026-08-20** as `e83a46b` on branch `multi-user-and-deploy-prep`
(29 files, +1045/-134), pushed. Two corrections to earlier notes here: the
cast reduction (virtual students in `agents.ts`/`map.ts`, not the human
roster) was already committed in `60c4e5f`, and git runs
fine under `~/Documents` — the scratchpad-mirror workaround is not needed.

---

## 14. Phase B addendum — free-tier investigation (2026-08-20)

**This section supersedes §8 (Cost) and revises §9 (Risks).** It also settles one of the
two Phase B unknowns and closes the storage question in §3.

> **Status, 2026-08-21.** The $0 cap described in 14b was **lifted and replaced with $5**.
> Everything below that reads as blocked is no longer blocked; see §14l for what was run
> against it. The 14b incident write-up is kept deliberately — a paused project is
> indistinguishable from a broken container, and that cost an hour once.

### 14a. What the spike actually established

**B1 (GCS FUSE + append-only JSONL) is answered: no.** One probe run completed before the
project was paused. It mounted the bucket fine, `mkdir` fine, cold-read fine — and then
2,000 sequential `fs.appendFile` calls to one JSONL drew **358 HTTP 429 retries** from GCS
and had not finished after **9 minutes**. The same 2,000 appends take under a second on
local disk. The mechanism: GCS objects are immutable, so every "append" through FUSE is a
full object rewrite, and GCS allows roughly **one update per second per object**.

The follow-up probe (a rate ladder at 10/2/1/0.5 appends per second, plus a batched
"600 events as 6 flushes" test) is written and verified locally but never ran, and **is now
moot** — the free-tier op budget below rules out per-event writes on stricter grounds than
latency. No further cloud spend is needed to close B1.

**B2 and B3 remain unanswered.** Whether IAP forwards `x-goog-authenticated-user-email` on
the WebSocket upgrade, and whether the browser reconnects through IAP silently after Cloud
Run cuts the connection, both still need a live deploy. The probe service is written
(`scratchpad/iap-spike`, Express + `ws`, dumps headers on both a plain GET and the upgrade)
and verified locally; it has never successfully started on Cloud Run.

### 14b. The spend cap incident

Roughly ten minutes into the first probe run, **a $0 spend cap on the billing account was
enforced** and every Cloud Run container in the project began dying within seconds, with no
container logs and the message `failed with exit code: 0 and message: Unknown error`. About
an hour was spent chasing this as a container bug before the cause surfaced. For the record,
so nobody repeats it: the exact image Cloud Build produced was pulled and run locally on
`linux/amd64` and behaved perfectly — a 60-second sleeper that Cloud Run killed in 5 seconds
ran the full 60. **A paused project looks exactly like a broken container.**

A $0 cap does not mean "stay inside the free tier". The free tier is applied as a
*spending-based discount at billing time*, so usage accrues first; the cap fires on the first
chargeable cent and pauses everything, including services well inside their own allowances.

### 14c. The free tier, verified

Per month, **aggregated across the whole billing account** — `stat689` shares this pool with
`segmentation-380615` and `engaged-cargo-380615` (both dormant: Compute, Notebooks, Cloud SQL
and GKE are all disabled in both, so nothing is running there).

| Resource | Always-free allowance | Note |
|---|---|---|
| Cloud Run compute | 180,000 vCPU-s + 360,000 GiB-s | **~50 instance-hours/month** at 1 vCPU / 2 GiB |
| Cloud Run requests | 2,000,000 | never a concern at our scale |
| **Cloud Run egress** | **1 GiB from North America** | the tight one |
| Cloud Storage | 5 GB-months | **US regions only** — `us-central1` qualifies |
| GCS Class A ops (writes, lists) | 5,000 | |
| GCS Class B ops (reads) | 50,000 | |
| Artifact Registry | 0.5 GB | |
| Cloud Build | 2,500 build-min | |
| Cloud Logging | 50 GiB per project | |
| Secret Manager | 6 active versions, 10,000 accesses | |
| **IAP on Cloud Run** | **free, and needs no load balancer** | confirmed — retires a §9 cost risk |

### 14d. What our design actually generates

Measured from the real payloads and the real built image. Assumes 6 students + instructor,
a 75-minute class, each person walking ~15% of the time.

| | Measured |
|---|---|
| `client/static/bundle.js` | **6.84 MB — not minified** (`build:client` passes no `--minify`) |
| `broadcastWorld` payload | **1,029 bytes** — all 12 entities, to all 7 clients, every step |
| Movement tick | every **~135 ms** per moving entity (130 ms click-walk, 140 ms key-repeat) |
| `logEvent` JSONL line | 111 bytes |
| App container image | 587 MB uncompressed, **107 MB compressed** (what Artifact Registry bills) |

Per class: **30,000 move events**, **206 MB of WebSocket traffic**, **41 MB of page loads**
— **247 MB of egress for one class meeting.** The 1 GiB monthly allowance is gone after four.

### 14e. Risk register (replaces the storage/cost rows of §9)

**① Cloud Run instance-hours — the one that will actually bite.** Google's docs are explicit:
*"A Cloud Run instance that has any open WebSocket connection is considered active, so CPU is
allocated and the service is billed as instance-based billing."* Idle does not matter; an open
socket bills.

| Scenario | Hours/month | vs 50 h budget |
|---|---|---|
| Scheduled class time only | 11 h | 22% |
| Plus ~10 h/week of student use | 54 h | **108%** |
| **One student forgets a tab over a weekend** | 48 h | **96%, by itself** |
| One tab left open all month | 730 h | **15× over** |

**The A4 reconnect logic makes this worse.** The client retries with backoff indefinitely and
the server holds a seat for 2 minutes, so a forgotten tab reconnects forever and bills forever.
Related: Cloud Run's request timeout **defaults to 5 minutes** (max 60) and must be raised
explicitly — and raising it is exactly what makes forgotten tabs immortal.

**② Egress (1 GiB/month) — will be exceeded, easiest to fix.** 206 of the 247 MB per class is
`broadcastWorld` re-sending all twelve entities to all seven clients on every tile step, when
the moved entity is the only thing that changed.

**③ GCS Class A ops (5,000/month).** 30,000 per class under the current design. Fixed by 14f.

**④ Artifact Registry (0.5 GB).** Measured at 107 MB compressed per image — about four
independent images fit, and more revisions than that because layers are shared. Risk is only
slow accumulation across a semester of deploys; prune old revisions.

**⑤ Cloud Build, Logging, Secret Manager, GCS storage, IAP.** No realistic risk at our scale.

### 14f. Revised storage design — no FUSE mount

Local disk is the source of truth during a session; GCS holds a snapshot, written rarely.

- **On startup:** download one snapshot object, unpack into `data/`. One Class B op.
- **During the session:** everything local. `logger.ts`, `session.ts` and `boards.ts` are
  unchanged — the code already built and tested in Phase A keeps working as-is.
- **Every few minutes if dirty, and on `SIGTERM`:** pack `data/` into **one** object and
  upload. One Class A op.

At 5-minute flushes over ~56 active hours that is **~670 writes/month** against 5,000, and one
write per five minutes is far under the 1-write-per-second rate limit — both problems close for
the same reason. Two consequences:

- **`paths.ts` must be rewritten.** A5 built it to point `DATA_DIR` at the mount; it now points
  at local disk and a new sync module owns the GCS relationship. This is the one piece of
  Phase A that this addendum invalidates.
- **The GCS FUSE volume mount leaves the deploy entirely**, taking the gen2 CSI machinery with it.
- Cloud Run's local filesystem is **in-memory** and counts against instance RAM. A class
  generates a few MB, but the sync must rotate what it keeps locally rather than letting it grow.

Tradeoff: a hard crash loses up to one flush interval. `SIGTERM` covers graceful shutdowns; a
2-minute interval during class costs ~1,700 ops/month and is still well inside budget.

### 14g. Three fixes — identified 2026-08-20, ALL APPLIED 2026-08-21

Deferred by explicit instruction on 2026-08-20, then built in Phase B. All three are local work,
testable without GCP, and therefore were never blocked by the spend cap. **Measured results and
verification are in §14k** — A gave 1,029 → 31 bytes, B gave 6.84 MB → 0.34 MB (19.9× over the
wire), C was browser-tested with a clean server-side `leave` and no held seat. The table below
is the original estimate, kept for comparison.

| Fix | Effort | Effect |
|---|---|---|
| Broadcast a delta `{id,x,y}` instead of all 12 entities | small, contained in `MainRoom.ts` | 1,029 → 31 bytes (**33×**); 206 → 6 MB/class |
| Minify the bundle (`--minify`) + `compression` middleware | two lines | 6.84 MB → 0.34 MB (**20×**); 41 → 2 MB/class |
| Idle disconnect after ~15 min of no input, "click to rejoin" | small client change | bounds the forgotten-tab risk |

The first two together take a class from **247 MB → 8.2 MB** of egress; a 30-class semester goes
from 7.2 GiB to **0.24 GiB**, inside the monthly allowance with room to spare. The third is not
optional if the goal is to stay near $0 — it is the only thing between us and a student's laptop
billing all weekend.

### 14h. Revised cost (supersedes §8)

With all three fixes plus the 14f storage design, every line lands inside its allowance **except**
instance-hours, which depend entirely on out-of-class usage. 50 hours/month is roughly 12 hours a
week of somebody being connected — real, but not generous.

**Recommendation: lift the $0 cap and replace it with a $5 budget that sends email alerts at 50 /
90 / 100%, with no enforcement action.** Identical protection against a runaway bill, but it
degrades gracefully instead of pausing the service mid-class. The expected bill is genuinely
$0–1/month; the budget is a smoke alarm, not a spending plan.

If $0 must be a hard guarantee, GCP is the wrong host and that should be decided now rather than
after Phase C — the alternative is a department machine, which removes Google IAP and means
building sign-in ourselves. `identity.ts` is shaped the way it is because IAP exists.

Worth pursuing regardless: **Google Cloud for Education credits.** This is a teaching project and
TAMU faculty can usually get credits that would cover it many times over. The catch is that they
normally attach to an institutional account, and this project sits on a personal one.

### 14i. Still open

- ~~**B2** — does IAP forward the identity header on the WebSocket upgrade?~~
  **Closed 2026-08-22: yes.** See §14l.4.
- ~~**B3** — does the browser reconnect through IAP silently, or bounce to a login page?~~
  **Closed 2026-08-22: silently, every time.** See §14l.5.

Both were blocked on the spend cap being lifted; both are now answered and Phase B has nothing
left in it. What replaced them is smaller and concrete, and lives in §14l:

- Colyseus `allowReconnection`, so a socket cut by the request timeout rejoins its room instead
  of respawning the student. Now the highest-value Phase C item.
- Cloud Run `--timeout=3600s`, and `--max-instances=1` (or room state out of process).
- Treat close code 1006 as routine for the first couple of attempts — then, after ~3
  consecutive failed upgrades, `location.reload()` to recover an expired IAP session. Both
  cases arrive as 1006; only the repeat count distinguishes them. See §14l.6.
- Tell students in the onboarding email that a one-time Google consent screen ("access your
  email address") is expected, so it does not read as phishing.


### 14j. Decisions taken (2026-08-21)

**Logging scope.** The instructor does not want movement trajectories or room occupancy.
The deliverable is **the conversation between a student and the virtual TA**. Accordingly:

- The two `logEvent("move", …)` calls in `MainRoom.ts` (`handleStep` and the `walk`
  interval) are removed. Safe: the space session log is write-only — `logFilePath()` is
  used once to print a path at startup and nothing ever reads it back.
- Everything else in the space log stays (join, leave, chat, board posts, admin actions).
  A few hundred lines per class, and it captures student↔virtual-student chatter that the
  TA log cannot, since those personas never reach the TA brain.
- `logTurn` is untouched in purpose: it is both the deliverable and load-bearing, since
  `readTurns` replays it to rebuild a session after a restart.

Effect: ~30,000 events per class becomes ~200; 3.2 MB per class becomes ~25 KB; a semester
goes from ~96 MB to under 1 MB. **This saves disk and GCS operations only** — it saves no
egress and no instance-hours, so fixes A, B and C in §14g all still stand.

**Flush interval: 2 minutes, dirty-only.** Upload a snapshot when something changed since
the last one, at most once every two minutes, and always on `SIGTERM`.

| Interval | Worst-case writes/month | % of 5,000 allowance | Loss window |
|---|---|---|---|
| 1 min | 3,360 | 67% — no headroom | 1 min |
| **2 min** | **1,680** | **34%** | **2 min** |
| 5 min | 672 | 13% | 5 min |

Worst case assumes continuous dirtiness across all ~56 active hours; real usage is well
under it, because an idle instance generates no events, so nothing is dirty and nothing
uploads. `SIGTERM` covers ordinary scale-down, so the 2-minute window only ever costs
something on a hard crash.

**Snapshot layout.** Overwrite a rolling `state/current.tar.gz` on every flush, and once a
day also write `state/daily/YYYY-MM-DD.tar.gz` (~30 extra writes/month). This means a bug
that uploads a bad snapshot cannot silently destroy the semester. GCS object versioning was
rejected: it accrues a version per flush and would consume the 5 GB storage allowance.

**Turn record gains `name` and `email`.** Both become explicit fields on every logged turn:

```json
{"ts":"…","run":"…","sessionId":"space:ana@tamu.edu","email":"ana@tamu.edu",
 "name":"Ana Ruiz","role":"user","skill":"coach","readingId":null,"content":"…"}
```

Rationale: the format is free to change now and expensive later; `Identity` already carries
the name, so there is no plumbing to add; and the record becomes self-describing instead of
requiring the reader to parse a compound key (`space:<email>` for students,
`space:admin:<email>` for the instructor). Denormalising the name means a later roster
correction will not rewrite old turns — correct behaviour for a historical record.

**Privacy note.** With names and emails attached these files are student education records.
They are already gitignored; the GCS bucket must stay private with no public access.


### 14k. Phase B fixes — what was built (2026-08-21)

All local work; none of it needed GCP, so none of it was blocked by the spend cap.

Shipped as two commits on `multi-user-and-deploy-prep`:

| Commit | Subject | Scope |
|---|---|---|
| `4ab9ed6` | Fit the free tier: log less, name the speaker, shrink the wire | 14 files, +373/−79 — movement logging, name/email, fixes A and B, idle disconnect |
| `382aaa2` | Replace the GCS FUSE mount with periodic snapshots | 8 files, +376/−25 — `docker/sync.mjs`, both `paths.ts`, `start.sh`, `Dockerfile`, docs |

`4ab9ed6` was checked out standalone in a throwaway worktree and typechecks clean in both
projects with no forward references to `sync.mjs` — the split has no broken intermediate.

| Change | Files | Verified by |
|---|---|---|
| Movement no longer logged | `MainRoom.ts` (2 call sites) | smoke + integration + multiuser pass; `data/session-*.jsonl` holds joins/chat/posts only |
| Turns record `name` + `email` | `virtual_ta/{logger,index}.ts`, `virtual_space/ta.ts`, `MainRoom.ts` | real logs show `Ana <ana@local> [user] …`; separate file per identity |
| **B** minify + gzip | `virtual_space/package.json`, both `server/index.ts` | measured over the wire: 6.84 MB → **0.34 MB**, `Content-Encoding: gzip`, **19.9×** |
| **A** delta broadcast | `MainRoom.broadcastMove`, client `moved` handler, 3 test scripts | payload 1,029 → **31 bytes**; movement verified in-browser and by all three suites |
| **C** idle disconnect | `client/src/main.ts` | 15 min → overlay + Rejoin; browser-tested at 20 s; server logged a clean `leave`, **no held seat**; movement worked after rejoin |
| Snapshot storage (§14f) | new `docker/sync.mjs`, both `paths.ts`, `start.sh`, `Dockerfile` | full container round trip, below |

**`taChat` signature changed** from `(sessionId, message, skill?)` to
`(who: TaWho, message, skill?)`, where `TaWho` is `{sessionId, email, name}`. The TA's
`/api/chat` accepts an optional `who`; its own web UI omits it and logs `null` for both
fields, which is correct — there is no identity behind that surface.

**`docker/sync.mjs`** (273 lines, no new dependencies). Two modes: `restore` before the
servers start, `watch` after. Backends are `gs://bucket/prefix` and `file:///path`. GCS
is reached through the JSON API with a token from the metadata server rather than
`@google-cloud/storage` — two operations do not justify ~10 MB of image, and there is no
key material anywhere. `tar` and `gzip` are already in `node:25-slim` (checked). A failed
`restore` exits 0 so a bad snapshot cannot put the class behind a boot loop; a failed
`watch` exits 1, because silently not backing up is worse than a restart.

**Container round trip, verified end to end:** container up → smoke suite passes against
it → conversation and board post written → `docker stop` (SIGTERM) → `[sync] SIGTERM —
final flush` → **container destroyed** → fresh container → `[sync] restored 6 files` →
`[virtual-ta] restored 2 turns for space:jade@local (mode: coach)`. The conversation, the
board post and the session state all survived the filesystem being thrown away.

Also confirmed: **an idle tree uploads nothing.** The watcher compares the newest mtime in
the tree against the last flush and skips when unchanged — which is what keeps the monthly
op count near the low end of the §14j estimate rather than the worst case.

**Not verified: the `gs://` backend.** The spend cap makes it untestable. The `file://`
backend exercises every other line — pack, unpack, debounce, daily archive, SIGTERM flush,
restore-only-when-empty — so what remains unproven is narrowly the GCS request shape and
the metadata-server token. First thing to check once the cap is lifted, alongside B2/B3.

**Rotation was dropped.** §14f said the sync should trim local files so the in-memory
filesystem cannot grow. With movement logging gone the tree is under 1 MB a semester, and
trimming would remove history from the very snapshot that is supposed to preserve it. The
watcher logs a warning above 200 MB instead.

**One test-suite change worth knowing:** all three scripts now apply the `moved` delta to
their local mirror of the world, and `multiuser.ts` takes a `TA_LOGS_DIR` override so it
can be pointed at a container's logs instead of the sibling project's.



### 14l. Phase B execution — the run after the cap was lifted (2026-08-21)

The $0 cap became **$5** on 2026-08-21. Criteria below were written **before** the run, so a
marginal result cannot be talked into a pass. Results are filled in as each step completes.

**Step 0 — is the cap really what broke everything?**
Re-run the `sleep-test` job, a 60-second sleeper that Cloud Run previously killed in ~5 s with
`exit code: 0 and message: Unknown error`.
*Pass:* it runs the full 60 s and reports success. *Fail:* anything else — the 14b diagnosis is
wrong, and every step below is void until the container is understood.
**Result: PASS.** Execution `sleep-test-vnrml`, 2026-08-21 07:54:55→07:57:47Z. Logs show
`tick 5` … `tick 55`, `DONE-60S`, `Container called exit(0)`, `succeededCount: 1`. The same
job on the same image was killed at ~5 s while the cap was in force. **§14b confirmed.**

**Step 1 — delete the spike leftovers.**
Cloud Run jobs `fuse-spike`, `nofuse-control`, `minimal-test`, `sleep-test` (after step 0); the
failed `iap-spike` service; throwaway probe images in Artifact Registry, which are the only
thing consuming the 0.5 GB allowance. **`gs://stat689-data` is kept.** Any registry image whose
purpose is ambiguous is left alone and reported rather than guessed at.
**Result:** jobs and services done. **Registry images NOT deleted** — two `iap-spike` images,
150.76 MB, still in `cloud-run-source-deploy` as of 2026-08-22. Deleting a Cloud Run service
does not remove the images Cloud Build pushed for it; that is a separate step and is easy to
believe you have done when you have not.

**Step 2 — verify the `gs://` backend of `docker/sync.mjs`.**
The one thing committed unverified (`382aaa2`), and the one whose failure loses data. It cannot
be tested locally: the OAuth token comes from the metadata server, which only exists on GCP. Two
job executions:
1. write a known tree under `DATA_DIR`, let `watch` flush, then exit via SIGTERM so the
   final-flush path runs too;
2. a **fresh** container that only runs `restore`, then prints the tree.

*Pass:* the restored tree is byte-identical (compare a manifest of paths + SHA-256), `state/current.tar.gz`
and today's `state/daily/YYYY-MM-DD.tar.gz` both exist in the bucket, and the restore-only-when-empty
guard is observed to fire. *Fail:* any divergence.
*If it fails I fix it and re-verify without asking* — it is a bug in code already committed.
**Result: PASS, on every criterion.** Job `gs-verify`, executions `gs-verify-kth6t` (write) and
`gs-verify-vb5w4` (restore), against `gs://stat689-data/state`.

- **Byte-identical.** Manifest digest `09a7d533…60f8` in the write container before shutdown;
  the same digest on the fresh container after restore. Four files including a unicode JSONL
  (`hello - unicode` with accents and a check mark) and an 8-byte binary with embedded NULs —
  no encoding damage.
- **Both objects exist.** `state/current.tar.gz` (510 B, 08:04:50Z — the SIGTERM flush) and
  `state/daily/2026-08-21.tar.gz` (474 B, 08:04:33Z — the first flush). The daily archive is
  written once and *not* overwritten by later flushes, which is the point of it.
- **Debounce and idle-skip behave.** One change -> exactly one flush. Nine seconds idle ->
  still one flush: an idle room costs zero GCS operations, which is what keeps the monthly
  op count near the low end of §14j rather than the worst case.
- **SIGTERM catches what the debounce hasn't.** A write made 300 ms before SIGTERM, well
  inside the debounce window, still reached the bucket — `flushed (sigterm)`, and the file is
  170 bytes in both the pre-shutdown and the restored manifest.
- **Restore guard fires.** A second `restore` over a populated tree logged
  `already holds 4 files — leaving it alone` and left the digest unchanged.

The metadata-server token and the JSON API request shape — the only things `file://` could not
exercise — both work, with no key material anywhere. **`382aaa2` is now verified.**

**Step 3 — B2: does IAP forward the identity header on the WebSocket upgrade?**
Deploy the header-dump probe (Express + `ws`), enable IAP, grant *IAP-secured Web App User*, open
in a browser.
*Pass:* `x-goog-authenticated-user-email` is present on the **upgrade** request, not merely on the
plain GET. Partial credit is not a pass: `server/identity.ts` reads it off the Colyseus connection,
so header-on-GET-only is a **fail** for our purposes.
*Fallback if it fails* (decided in advance, not yet authorised): read the header on the ordinary
HTTP page load, set a signed httpOnly cookie there, read the cookie on the upgrade. ~1 h of work
across `identity.ts` and the client. **I stop and report rather than building this.**
**Result: BLOCKED — not a fail, a missing precondition.** The probe deployed with IAP enabled
(`run.googleapis.com/iap-enabled: true`), the IAP service agent holds `roles/run.invoker`, and
`jadexqwang@gmail.com` holds `roles/iap.httpsResourceAccessor`. IAP *is* in the request path —
responses carry `x-goog-iap-generated-response: true`. But every request returns:

```
HTTP/2 502
x-goog-iap-generated-response: true
Empty Google Account OAuth client ID(s)/secret(s).
```

**IAP has no OAuth client, and this project cannot auto-provision one.** Two independent
reasons, both verified against the live API rather than inferred:

1. `POST https://iap.googleapis.com/v1/projects/343454961473/brands` →
   `400 Project must belong to an organization.` `stat689` lives on a **personal Gmail
   account** with no Cloud Organization, so the managed-brand path is unavailable.
2. The IAP OAuth Admin APIs — the other way to create a client — were **shut down on
   2026-03-19**. `gcloud iap oauth-clients` is deprecated and non-functional.

So the OAuth client must be created by hand in the Cloud Console, once. The IAP API *will*
accept it afterwards: the discovery document shows `AccessSettings.oauthSettings` carries
`clientId` and `clientSecret`, patchable on
`projects/343454961473/iap_web/cloud_run-us-central1/services/<service>`.

**This is a Phase C blocker, not merely a spike blocker** — the real deployment needs a client
of its own. One client is shared by every IAP-protected service in the project.

> **Superseded 2026-08-22.** The client created here was deleted after the spike (its secret had
> been pasted into a chat transcript) and `iap_web` settings were cleared. Phase C creates a
> fresh one. The *procedure* below still stands; only the specific client is gone.

**The consent screen is not the same thing.** It was configured earlier in this project; the
missing piece is an OAuth 2.0 *client ID and secret*.

**Alternatives considered and rejected.** Cloud Run IAM (`--no-allow-unauthenticated` plus
`run.invoker` per student) cannot be used from a plain browser. App-level Google Sign-In means
writing and owning session handling that IAP gives for free. A shared link or per-student
secret gives no real identity, which FERPA-relevant logs (§14j) make unacceptable. IAP remains
the right choice; the setup cost is ~5 minutes, once.

**Step 4 (B3) is blocked behind the same gate** — same probe, same URL, and the 120 s timeout
is already deployed for it. Both answers come in one browser session once the client exists.

**Step 4 — B3: does the browser reconnect through IAP silently?**
Same probe, redeployed with `--timeout=120s` so the hour-long wait is unnecessary. Hold a socket
open past the timeout.
*Pass:* the client sees a clean close and Colyseus's existing backoff reconnects with no visible
interruption and no re-auth. *Fail:* a Google auth interstitial breaks the handshake, or the
reconnect needs a manual page reload. With the real 60-minute timeout this fires once in a
75-minute class, so a fail means students get bounced mid-class.
*If it fails I stop and report* — the options are trade-offs (accept a mid-class re-auth vs.
restructure session handling) and that is the instructor's call.
**Result: BLOCKED behind step 3.** The probe is deployed with `--timeout=120s` and ready; it
needs an authenticated browser session, which needs the OAuth client above.

**Spend.** The CLI has no "current spend" endpoint — real cost needs the console's Billing →
Reports page, or a BigQuery export. What can be stated exactly is the resource inventory left
behind: **zero** Cloud Run services, **zero** jobs, **zero** images in Artifact Registry (the
two `iap-spike` images were deleted 2026-08-22; see §14l.7), and **984 bytes** in
`gs://stat689-data`. Three Cloud Build builds of roughly
two minutes each, against 2,500 free minutes a month; job executions were seconds of vCPU.

**Documentation debt, deliberately deferred.** §8 and §9 are patched by "superseded by" markers
rather than rewritten, and §14 is now three layers of correction over the original Phase B. Once
Phase B closes, §5/§8/§9/§14 should be consolidated into one coherent Phase B/C section. Doing it
before the results are in would mean doing it twice.

**What unblocks steps 3 and 4** — one console task, then one command, both by the instructor:

1. Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   application type **Web application**, any name.
2. Copy the generated **Client ID**, then edit the same client and add an
   **Authorized redirect URI** of exactly
   `https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect`, and save.
   (The URI embeds the client's own ID, so it can only be added after creation.)
3. Enable IAP on the service, attach the client **at project level**, and grant access.
   The curl PATCH originally written here was wrong and returns 400 — see the dead ends below.
   This is the sequence that actually works (verified 2026-08-22):

   ```
   # a. Enable IAP on the service. Warns about no-organization projects; proceed anyway.
   gcloud run services update iap-spike --region=us-central1 --iap

   # b. Attach the OAuth client — PROJECT level (iap_web), NOT the service.
   #    settings.yaml (chmod 600, outside the repo, delete afterwards):
   #      access_settings:
   #        oauth_settings:
   #          client_id: "<CLIENT_ID>"
   #          client_secret: "<SECRET>"
   gcloud iap settings set settings.yaml --project=stat689 --resource-type=iap_web

   # c. Grant the accessor role on the IAP resource, not the Run service.
   gcloud iap web add-iam-policy-binding --resource-type=cloud-run \
     --service=iap-spike --region=us-central1 \
     --member=user:jadexqwang@gmail.com --role=roles/iap.httpsResourceAccessor
   ```

   Success looks like a **302 to `accounts.google.com`** carrying your `client_id` and
   `scope=openid+email`. Before step (b) the service returns **502 with
   `x-goog-iap-generated-response: true`** — IAP intercepting but with no way to sign anyone
   in. That 502 is the signature of a missing OAuth client; it is not a broken container.

   **Four dead ends, all of which look plausible:**

   - `PATCH …/services/iap-spike:iapSettings` with `oauthSettings.clientId` → **400
     INVALID_ARGUMENT**. `OAuthSettings` on a *service* holds only `loginHint` and
     `programmaticClients`. The client belongs on the project's `iap_web` resource.
   - `gcloud iap web enable` → resource types are **app-engine and backend-services only**.
     It does not do Cloud Run.
   - `gcloud run services add-iam-policy-binding --role=roles/iap.httpsResourceAccessor` →
     *"not supported for this resource"*. Must be `gcloud iap web add-iam-policy-binding`.
   - `gcloud iap oauth-brands` / `oauth-clients` → **the IAP OAuth Admin APIs were shut down
     2026-03-19**, and required an organization regardless. Ignore every tutorial that uses them.
   - Clearing the client again by REST → **400 on every variant** (empty body, empty
     `accessSettings`, empty `oauthSettings`, explicit `null`, subfield masks — five tried).
     The one thing that works is `gcloud iap settings set` with a file containing
     `access_settings: {}`, which sends replace semantics instead of a field mask. Same asymmetry
     as setting it: use gcloud for writes to `iap_web`, not hand-rolled PATCHes.

   **Why a custom client is needed at all:** Cloud Run IAP defaults to a Google-managed OAuth
   client that only serves *in-organization* identities. This project is on a personal Gmail
   account with no organization, so there is no org to draw identities from and a custom client
   is mandatory. A TAMU-org project would not need steps (b) or the client at all.

4. **B2 — does IAP forward identity on the WebSocket upgrade? YES. Verified 2026-08-22.**

   This was the one genuinely load-bearing unknown. It is settled: IAP injects the same three
   headers on the `Upgrade: websocket` request that it injects on a plain GET.

   ```
   x-goog-authenticated-user-email: accounts.google.com:<email>
   x-goog-authenticated-user-id:    accounts.google.com:<numeric sub>
   x-goog-iap-jwt-assertion:        <ES256 JWT>
   ```

   No other `x-goog-*` header appears on the upgrade. So `identity.ts` can read the same header
   in the HTTP path and the Colyseus `onAuth` path — **no signed-cookie fallback is needed**,
   which removes the largest piece of speculative work from Phase C.

   **Verify the JWT, not the email header.** The email header is trivially spoofable by anything
   that reaches the container directly; the JWT is not. Decoded, the assertion carries:

   ```
   iss  https://cloud.google.com/iap
   aud  /projects/343454961473/locations/us-central1/services/<service>
   email, sub (== the numeric id above), identity_source: GOOGLE
   exp  iat + 600s
   ```

   That `aud` string is the exact value to check against — note it is the Cloud Run resource
   path, **not** the OAuth client ID (which is the audience for the *inbound* token, a different
   thing). Getting these two confused is an easy way to write a check that always passes.

   **How this was tested, and the one gap.** The Claude-in-Chrome extension was not connected,
   so the test ran programmatically: a dedicated `iap-probe` service account, granted
   `roles/iap.httpsResourceAccessor`, with an impersonated ID token whose audience is the OAuth
   client ID, passed as `Authorization: Bearer`.

   ```
   gcloud iam service-accounts create iap-probe
   gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=iap-spike \
     --region=us-central1 --member=serviceAccount:iap-probe@stat689.iam.gserviceaccount.com \
     --role=roles/iap.httpsResourceAccessor
   gcloud iam service-accounts add-iam-policy-binding iap-probe@stat689.iam.gserviceaccount.com \
     --member=user:jadexqwang@gmail.com --role=roles/iam.serviceAccountTokenCreator
   gcloud services enable iamcredentials.googleapis.com        # required; not obvious
   gcloud auth print-identity-token --impersonate-service-account=iap-probe@... \
     --audiences="$CLIENT_ID" --include-email
   ```

   Two snags worth remembering: the accessor binding fails with *"service account does not
   exist"* for ~30s after creation, and impersonation returns `IAM_PERMISSION_DENIED` for a
   minute or two after the tokenCreator grant. Both are propagation, not misconfiguration —
   retry rather than re-grant.

   **The cookie path was then confirmed too — same day, no divergence.** The first run used the
   *bearer-token* path; students arrive on the *cookie* path, where IAP mints `GCP_IAP` cookies
   after the consent redirect. Repeating the test in a real signed-in Chrome produced byte-for-byte
   the same shape: all three headers on the upgrade, same `aud`, `PASS` on the page's own check.

   ```
   x-goog-authenticated-user-email: accounts.google.com:jadexqwang@gmail.com
   x-goog-authenticated-user-id:    accounts.google.com:105874281318162647779
   ```

   The consent screen is a one-time, single-scope grant (`openid email`, shown as *"Google will
   allow STAT689-website to access ... Email address"*). Each student sees it once. Worth a line
   in the onboarding email so it does not read as a phishing page.

5. **B3 — does the socket survive the request timeout, and reconnect? IT DIES ON SCHEDULE AND
   RECONNECTS CLEANLY. Verified 2026-08-22, three cycles over 5.5 minutes.**

   ```
   [   0s] OPEN #1   … identity headers present
   [ 120s] pong                      <- traffic every 15s throughout
   [ 121s] CLOSE code=1006 reason=""
   [ 123s] OPEN #2   … identity headers present
   [ 244s] CLOSE code=1006 reason=""
   [ 247s] OPEN #3   … identity headers present
   ```

   Four things this establishes, three of which have consequences for the app:

   - **The timeout is wall-clock on the request, not an idle timer.** A ping every 15 seconds
     did not extend it by one second. Heartbeats keep the *room* alive; they do nothing about
     Cloud Run's cut. Do not implement a keepalive expecting it to help — it won't.
   - **The close is 1006, with no close frame.** That is "abnormal closure" — the same code a
     genuine network failure produces. So a scheduled, expected, twice-hourly event is
     indistinguishable at the socket layer from a real drop. **The UI must not surface 1006 as
     an error**, or every student sees a scary disconnect banner every two minutes.
   - **Re-upgrade carries the identity headers every time.** No re-consent, no redirect, no
     degradation across cycles. This is the part that could have sunk the design and did not.
   - Reconnect latency was ~2s, which is just the client's own backoff; the upgrade itself
     returned immediately.

   **What this leaves as real Phase C work.** The transport reconnects; the *session* does not
   reconnect itself. Colyseus must be configured with `allowReconnection` so a returning socket
   rejoins its room rather than being seated as a new player — otherwise every student's avatar
   respawns, and any in-room state resets, on a fixed two-minute cadence. This is now the
   highest-value item in Phase C and is no longer speculative.

   **Raise the timeout to the 3600s maximum for Phase C.** At 120s a two-hour class period means
   ~60 reconnects per student; at 3600s it means one or two. Billing is unaffected — Cloud Run
   bills the open instance either way — so the only cost is that a wedged connection takes
   longer to be reaped. `gcloud run services update <svc> --timeout=3600s`. The reconnect path
   still has to work regardless; a longer timeout makes it rare rather than routine.

   **Instance affinity, noted before it bites.** All three reconnects landed on the same
   container (the server's upgrade counter kept incrementing rather than resetting) — but that
   is guaranteed only because the spike ran with `--max-instances=1`. A Colyseus room lives in
   one instance's memory, so any Phase C configuration that allows a second instance will
   scatter reconnecting students across instances and silently break rooms. Either keep
   max-instances at 1 or move room state out of process; there is no third option that works.

6. **Session expiry mid-connection — tested 2026-08-22, and this is the one that bites.**

   `reauthSettings.maxAge` exists in the IAP v1 API but **every attempt to set it returns 400
   INVALID_ARGUMENT** on this project (four variants tried: with/without `policyType`, methods
   `LOGIN` and `PASSWORD`, 120s and 300s). Same org-less limitation as the OAuth client. Note
   the failed PATCHes left `oauthSettings` untouched — always send an explicit
   `updateMask=accessSettings.reauthSettings` so a rejected write cannot clear the client.

   Expiry was therefore simulated instead, which is faithful from the app's point of view:
   load the page, then in a second tab hit **`https://<host>/_gcp_iap/clear_login_cookie`**.
   That drops the `GCP_IAP` cookies for the origin while an authenticated socket is still open.

   ```
   [   0s] OPEN #1              (cookie cleared at ~10s, from the other tab)
   [ 121s] pong                 <- the live socket is NOT torn down when the session dies
   [ 121s] CLOSE code=1006
   [ 124s] connecting… ERROR    CLOSE 1006
   [ 127s] connecting… ERROR    CLOSE 1006
   [ 130s] connecting… ERROR    CLOSE 1006
   …15 consecutive failures, no recovery, no prompt, forever
   ```

   **The failure mode is a silent infinite reconnect loop.** A browser cannot follow a 302 on a
   WebSocket upgrade, so IAP's redirect-to-login is invisible to the client: the upgrade just
   fails. There is no error message, no login page, no clue. A student mid-class sees the room
   freeze and stay frozen.

   **And the close code is 1006 — the same code as the routine 120s cut.** The app cannot tell
   "expected timeout" from "session gone" by close code, close reason, or anything else on the
   socket. The only usable signal is **N consecutive failed upgrades**.

   **The fix, verified to work:** on ~3 consecutive upgrade failures, call `location.reload()`.
   The reload is a normal HTTP GET, IAP answers with its 302, and the OAuth round trip runs. In
   the test that meant the account chooser, one click, and straight back into the app — socket
   open, identity headers present, **no second consent screen** (consent is granted once per
   account, not per session). Anything short of a full page load will not recover.

   So the reconnect handler needs two distinct behaviours off the same close code:
   *reconnect quietly* for the first couple of attempts, *reload the page* once they keep failing.
   Getting this wrong in either direction is bad — reload too eagerly and a transient blip
   reloads the room; never reload and an expired session hangs forever.

   **What is still untested:** natural cookie expiry, as opposed to cookie deletion. The client
   sees the same thing either way (no valid credential at upgrade time), so the app-level
   behaviour should be identical; the untested part is only whether Google's own session
   handling adds a re-auth prompt at the reload step. That is a UX detail, not a design risk.


7. **Teardown (2026-08-22).** Everything in this section has been deleted: the `iap-spike`
   Cloud Run service, the `iap-probe` service account (its IAM bindings went with it), and the
   OAuth client. Nothing from the spike is still running or still billing.

   The client was deleted rather than rotated because its secret had been pasted into a chat
   transcript. **Phase C must create a fresh OAuth client, and its secret must never be pasted
   anywhere** — write it straight into a `chmod 600` file outside the repo, feed that to
   `gcloud iap settings set`, and delete the file.

   Rebuilding the spike, if a live IAP test rig is wanted during Phase C, is ~10 minutes using
   steps 1–3 above. The dead ends are documented so none of them need rediscovering.

   **One thing the teardown did not catch at first:** `gcloud run services delete` leaves the
   container images behind. Two `iap-spike` images (150.76 MB) were still in the
   `cloud-run-source-deploy` Artifact Registry repo after the service was gone. **Deleted
   2026-08-22** — the repo now lists zero packages and zero manifests.

   Note the repo's reported size does not drop immediately: it read 158 MB *after* the delete
   completed, because Artifact Registry recomputes that figure periodically rather than on
   write. Trust `images list` / `packages list`, not `repositories describe`. Cleanup commands:

   ```
   gcloud artifacts docker images list \
     us-central1-docker.pkg.dev/stat689/cloud-run-source-deploy
   gcloud artifacts docker images delete \
     us-central1-docker.pkg.dev/stat689/cloud-run-source-deploy/iap-spike --delete-tags
   ```

   Worth a standing habit for Phase C: every `--source` deploy pushes a new image and none of
   them are ever removed automatically. The free allowance is only 0.5 GB and a single Node
   image is ~75 MB, so roughly seven deploys fill it. Prune as you go, or set a cleanup policy
   on the repo.


### 14n. Pre-Phase-C code changes (2026-08-22)

Two changes, both local, both from Phase B findings. Committed on
`multi-user-and-deploy-prep` after `main` was fast-forwarded to `09f5e81` so there is a
known-good rollback point behind the auth change.

**`b2129b1` — verify the IAP assertion.** `identity.ts` trusted
`x-goog-authenticated-user-email`, which is unsigned. It now verifies
`x-goog-iap-jwt-assertion` (ES256, node `crypto`, no new dependency) and treats the header as a
cross-check that must agree. `identify()` became async, so `MainRoom.onAuth` did too; it was the
only caller.

Two things to hold on to, because both are silent failures:

- **`dsaEncoding: "ieee-p1363"`.** JOSE signatures are raw `r||s`; node defaults to DER. Omit it
  and *every genuine token* fails to verify.
- **The audience is the Cloud Run resource path**, `/projects/343454961473/locations/us-central1/services/<svc>` —
  not the OAuth client ID. That is the audience of the *inbound* token, a different thing.

Key handling: cached an hour, refetched on an unknown `kid`, throttled **on the last attempt
rather than the last success**. The first version throttled on success, which meant a genuine
Google key rotation refused every login for the whole cooldown. The rotation test caught it.
5s now — one reconnect for a student, no amplification for an attacker.

**New deploy-time requirement.** `TRUST_IAP_HEADER=1` without `IAP_JWT_AUDIENCE` now **throws at
startup**. That is deliberate: the alternative is every login failing during class with a symptom
that looks nothing like the cause. Add `IAP_JWT_AUDIENCE` to the §6 deploy env alongside
`TRUST_IAP_HEADER=1` and `ADMIN_EMAILS`. `IAP_JWKS_URL` exists only to point tests at a fake.

**`90bbf1d` — reload instead of asking.** After eight failed retries the client printed "Reload
the page to rejoin". Correct advice, but it needed a student to read grey text mid-class, and a
full page load is the *only* recovery from an expired session (§14l.6). It now reloads itself,
guarded by a `sessionStorage` timestamp to at most one reload per five minutes so a dead server
cannot loop.

**Tests.** New `scripts/iap-jwt.ts`, 16 cases, all passing — the existing suites run with
`TRUST_IAP_HEADER` unset and never reach this code, so without it the verification would have
shipped untested. It mints tokens against a local ES256 key served as a JWKS and asserts that a
bare email header, a mismatched header, a foreign audience, a bad issuer, expired and
not-yet-valid tokens, `alg=none`, a tampered payload, an unpublished key and garbage are each
refused.

**Two pre-existing test failures surfaced while verifying this work** — `ghost-test.ts` asserts a
stale entity count, and `multiuser.ts` only passes when run first. Both were reproduced on a
clean checkout of `09f5e81`, so neither is a regression from these commits, and neither was
fixed here: fixing tests inside an auth change is how you lose track of what broke what.

**This verification also did not touch real IAP.** The tests mint tokens with a local key, which
proves the logic but not that Google's tokens satisfy it. `f8a9098` makes the likeliest symptom
self-explaining — an audience mismatch logs the expected and received strings once, so the
correct value can be copied out of the log rather than decoded by hand.

> **Status for all of the above lives in [`open-issues.md`](./open-issues.md), not here.** That
> file is the tracker; this section is the account of what was built and why. Items A1, A2 and
> B1 cover the three points just made, including when and how to settle the audience question.


### 14m. Hardening owed before students are on it — the runtime service account

**Do this during Phase C, before the first student logs in.** It is not urgent today and was
deliberately not changed mid-spike, but it should not ship as it stands.

**What is true now.** The default compute service account
`343454961473-compute@developer.gserviceaccount.com` holds **`roles/editor` on the whole
project**. That is why `docker/sync.mjs` reached `gs://stat689-data` in §14l with no grant of
any kind: `roles/editor` implies `projectEditor:stat689`, which the bucket's default ACL maps
to `legacyObjectOwner`. Convenient, and much broader than the app needs — that identity can
also read every secret, deploy revisions, and delete the bucket.

**What the app actually needs at runtime:** read and write objects under one bucket, plus
whatever secrets it is given. Nothing else.

**The fix — give the *runtime* its own identity; leave the build identity alone.**

```
gcloud iam service-accounts create stat689-app --display-name="STAT689 app runtime"

# Object read/write on one bucket only — not project-wide.
gcloud storage buckets add-iam-policy-binding gs://stat689-data \
  --member="serviceAccount:stat689-app@stat689.iam.gserviceaccount.com" \
  --role="roles/storage.objectUser"

# Only the secrets the app is actually given (repeat per secret).
gcloud secrets add-iam-policy-binding ollama-key \
  --member="serviceAccount:stat689-app@stat689.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Then deploy with it:
gcloud run deploy stat689 ... --service-account=stat689-app@stat689.iam.gserviceaccount.com
```

**`roles/storage.objectUser`, specifically — not `objectCreator`.** `sync.mjs` overwrites
`current.tar.gz` on every flush, and GCS counts overwriting an existing object as requiring
`storage.objects.delete`. With `objectCreator` alone the *first* flush would succeed and every
flush after it would fail — the worst possible failure shape, because it looks fine in testing
and stops backing up in week two.

**Do not strip `roles/editor` from the default compute account as part of this.** Cloud Build
uses that account for `gcloud run deploy --source`, so removing it breaks deploys. Narrowing
the runtime identity is the win here; the build identity is a separate question, worth its own
look but not entangled with this one.

**Verification after the change:** deploy, then confirm in the logs that the first
`[sync] flushed (changed)` appears *and* that a second one appears after a later change —
one flush proves the token works, two prove the overwrite permission does.

---

## 15. Redeploy — the 61-commit catch-up (2026-08-23)

**Drafted 2026-08-23, revised the same day after review. Not executed.** Per-item status lives
in [`open-issues.md`](./open-issues.md); this section owns the reasoning and the order.

§6 is the runbook for the *first* deploy — a service that did not exist, an empty bucket, an
OAuth client that had never been attached. None of those preconditions hold now, so this is a
new section rather than an edit to that one. §6 stays as the record of what Phase C was, which
is D3's lesson: a runbook rewritten in place stops being a record of anything.

> **Two accounts, and only one of them may be named here.** `jadewang@tamu.edu` is the
> instructor's own address and appears throughout this file already. The **second test account**
> belongs to somebody else, so per this file's header its address and display name are *not*
> written down here — they are passed straight to `gcloud` and kept with the other local
> configuration. Below it is `<test-2>` and `<Test2Name>`.

### 15a. What is actually running

Read off the live service on 2026-08-23, not from memory:

| | |
|---|---|
| revision | `stat689-00002-c5j`, serving 100% |
| image | `…/stat689@sha256:d22ac74…`, built **2026-08-22 23:16 UTC** |
| revision 2 | created 23:52 UTC with the **same image digest** — an env change, not a rebuild |
| runtime SA | `stat689-app@…` ✓ (§14m applied) |
| shape | `maxScale=1`, `timeout=3600`, `memory=1Gi`, `cpu-throttling=false`, `startup-cpu-boost=true` ✓ |
| IAP grants | `roles/iap.httpsResourceAccessor` on all three accounts ✓ (`<test-2>` granted 2026-08-23) |
| env present | `TRUST_IAP_HEADER`, `IAP_JWT_AUDIENCE`, `ADMIN_EMAILS`, `SNAPSHOT_URI`, the four LLM vars, `OLLAMA_API_KEY` from Secret Manager |
| env **absent** | **`STUDENTS`**, **`ROSTER`**, **`HANDOUT_SALT`** |

The infrastructure is right and both existing accounts can already sign in. The *code* is the
working tree at about `b693564` —

**61 commits and 6,488 lines of application code ago** (66 files under `virtual_space/`,
`virtual_ta/`, `Dockerfile` and `docker/`, including nine new server modules).

Everything from steps 1–4 is absent from production: announcements and boards, the Library shelf
and the course corpus, the Computer Lab repo cards, the entire handout system, the TA
simplification, and the six student characters.

**The missing env vars are not cosmetic**, and both are already tracked:

- no `STUDENTS` → every account that signs in lands in the Common Area. That is **D5b**'s quiet
  failure, sitting in production right now. Since step 4 it is no longer quiet: such an account
  is also refused every handout with a 403.
- no `HANDOUT_SALT` → every handout route answers 503. That is **D8**, and it is the fail-closed
  design working correctly rather than a bug.

### 15b. Why redeploy now, rather than when the first handout is ready

Not "it has been a while". Three of the new things are **container-shaped risks that the local
suites structurally cannot catch**, and two of the three fail quietly:

1. **`/katex` is served out of `node_modules/katex/dist`.** That path has to survive
   `npm prune --omit=dev` in the build stage. `katex` is in `dependencies`, so it should — but a
   pruned image is the only place that is ever actually tested. If it does not survive, every
   formula in every handout renders as raw `$…$`, nothing throws, and the first person to notice
   is a student.
2. **`handout-format.ts` exists only to keep `yaml` and `roster.ts` out of the server's import
   graph.** `yaml` is a devDependency, so a pruned image is likewise the only enforcement of that
   split. This one at least fails loudly: the container dies at boot.
3. **Bundle upload is a large JSON POST through IAP.** The body-parser ordering — a larger limit
   registered on the path *before* the global `express.json()`, because the first parser to touch
   a request sets `req._body` and every later one returns early — was worked out against a dev
   server with no proxy in front of it.

Then the ordinary argument: 6,488 lines is the largest untested delta this project has carried,
and the cost of bisecting a container failure scales with it. Two smaller reasons to go now
rather than later — **D7**'s safe window for wiping the bucket is still open and closes the first
time a student uses the space, and the salt has to be set at deploy time regardless, so doing it
while no handout data exists anywhere is free.

### 15c. Stage 1 — the app change the deploy depends on

**Do this first, not after the container build.** Stage 2 changes `package.json`, and Stage 3
builds the image that Stage 5 ships; validating an image and then editing its inputs would mean
deploying something nobody looked at.

Two real accounts now hold two slots, and the name a person is given reaches only one of the four
places it is shown. Design, rationale and verification are in
[`app-changes.md`](./app-changes.md), 2026-08-23, "A person's name, everywhere the character's
placeholder shows". In summary: `ROSTER` becomes load-bearing and drives the office label, the
handout dashboard and the startup line as well as the avatar; slot `jade` is renamed `s6` so
every slot id is an opaque handle; a slot assigned without a `ROSTER` name refuses to boot behind
IAP; and the possessive test in `MainRoom.ts` is broadened so a two-word name does not produce
"the X Y's Office door is shut".

It also carries **E8** — `MainRoom.ts:392` still hardcodes `roomById("office-jade")` as the home
of an idle TA-office occupant. That is the one call site E6's fix missed, filed separately so E6's
resolved record stays intact, and the second test account is the first thing to make it reachable.

### 15d. Stage 2 — three repo fixes, all found while reading the deploy path

None of them change application behaviour. One commit, so that the image and the runbook agree.

**1. `test_material/` is missing from `.gcloudignore` — open issue D10.** That file's own
header says it *replaces* gcloud's inference from `.gitignore`, so "the list below must be
complete" — and `test_material/` is gitignored but not listed. Its 136K therefore uploads to
Cloud Build and bakes into the image. The content is harmless test fixtures; the gap is not,
because it is exactly the drift the file was written to prevent and the next thing to fall
through it might carry something. Add it to `.gcloudignore` and `.dockerignore` both.

**2. The Dockerfile's comment about the prune is wrong — open issue D11.** It says "esbuild,
phaser and typescript do not [survive the prune]". `phaser` is in `dependencies`, so it does —
several MB of dead weight in a runtime image, and a comment that will mislead the next person
reasoning about image size. Either move `phaser` to devDependencies or correct the comment;
prefer the move, and verify `build:client` still works at Stage 3.

**3. §7's test table tells you to run `materials-test.ts` the one way its own header forbids.**
The table says `npx tsx scripts/materials-test.ts`; the file says **NEVER bare `npx tsx`** —
run that way it reads the committed fixture instead of the corpus `MATERIALS_DIR` points at and
reports green against the wrong documents, which it has done once already. Correct it to
`npm run test:materials`. While there: the table gives `HOME_IDLE_S=12` for `idle-test.ts` where
the file's own header says `10`, and `handout-test.ts` is missing from the table entirely.

### 15e. Stage 3 — the local test gate, then the container

**The suites first.** 6,488 lines have changed and Stage 1 touches identity, the roster and the
map; this is the cheapest filter available and the first draft of this section skipped it.

```
npx tsc --noEmit                       # in virtual_space and virtual_ta both
npm run test:materials                 # virtual_ta — no server, no LLM
npx tsx scripts/handout-test.ts        # brings its own servers
```

then, against a **fresh** space server and in this order (agent and avatar state persists for the
life of the process — `open-issues.md` A2, E5): `smoke.ts`, `integration.ts`, `multiuser.ts`,
`ghost-test.ts`. Expect `smoke` and `integration` to need updating for the renamed office; that
is Stage 1's own verification, not a regression.

**Then build and run the container.** This is the highest-value step in the section and it is not
a deploy:

```
docker build -t stat689-local .

docker run --rm -p 8080:8080 -e PORT=8080 \
  -e DEV_USER=jade@local -e ADMIN_EMAILS=jade@local \
  -e STUDENTS='s1@local=s1,s6@local=s6' \
  -e ROSTER='s1@local:Test Two,s6@local:Tester' \
  -e HANDOUT_SALT=local-container-test \
  -v stat689-local-data:/data stat689-local
```

- **A named volume, not a bind mount.** The image does `mkdir -p /data && chown node:node /data`
  and then `USER node`; a bind mount shadows that and a host directory Docker auto-creates is
  root-owned. A named volume is seeded from the image's directory *including ownership*.
- **`DEV_USER` is the admin, so open `/?as=s6@local` to be a student.** An admin has no avatar and
  `init.home === null`, and the 📝 Handouts panel is gated on `init.home` — as the admin you can
  upload a bundle and preview `/handout/<id>`, but the assignment path needs a student.
- **One of the two names is deliberately two words.** Stage 1 broadens the possessive test that
  chooses between "Tester's Office door is shut" and "*the* Library door is shut"; a one-word
  roster would not exercise the fix. Walk into the occupied TA office and read the refusal.
- **No `SNAPSHOT_URI`,** so no bucket is touched, and **no LLM key is needed**: the TA's
  `/api/health` returns `ok` unconditionally, so `start.sh`'s readiness probe passes and the
  container boots with no Ollama spend. The TA simply cannot answer, which is not what this stage
  tests.

**Do not proceed to any GCP stage until this serves a handout page with rendered maths, and until
the two offices are labelled from `ROSTER` rather than from the character placeholders.**

### 15f. Stage 4 — the salt, as a Secret Manager secret rather than an env var

**This deliberately amends §6 stage 2.** That command puts `HANDOUT_SALT` in `--set-env-vars`.
But **D8** calls the salt a secret, and this file's own header rule is that a secret pasted into
a transcript stays compromised after it is edited out. As a plain env var it appears in the
output of every `gcloud run services describe` — including the one run to write §15a above.

```
openssl rand -hex 24
```

Put it in Secret Manager beside `ollama-key`, grant the runtime service account
`roles/secretmanager.secretAccessor` on it, and inject it with `--set-secrets`. **No code
change:** `--set-secrets` presents it to the process as `process.env.HANDOUT_SALT` exactly as
before. Two extra commands buy a `describe` output that is safe to paste anywhere.

Write the value down with the other secrets *before* deploying. The `~` constraint from the
`--set-env-vars` alternate delimiter stops applying once it is a secret, but `openssl rand -hex`
guarantees hex anyway, and a future revert to env vars should not become a trap.

**Set it once and never change it.** The `.salt-fingerprint` guard turns a changed salt into a
503 that names the fix, rather than a dashboard quietly showing fewer responses than last week —
but only the original value actually recovers the data.

### 15g. Stage 5 — grant the second account, and wipe the bucket

**The IAP grant for `<test-2>` — done 2026-08-23, on the instructor's instruction.** All three
accounts now hold `roles/iap.httpsResourceAccessor`. The command, for the record and for the four
real students later:

```
gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=stat689 \
  --region=us-central1 --project=stat689 \
  --member="user:<address>" --role="roles/iap.httpsResourceAccessor"
```

> **The policy displays addresses with their original capitalisation** — Google echoes back what
> was typed. It does not matter: `STUDENTS` and `ROSTER` lower-case both sides of every entry, and
> `slotFor()` lower-cases its argument, so slot and name lookups are case-safe. The one comparison
> that is *not* case-folded on the incoming address is the admin check in `identity.ts`, and it has
> been correct in production since Phase C — Google issues the email claim lower-cased. Worth
> knowing before someone "fixes" a capital letter in an env var.

**Then wipe the bucket — D7 — and note the correction.** The tracker's command is right but its
procedure is incomplete: `docker/sync.mjs` flushes whenever the newest mtime in `DATA_DIR`
advances, and it uploads the **whole tree**. Delete `state/` while a container is warm and the
artefacts are still in that container's `/data`; the next join, message or log line puts them
straight back.

So: **confirm the service is at zero instances first**, then wipe, then do not touch the URL until
the new revision is deployed. The wipe sticks because the next boot restores from empty, which is
a path `sync.mjs` handles by design. D7 has been corrected to say this.

The deadline is unchanged: free today, destructive the moment a student has used the space, no
versioning and no undo.

### 15h. Stage 6 — deploy

§6 stage 2's command, with three amendments:

- **add the roster pair.** Both variables, together, or the accounts sign in and land under a
  character's name:

  ```
  STUDENTS=jadewang@tamu.edu=s6,<test-2>=s1
  ROSTER=jadewang@tamu.edu:Tester,<test-2>:<Test2Name>
  ```

  `s6` is the slot renamed from `jade` in Stage 1. `<test-2>` takes `s1`, which retires that
  slot's AI stand-in and keeps the character count at six — the slot choice is arbitrary and
  lives in an env var, so it is a one-word change later. After Stage 1, omitting a `ROSTER`
  entry for an assigned slot is a **boot failure** behind IAP rather than a wrong name.
- **move `HANDOUT_SALT`** out of `--set-env-vars` and into `--set-secrets`, per 15f.
- **ignore every reference to `jadewang@gmail.com`.** It appears in §6 stage 2, stage 3 and stage
  4 step 4b as the test-student account; it is a third address that has no IAP grant, so nobody can
  sign in as it. Had it gone out as written, the account actually used for testing would have
  signed in fine and landed in the Common Area — D5b exactly. §6 now carries a superseding note
  saying so; the lines stay because D5b quotes them.

Everything else is unchanged and already correct on the live service: the runtime service
account, `--min-instances=0 --max-instances=1`, `--timeout=3600`, `--memory=1Gi`, and
`--no-allow-unauthenticated --iap`.

**§6 stages 1 and 3 are otherwise done and must not be repeated.** The service account exists and
IAP is attached to the OAuth client at the project level.

### 15i. Stage 7 — verify the things only the cloud can answer

§6 stage 4 still covers the auth path and is not repeated. These are new, in order, and each one
exists because nothing local tests it:

1. **Startup log.** `Auth: IAP, JWT-verified`, `Roster: 6 student slots — 2 assigned (Tester,
   <Test2Name>)`, and the `Handouts:` line. "0 assigned" is D5b; a name shown as a character
   placeholder means Stage 1 regressed; a salt complaint means 15f went wrong and the line says
   which way.
2. **Sign in as both students.** Each must land in **their own** office, and each office must be
   **labelled with their name** — the real test of Stage 1, and not something the local container
   proves for IAP-supplied identities.
3. **Upload a bundle through the admin panel.** Regenerate it first —
   `npm run bundle:handout fixtures/handout-sample` — because `fixtures/*.handout.json` is
   gitignored and therefore not in the image. This is the only test of the large-body POST
   through IAP.
4. **Open the handout as a student and confirm the maths renders**, not raw `$…$`. This is the
   `/katex` mount, and it is the failure that would otherwise reach a student first.
5. **Grade a section, then open `/admin/handouts/sample-attention?names=1`.** Both names must read
   correctly there too — it is the fourth surface, and the one with no other reader.
6. **Force a restart and confirm the response survived.** Let the service scale to zero rather
   than deploying a no-op revision: it is free, and it is the better test, because it also
   exercises the SIGTERM final flush that a new revision does not. **This is the only test of
   whether handout responses are durable at all** — `data/handouts/` is new since the last
   container ever ran. It should round-trip; "should" is the word this step exists to replace.
7. **Two `[sync] flushed (changed)` lines**, per §6 stage 4 step 6: one proves the token, two
   prove the overwrite permission.
8. **One reading upload and one TA answer citing it**, confirming step 2's corpus works when the
   shipped fixture is the only thing in the image.
9. **Idle one student out of the TA office** and confirm they return to their *own* office (E8).

### 15j. Stage 8 — afterwards

- **Check Artifact Registry.** D2's cleanup policy is active and verified — `keep-recent-versions`
  at 3, `delete-untagged` at 7 days, `delete-stale` at 60. One image today at 113.8 MB against the
  0.5 GB free allowance, so a deploy plus a rollback candidate fits comfortably; iterating deploys
  does not, which is what Stage 3 exists to prevent.
- **Tick in `open-issues.md`, not here:** D5b (both test accounts — the real students remain D5),
  D7, D8, D10, D11, E8, plus whatever the deploy exposes.
- **Merge to `main` only after Stage 7 passes.** `--source=.` deploys the working tree, so this is
  not a mechanical requirement — but `main` currently means "known good in production", which is
  worth preserving. Deploy from `multi-user-and-deploy-prep`, verify, then merge.
- **Wipe the bucket again** before the first real class, at zero instances per 15g, because this
  verification will leave artefacts in it: a sample handout, two graded responses, a test reading.

### 15k. What this stage deliberately does not do

- **No real handout.** `fixtures/handout-sample` is a three-version fixture; the real thing is six
  versions of four to six sections and has not been written yet. This stage proves the *plumbing*,
  and the plumbing is what a container can break.
- **No student onboarding.** D5's addresses are still outstanding, and **D12** — how many of the
  six slots real students get, once two are held by test accounts — is deferred until the class
  list is final.
- **Nothing about E7.** There is still no way to withdraw a handout. But the removal path exists
  and it is 15g's procedure: scale to zero, wipe the bucket, and the next boot restores from
  empty. So the sample handout is recoverable, which is weaker than a withdraw button and
  sufficient before any student is in the space.

### 15l. Rollback

`stat689-00002-c5j` stays in the revision list, and its image survives this deploy — checked
against the cleanup policy above rather than assumed. If the new revision is bad:

```
gcloud run services update-traffic stat689 --to-revisions=stat689-00002-c5j=100 \
  --region=us-central1 --project=stat689
```

That reverts the *code* in seconds. It does **not** revert the bucket: anything the new revision
wrote to `state/current.tar.gz` stays written, and the old revision will restore it on its next
boot. Given that Stage 5 empties the bucket first and every write this round is a test artefact,
that is acceptable — but it would not be with real student state, and it is worth recording as
the reason traffic-splitting is not a general safety net for this app.
