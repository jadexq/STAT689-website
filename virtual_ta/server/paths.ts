// Where mutable state lives. Locally that is this project's own data/ and
// output/ folders; on Cloud Run the container filesystem is ephemeral, so
// DATA_DIR points at a mounted GCS bucket shared by both servers.
//
// output/ is deliberately a sibling of data/, not a child: it is served
// over HTTP (/output/...) and the two have different lifetimes.

import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const MOUNT = process.env.DATA_DIR?.trim();

export const DATA_DIR = MOUNT ? path.join(MOUNT, "ta") : path.join(ROOT, "data");
export const OUTPUT_DIR = MOUNT ? path.join(MOUNT, "output") : path.join(ROOT, "output");
