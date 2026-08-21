// Where mutable state lives. Locally that is this project's own data/
// folder; on Cloud Run the container filesystem is ephemeral, so DATA_DIR
// points at a mounted GCS bucket shared by both servers — each gets its
// own subdirectory so their files never collide.

import path from "path";

const MOUNT = process.env.DATA_DIR?.trim();

export const DATA_DIR = MOUNT
  ? path.join(MOUNT, "space")
  : path.join(__dirname, "..", "data");
