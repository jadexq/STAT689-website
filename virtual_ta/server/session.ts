// In-memory session store — one Session per browser tab. Holds the sticky
// mode, recent chat history, the selected reading, and the rolling in-class
// transcript. Restarting the server clears sessions; the JSONL logs in
// data/ are the durable record.

import type { ChatMessage } from "./llm.ts";

export type SkillName = "coach" | "classroom" | "author" | "review" | "announce";

export interface Session {
  id: string;
  mode: SkillName | null;
  history: ChatMessage[];
  readingId: string | null;
  transcript: string[];
  listening: boolean;
  startedAt: string;
}

const sessions = new Map<string, Session>();

const HISTORY_LIMIT = 24; // turns kept in the prompt window
const TRANSCRIPT_LIMIT = 12_000; // chars of rolling class transcript

export function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      mode: null,
      history: [],
      readingId: null,
      transcript: [],
      listening: false,
      startedAt: new Date().toISOString(),
    };
    sessions.set(id, s);
  }
  return s;
}

export function pushHistory(s: Session, role: "user" | "assistant", content: string): void {
  s.history.push({ role, content });
  if (s.history.length > HISTORY_LIMIT) s.history.splice(0, s.history.length - HISTORY_LIMIT);
}

export function appendTranscript(s: Session, text: string): void {
  s.transcript.push(text.trim());
  // trim from the front when the rolling buffer grows past the limit
  while (s.transcript.join(" ").length > TRANSCRIPT_LIMIT && s.transcript.length > 1) {
    s.transcript.shift();
  }
}

export function transcriptText(s: Session): string {
  return s.transcript.join(" ");
}

// ---------- class-wide lecture transcript ----------
// Single writer: the lecturer's mic (forwarded by the virtual space with
// scope:"class"). Read by the classroom skill on behalf of any student —
// private on the write side, shared on the read side. One class per
// process, so a module-level buffer is enough.

const classTranscript: string[] = [];

export function appendClassTranscript(text: string): void {
  classTranscript.push(text.trim());
  while (classTranscript.join(" ").length > TRANSCRIPT_LIMIT && classTranscript.length > 1) {
    classTranscript.shift();
  }
}

export function classTranscriptText(): string {
  return classTranscript.join(" ");
}
