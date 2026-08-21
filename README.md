# STAT 689 — course website

Two servers that together make a virtual classroom:

| | |
|---|---|
| [`virtual_ta/`](virtual_ta/) | the TA "brain" — one chat box, an intent router, five skills. Express, port 3000. |
| [`virtual_space/`](virtual_space/) | the campus — a tile world where **Terra** (the TA, embodied) and five virtual students live. Colyseus + Phaser, port 2567. |

The space gives the TA a body; the TA gives the body a mind. They talk over
`localhost`, which is why they deploy as one container.

## Run it locally

```bash
cd virtual_ta && npm install && npm run dev
```

```bash
cd virtual_space && npm install && npm run dev
```

Then open **http://localhost:2567**. Each project's README covers the rest.

## Identity

Nobody names themselves. The server decides who you are — from the Google
IAP header in the cloud, from `DEV_USER` locally — and one email means one
avatar and one TA conversation. The instructor role is granted from
`ADMIN_EMAILS`, never claimed by the client.

Locally, `?as=someone@local` lets one browser be somebody else, so you can
open two windows and be two students. See [`.env.example`](.env.example).

## Deploying

One Cloud Run service behind Google IAP, both servers in one container,
scaled to zero when nobody is in class.

```bash
docker build -t stat689 . && docker run -p 8080:8080 --env-file virtual_ta/.env -e SNAPSHOT_URI=file:///snap -v "$PWD/.localdata:/snap" stat689
```

The image sets `DATA_DIR=/data` itself. That directory is **ephemeral, and
on Cloud Run it lives in RAM** — `docker/sync.mjs` is what makes it durable:
it restores the tree before the servers start, then uploads one snapshot
whenever something changes, at most every two minutes, plus a final one on
`SIGTERM` and a dated archive once a day. Point `SNAPSHOT_URI` at
`gs://<bucket>/state` in the cloud, `file://…` locally, or leave it unset for
no sync at all.

Storage is deliberately *not* a mounted bucket: appending JSONL through GCS
FUSE rewrites the whole object per line, which GCS throttles to about one
write a second and bills against a 5,000-write monthly free tier. A probe
drew 358 HTTP 429s and failed to finish 2,000 appends in nine minutes.

The full plan — architecture, IAM, the free-tier analysis, cost, and the two
questions still to be settled by a spike — is in
`user_requirements/plan/gcp-deployment-plan.md` (kept out of git).
