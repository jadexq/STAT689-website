# Virtual TA — MVP

One unified chat box, an LLM intent router, four skills over a shared core.
Runs entirely on the instructor's laptop. Plan: Part 4 of
[`user_requirements/virtual_ta_requirements.html`](../user_requirements/virtual_ta_requirements.html).

## Run

```bash
npm install
npm run dev        # http://localhost:3000  (watch mode; `npm start` without watch)
npm run typecheck  # tsc --noEmit
npx tsx scripts/memory.ts   # sessions survive a restart (no server, no LLM calls)
```

Requires Node ≥ 23 (TypeScript runs natively — no build step). `.env` holds the
Ollama key (copied from `../virtual_space/.env`) and an optional read-only
`GITHUB_TOKEN` for private-repo PR review; it is git-ignored and read
server-side only.

## What it does

| Skill | Try | Output |
|---|---|---|
| **Coach** | "Help me work through the attention reading" | Socratic coaching; student questions collected into `data/digests/`; ask for the "question digest" to get it organized |
| **In-class** | Flip on the mic toggle, then ask about the lecture; say "take notes" | Q&A over the live transcript; Markdown notes in `data/` |
| **Author** | "Make a slide deck about attention" or "draft lecture notes on X" | Self-contained HTML deck / Markdown notes in `output/`, linked in the chat |
| **Review** | "Review https://github.com/owner/repo/pull/123" | Line-referenced feedback in the chat (read-only; nothing posted to GitHub) |
| **Announce** | "/announce share this with the class: https://arxiv.org/abs/…" | A short class-wide announcement grounded in the fetched page, saved to `output/` and logged in `data/class/announcements.jsonl` — distribution to students is the virtual space's job |

Force a skill with `/coach`, `/notes`, `/slides`, `/review`, `/announce` — or pass
`skill` in the `POST /api/chat` body to bypass the router entirely (used by the
virtual space's room-based modes). The router keeps a sticky mode and asks which
skill you want when a request is ambiguous.

- Live transcription uses the browser's Web Speech API → Chrome/Chromium + mic permission.
- Virtual space integration: the space (`../virtual_space`) embodies this TA as Terra — per-student `/api/chat` sessions, room-forced skills, and the lecturer's mic streamed to `/api/listen` with `scope:"class"` (class-wide transcript, persisted under `data/class/`, read by the classroom skill; announce returns clean text in `data.announcement` for the space's preview-then-dispatch broadcast).
- Materials: drop readings (MD / TXT / HTML / PDF) into `materials/` and list them in `materials/manifest.json`.
- Durable records: JSONL chat logs in `data/logs/`, digests in `data/digests/`, generated artifacts in `output/` (all git-ignored).
- Behavioral improvements are documented in [`docs/improvements/`](docs/improvements/README.md) — old behavior, evidence logs, fix, verified new behavior, and design lessons.

## Sessions and persistence

A session is keyed by a **stable identity** — the virtual space sends
`space:<email>` — so it means the same thing across restarts. In-memory
sessions are therefore a cache, not the record:

- every turn is appended to `data/logs/<session>.jsonl` as it happens;
- `ensureSession()` rebuilds a missing session from that log, restoring the
  recent history, the sticky mode, and the selected reading.

This is what makes scale-to-zero survivable — on Cloud Run every quiet
spell is a restart, and a student coming back after class should not have
to reintroduce themselves. `scripts/memory.ts` checks it.

`DATA_DIR` relocates `data/` and `output/` (a mounted GCS bucket in the
cloud, since a container filesystem is ephemeral). Unset locally.

## Smoke test (headless)

```bash
curl -s localhost:3000/api/health
curl -s localhost:3000/api/materials
curl -s localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"sessionId":"t1","message":"Help me work through the attention reading — what is a query?"}'
```
