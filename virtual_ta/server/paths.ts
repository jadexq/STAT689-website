// Where mutable state lives. Locally that is this project's own data/ and
// output/ folders; in the container DATA_DIR points at a writable local
// directory shared by both servers.
//
// output/ is deliberately a sibling of data/, not a child: it is served
// over HTTP (/output/...) and the two have different lifetimes.
//
// DATA_DIR is deliberately NOT a mounted bucket any more — see
// ../../virtual_space/server/paths.ts and the deployment plan, §14f.
// docker/sync.mjs restores this tree at boot and snapshots it on a timer.

import path from "node:path";

const PROJECT = path.join(import.meta.dirname, "..");
const ROOT = process.env.DATA_DIR?.trim();

export const DATA_DIR = ROOT ? path.join(ROOT, "ta") : path.join(PROJECT, "data");
export const OUTPUT_DIR = ROOT ? path.join(ROOT, "output") : path.join(PROJECT, "output");
