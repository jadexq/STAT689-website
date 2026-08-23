# Virtual Space — MVP (built, TA brain connected)

The classroom virtual space: a 43×21 campus with **six student offices** —
five played by thin AI personas (Sam, Ben, Chloe, Dev, Grace) until a real
address is assigned, and a sixth with no stand-in — a commons
hall, and a bottom band of mode rooms — Prep Room / **Library** 📌 /
**Computer Lab** 📌 / TA Office, plus a Classroom 🚧 that is sealed while
its skill is on hold. The **TA** is powered by the real Virtual TA
brain in `../virtual_ta`. Requirements and plans:
[`../user_requirements/virtual_space_requirements.html`](../user_requirements/virtual_space_requirements.html)
(Parts 3, 5 & 6).

## Run it (two servers)

```bash
cd virtual_ta && npm run dev      # the TA brain, port 3000
cd virtual_space && npm run dev   # the world,   port 2567
```

Then open **http://localhost:2567**.

- **Who you are** is decided by the *server*, never by the browser: from
  the Google IAP header in the cloud, from `DEV_USER` locally. One email is
  one human, with one avatar and one TA conversation. To be somebody else
  locally, add `?as=omar@local` — two windows with different `?as=` values
  are two students at once.
- **Role dropdown:** shown only to an account in `ADMIN_EMAILS`. *Student*
  (an avatar, normal chat) or *Admin* (no avatar — your keyboard/mouse
  drive the **TA**; chat is either 🔒 private to the TA brain or 🗣 spoken
  aloud as the TA in their room). A student who adds `?role=admin` by hand
  just gets an avatar: the server grants the role, the client only asks.
- **Move:** arrow keys / WASD, or click a tile to walk there. The camera
  follows your avatar (the TA, for the admin); the viewport fills the
  window, and a **minimap** (top-right) shows the whole campus, everyone's
  position, and your current view.
- **Chat:** reaches whoever is in the same room. The TA answers from the TA
  brain (one session per student, replies tagged with the skill); virtual
  students are thin personas, capped at 2 repliers per message.
- **Rooms as modes:** the room the TA stands in forces their skill —
  **Prep Room** → notes & slides, **Library** → announcements/posts,
  **Computer Lab** → code review.
- **Classroom 🚧 (temporarily closed):** the classroom skill is disabled
  while it is reworked. The room has no door, forces no skill, and clicking
  it explains why. Reopen by flipping `CLASSROOM_OPEN` in `server/map.ts`
  and `CLASSROOM_ENABLED` in `../virtual_ta/server/router.ts` — both must
  be true.
- **Boards 📌:** the Library and Computer Lab have bulletin boards. Admin
  flow: instruct the TA → announce skill composes → editable preview → pin
  to a board. Students see the board when they walk in. Persistent
  (`data/boards.json`). There is no global broadcast anymore.
- **🎤 Lecture mic** (admin, Chrome): streams your lecture to the TA's
  class-wide transcript for classroom Q&A.
- **Dropped connections:** the server holds a seat — and the avatar,
  exactly where it was standing — for 2 minutes, and the client reconnects
  with backoff. Cloud Run cuts every connection at 60 minutes, so a long
  class will hit this. It also makes the tests non-idempotent inside that
  window: restart the space server between runs.
- **Logs:** joins, chat, posts and admin actions go to
  `data/session-<timestamp>.jsonl`. **Movement is deliberately not logged** —
  it was ~30,000 rows a class, nothing ever read them back, and the record
  that matters is the student's conversation with the TA. That one lives on
  the TA side, one file per person: `../virtual_ta/data/logs/space_<email>.jsonl`,
  with the student's name and email on every turn.
- **Feedback handouts.** The instructor writes a handout in several versions outside the app
  (see [`../plan/handout-authoring.md`](../plan/handout-authoring.md)), validates the folder into
  one bundle with `npm run bundle:handout <dir>`, and uploads it from the admin panel. Each
  student is assigned one version per section by a fixed rotation — recorded at first render,
  never recomputed — and grades each section 1–5 with an optional comment. The instructor reads
  the result at `/admin/handouts/<id>`, worst section first, and exports it as JSONL records or
  as derived preference pairs. **The data is not anonymous to the instructor**: with one reader
  per version the version identifies the student, and the dashboard says so rather than implying
  otherwise. Nothing here touches the TA — a TA outage takes the chat down and leaves handouts
  working.
