// Plain-file persistence, all under data/ (git-ignored):
//   data/logs/<run>/<session>.jsonl — every chat turn, one JSON object per line
//   data/digests/<reading>-digest-<ts>.md — generated question digests
//   data/digests/<reading>.md   — student questions collected per reading
//   data/class-notes-*.md       — exported in-class notes
// No database; these files are the durable record across restarts.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const LOGS_DIR = path.join(DATA_DIR, "logs");
// One directory per server start. A sessionId is not unique across runs —
// the space derives it from the student's name ("space:Jade") — and sessions
// are in-memory only, so a restart genuinely is a new conversation. Without
// this, a later run appends into the earlier run's file and buries it.
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_LOGS_DIR = path.join(LOGS_DIR, RUN_ID);
const DIGESTS_DIR = path.join(DATA_DIR, "digests");
// Shared, class-wide records (vs. per-student logs): announcements now,
// the shared lecture transcript later.
const CLASS_DIR = path.join(DATA_DIR, "class");

export async function initStorage(): Promise<void> {
  await mkdir(RUN_LOGS_DIR, { recursive: true });
  await mkdir(DIGESTS_DIR, { recursive: true });
  await mkdir(CLASS_DIR, { recursive: true });
}

// Durable copy of the class-wide lecture transcript, one file per day.
export async function appendClassTranscriptLine(text: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const line = JSON.stringify({ ts: new Date().toISOString(), text }) + "\n";
  await appendFile(path.join(CLASS_DIR, `transcript-${day}.jsonl`), line, "utf8");
}

export async function appendAnnouncement(entry: {
  sessionId: string;
  url: string | null;
  instruction: string;
  text: string;
}): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  await appendFile(path.join(CLASS_DIR, "announcements.jsonl"), line, "utf8");
}

export async function logTurn(entry: {
  sessionId: string;
  role: "user" | "assistant";
  skill: string | null;
  content: string;
}): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  const file = path.join(RUN_LOGS_DIR, `${safe(entry.sessionId)}.jsonl`);
  await appendFile(file, line, "utf8");
}

// Collect a student question under its reading; the coach skill later
// organizes these into a clean digest on request.
export async function recordQuestion(readingId: string, question: string): Promise<void> {
  const file = path.join(DIGESTS_DIR, `${safe(readingId)}.md`);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  await appendFile(file, `- (${stamp}) ${question.replace(/\s+/g, " ").trim()}\n`, "utf8");
}

export async function readQuestions(readingId: string): Promise<string> {
  try {
    return await readFile(path.join(DIGESTS_DIR, `${safe(readingId)}.md`), "utf8");
  } catch {
    return "";
  }
}

export async function writeDigest(readingId: string, markdown: string): Promise<string> {
  // Timestamped: regenerating a digest must not discard the previous one —
  // these are the collected student questions, not a regenerable artifact.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(DIGESTS_DIR, `${safe(readingId)}-digest-${stamp}.md`);
  await writeFile(file, markdown, "utf8");
  return file;
}

export async function writeClassNotes(markdown: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(DATA_DIR, `class-notes-${stamp}.md`);
  await writeFile(file, markdown, "utf8");
  return file;
}

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}
