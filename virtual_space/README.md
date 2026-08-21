# Virtual Space — MVP (built, TA brain connected)

The classroom virtual space: a 43×21 campus with **five virtual students**
(Sam, Ben, Chloe, Dev, Grace — thin AI personas), Jade's office, a commons
hall, and a bottom band of mode rooms — Prep Room / **Library** 📌 /
**Computer Lab** 📌 / TA Office, plus a Classroom 🚧 that is sealed while
its skill is on hold. **Terra** (the virtual TA) is powered by the real Virtual TA
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
  drive **Terra**; chat is either 🔒 private to the TA brain or 🗣 spoken
  aloud as Terra in her room). A student who adds `?role=admin` by hand
  just gets an avatar: the server grants the role, the client only asks.
- **Move:** arrow keys / WASD, or click a tile to walk there. The camera
  follows your avatar (Terra, for the admin); the viewport fills the
  window, and a **minimap** (top-right) shows the whole campus, everyone's
  position, and your current view.
- **Chat:** reaches whoever is in the same room. Terra answers from the TA
  brain (one session per student, replies tagged with the skill); virtual
  students are thin personas, capped at 2 repliers per message.
- **Rooms as modes:** the room Terra stands in forces her skill —
  **Prep Room** → notes & slides, **Library** → announcements/posts,
  **Computer Lab** → code review.
- **Classroom 🚧 (temporarily closed):** the classroom skill is disabled
  while it is reworked. The room has no door, forces no skill, and clicking
  it explains why. Reopen by flipping `CLASSROOM_OPEN` in `server/map.ts`
  and `CLASSROOM_ENABLED` in `../virtual_ta/server/router.ts` — both must
  be true.
- **Boards 📌:** the Library and Computer Lab have bulletin boards. Admin
  flow: instruct Terra → announce skill composes → editable preview → pin
  to a board. Students see the board when they walk in. Persistent
  (`data/boards.json`). There is no global broadcast anymore.
- **🎤 Lecture mic** (admin, Chrome): streams your lecture to the TA's
  class-wide transcript for classroom Q&A.
- **Dropped connections:** the server holds a seat — and the avatar,
  exactly where it was standing — for 2 minutes, and the client reconnects
  with backoff. Cloud Run cuts every connection at 60 minutes, so a long
  class will hit this. It also makes the tests non-idempotent inside that
  window: restart the space server between runs.
- **Logs:** every move, chat, post, and admin action goes to
  `data/session-<timestamp>.jsonl`; lecture transcript and announcements
  persist on the TA side under `../virtual_ta/data/class/`.

## Configuration

`.env` (git-ignored, server-side only) — see [`../.env.example`](../.env.example)
for the full list. Beyond the LLM settings and `TA_BASE_URL`:

| Variable | Meaning |
|---|---|
| `TRUST_IAP_HEADER` | `1` only behind Google IAP — makes the authenticated-user header authoritative. Unset locally: a header anyone can set is not a login. |
| `ADMIN_EMAILS` | Instructor allowlist. Behind IAP, empty means nobody is an instructor; locally it defaults to `DEV_USER`. |
| `ROSTER` | `email:Name` pairs for avatar labels. Without one, the name is guessed from the address. |
| `DEV_USER` | Who you are when not behind IAP (default `jade@local`). |
| `DATA_DIR` | Root for everything mutable. Unset locally (uses `data/`); on Cloud Run it points at the mounted GCS bucket. |

The server prints which mode it is in at startup (`Auth: …`).

## Tests

```bash
npx tsx scripts/smoke.ts        # core loop: movement, roles, chat, boards
npx tsx scripts/integration.ts  # full TA↔space wiring, all room modes
npx tsx scripts/multiuser.ts    # two identities coexist; admin is granted,
                                # not claimed; separate TA conversations
```

Both need the two servers running and a **fresh** space server (agents
keep their positions between client connections), and make a few real
LLM calls. Last full pass: 2026-07-07.

## Layout

```
server/   Colyseus world: movement, same-room chat, admin, agents, JSONL logging
          ta.ts — HTTP client for the Virtual TA brain
client/   Phaser game + chat + admin panel (bundle built by esbuild)
scripts/  smoke.ts, integration.ts — end-to-end tests
data/     session logs (git-ignored)
```
