// Where mutable state lives. Locally that is this project's own data/
// folder; in the container DATA_DIR points at a writable local directory
// shared by both servers, each with its own subdirectory so their files
// never collide.
//
// DATA_DIR is deliberately NOT a mounted bucket any more. Appending JSONL
// through GCS FUSE rewrites the whole object per line, which GCS throttles
// at ~1 write/second and bills against a 5,000-writes-a-month free tier.
// docker/sync.mjs owns the cloud relationship instead: it restores this
// tree at boot and uploads one snapshot of it every couple of minutes.
// See the deployment plan, §14f.

import path from "path";

const ROOT = process.env.DATA_DIR?.trim();

export const DATA_DIR = ROOT
  ? path.join(ROOT, "space")
  : path.join(__dirname, "..", "data");
