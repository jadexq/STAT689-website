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
docker build -t stat689 . && docker run -p 8080:8080 --env-file virtual_ta/.env -e DATA_DIR=/data -v "$PWD/.localdata:/data" stat689
```

The full plan — architecture, IAM, the GCS mount, cost, and the two open
questions still to be settled by a spike — is in
`user_requirements/plan/gcp-deployment-plan.md` (kept out of git).
