# Virtual Space — MVP (built, TA brain connected)

The classroom virtual space: a 43×34 campus with **ten virtual students**
(Sam, Ava, Ben, Chloe, Dev, Emma, Felix, Grace, Hana, Ivan — thin AI
personas), Jade's office, two commons halls, and a bottom band of mode
rooms — Classroom / Prep Room / **Library** 📌 / **Computer Lab** 📌 /
TA Office. **Terra** (the virtual TA) is powered by the real Virtual TA
brain in `../virtual_ta`. Requirements and plans:
[`../user_requirements/virtual_space_requirements.html`](../user_requirements/virtual_space_requirements.html)
(Parts 3, 5 & 6).

## Run it (two servers)

```bash
cd virtual_ta && npm run dev      # the TA brain, port 3000
cd virtual_space && npm run dev   # the world,   port 2567
```

Then open **http://localhost:2567**.

- **Role dropdown (testing):** *Student — Jade* (an avatar, normal chat) or
  *Admin* (no avatar — your keyboard/mouse drive **Terra**; chat is either
  🔒 private to the TA brain or 🗣 spoken aloud as Terra in her room).
- **Move:** arrow keys / WASD, or click a tile to walk there. The camera
  follows your avatar (Terra, for the admin); the viewport fills the
  window, and a **minimap** (top-right) shows the whole campus, everyone's
  position, and your current view.
- **Chat:** reaches whoever is in the same room. Terra answers from the TA
  brain (one session per student, replies tagged with the skill); virtual
  students are thin personas, capped at 2 repliers per message.
- **Rooms as modes:** the room Terra stands in forces her skill —
  **Classroom** → live-lecture Q&A, **Prep Room** → notes & slides,
  **Library** → announcements/posts, **Computer Lab** → code review.
- **Boards 📌:** the Library and Computer Lab have bulletin boards. Admin
  flow: instruct Terra → announce skill composes → editable preview → pin
  to a board. Students see the board when they walk in. Persistent
  (`data/boards.json`). There is no global broadcast anymore.
- **🎤 Lecture mic** (admin, Chrome): streams your lecture to the TA's
  class-wide transcript for classroom Q&A.
- **Logs:** every move, chat, post, and admin action goes to
  `data/session-<timestamp>.jsonl`; lecture transcript and announcements
  persist on the TA side under `../virtual_ta/data/class/`.

## Configuration

`.env` (git-ignored, server-side only): LLM settings for Sam's persona
(`LLM_PROVIDER`, Ollama key/model) and `TA_BASE_URL` (default
`http://localhost:3000`) for Terra's brain.

## Tests

```bash
npx tsx scripts/smoke.ts        # core loop: movement, roles, chat, boards
npx tsx scripts/integration.ts  # full TA↔space wiring, all room modes

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
