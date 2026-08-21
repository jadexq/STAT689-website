// Plain-file persistence, all under data/ (git-ignored):
//   data/logs/<session>.jsonl   — every chat turn, one JSON object per line
//   data/digests/<reading>-digest-<ts>.md — generated question digests
//   data/digests/<reading>.md   — student questions collected per reading
//   data/class-notes-*.md       — exported in-class notes
// No database; these files are the durable record across restarts.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, OUTPUT_DIR } from "./paths.ts";

// One file per CONVERSATION, keyed by sessionId. That is only sound
// because a sessionId is now a stable identity (space:<email>) rather than
// a per-run label — which is exactly what lets a conversation be replayed
// after a restart or a scale-to-zero cold start. The run is recorded on
// each line instead of in the path: still distinguishable, no longer
// fragmenting a student's history into one directory per server start.
// (Logs written before this change stay under data/logs/<run>/ and are
// not replayed.)
const LOGS_DIR = path.join(DATA_DIR, "logs");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const DIGESTS_DIR = path.join(DATA_DIR, "digests");
// Shared, class-wide records (vs. per-student logs): announcements now,
// the shared lecture transcript later.
const CLASS_DIR = path.join(DATA_DIR, "class");

export async function initStorage(): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true });
  await mkdir(DIGESTS_DIR, { recursive: true });
  await mkdir(CLASS_DIR, { recursive: true });
  // Generated notes/slides/announcements. Created here rather than in each
  // skill: announce.ts writes straight into it, and on a fresh DATA_DIR
  // (any new container) nothing else would have made it first.
  await mkdir(OUTPUT_DIR, { recursive: true });
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

export interface LoggedTurn {
  ts: string;
  run: string;
  sessionId: string;
  role: "user" | "assistant";
  skill: string | null;
  readingId?: string | null;
  content: string;
}

export async function logTurn(entry: {
  sessionId: string;
  role: "user" | "assistant";
  skill: string | null;
  readingId?: string | null;
  content: string;
}): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), run: RUN_ID, ...entry }) + "\n";
  const file = path.join(LOGS_DIR, `${safe(entry.sessionId)}.jsonl`);
  await appendFile(file, line, "utf8");
}

// The last `limit` turns of one conversation, oldest first — the raw
// material for rebuilding an in-memory session that a restart threw away.
// A missing file just means we have never met this person.
export async function readTurns(sessionId: string, limit: number): Promise<LoggedTurn[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(LOGS_DIR, `${safe(sessionId)}.jsonl`), "utf8");
  } catch {
    return [];
  }
  const out: LoggedTurn[] = [];
  for (const line of raw.split("\n").slice(-limit - 8)) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line) as LoggedTurn;
      if (typeof t?.content === "string" && (t.role === "user" || t.role === "assistant")) out.push(t);
    } catch {
      // a torn final line (killed mid-write) is not worth failing over
    }
  }
  return out.slice(-limit);
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