- **Idle tabs disconnect after 15 minutes** and offer a Rejoin button.
  Cloud Run bills an instance for as long as *any* WebSocket is open, so a
  laptop left open over a weekend would otherwise cost ~48 hours against a
  free-tier budget of about 50 a month. Keys, clicks, scrolling and mic
  audio all count as activity; mouse movement does not.

## Configuration

`.env` (git-ignored, server-side only) — see [`../.env.example`](../.env.example)
for the full list. Beyond the LLM settings and `TA_BASE_URL`:

| Variable | Meaning |
|---|---|
| `TRUST_IAP_HEADER` | `1` only behind Google IAP — makes the authenticated-user header authoritative. Unset locally: a header anyone can set is not a login. |
| `ADMIN_EMAILS` | Instructor allowlist. Behind IAP, empty means nobody is an instructor; locally it defaults to `DEV_USER`. |
| `ROSTER` | `email:Name` pairs. The only place a real name may live — `roster.ts` is tracked. Names the avatar, the office door, the `Roster:` startup line and the handout dashboard. **Required behind IAP** for every address `STUDENTS` assigns; locally a missing one warns and falls back to the character's placeholder. |
| `DEV_USER` | Who you are when not behind IAP (default `jade@local`). |
| `STUDENTS` | `email=slot` pairs — which student character each address controls (`s1`…`s6`; the ids are opaque handles, not names). Assigning a slot removes its AI stand-in and renames its office after the occupant. An address with no slot spawns in the Common Area **and is refused every handout**. |
| `HANDOUT_SALT` | Salts the student hash on feedback records. Required behind IAP — the handout routes 503 without it rather than fall back to an unsalted hash over six known addresses. **Set once, never change it:** every hash moves with it. The app refuses to serve handouts if it disagrees with the data already on disk. |
| `DATA_DIR` | Root for everything mutable. Unset locally (uses `data/`); a plain writable directory in the container. Not a bucket mount — see `../docker/sync.mjs`. |
| `SNAPSHOT_URI` | Where that root is snapshotted (`gs://…` or `file://…`). Unset means no sync, which is right locally. |
| `SNAPSHOT_FLUSH_MS` | Upload at most this often, and only when something changed. Default 120000. |

The server prints which mode it is in at startup (`Auth: …`).

## Tests

```bash
npx tsx scripts/smoke.ts        # core loop: movement, roles, chat, boards
npx tsx scripts/integration.ts  # full TA↔space wiring, all room modes
npx tsx scripts/multiuser.ts    # two identities coexist; admin is granted,
                                # not claimed; separate TA conversations
npx tsx scripts/handout-test.ts # feedback handouts: version rotation, the
                                # write path, the exports — brings its own
                                # server, so nothing else need be running
```

The first three need the two servers running and a **fresh** space server (agents
keep their positions between client connections), and make a few real LLM
calls. To run them against the container instead, set `VS_URL=ws://localhost:8080`
and `TA_LOGS_DIR` to wherever that container's `ta/logs` is readable.
Last full pass: 2026-08-21.

## Layout

```
server/   Colyseus world: movement, same-room chat, admin, agents, JSONL logging
          ta.ts — HTTP client for the Virtual TA brain
          handouts.ts       — handout store, version rotation, records, exports
          handout-format.ts — the bundle format and its validator (no deps but crypto,
                              so the bundler can run without a configured app)
          handout-render.ts — the handout page, the grading widget, the dashboard
client/   Phaser game + chat + admin panel (bundle built by esbuild)
fixtures/ handout-sample/ — a tracked handout the suite runs against, plus
          handout-bad/* which the bundler must refuse
scripts/  smoke.ts, integration.ts, handout-test.ts — end-to-end tests
          bundle-handout.ts — validate a handout folder into one bundle
data/     session logs (git-ignored)
```
