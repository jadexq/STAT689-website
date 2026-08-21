// Lightweight JSONL logging (MVP requirement M6). One file per server
// start, under data/. Every trajectory step, chat message, broadcast,
// and admin action is appended as one JSON line.

import fs from "fs";
import path from "path";

const dir = path.join(__dirname, "..", "data");
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date()
  .toISOString()
  .replace(/[:T]/g, "-")
  .replace(/\..+/, "");
const file = path.join(dir, `session-${stamp}.jsonl`);

export function logEvent(type: string, data: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), type, ...data });
  fs.appendFile(file, line + "\n", () => {});
}

export function logFilePath(): string {
  return file;
}
