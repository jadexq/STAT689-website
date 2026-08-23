// In-memory session store — one Session per student identity. Holds the
// sticky mode, recent chat history, the selected reading, and the rolling
// in-class transcript.
//
// RAM does not survive a restart, and on Cloud Run with min-instances=0
// every quiet spell is a restart. So the map is a cache, not the record:
// on a miss, ensureSession() rebuilds the session from the JSONL turn log,
// which IS the record. A student who comes back after class should not
// have to reintroduce themselves.

import type { ChatMessage } from "./llm.ts";
import { readTurns } from "./logger.ts";

export type SkillName = "coach" | "classroom" | "author" | "review" | "announce";

export interface Session {
  id: string;
  mode: SkillName | null;
  history: ChatMessage[];
  readingId: string | null;
  transcript: string[];
  // Course logistics the space knows and the brain does not: the instructor's
  // announcements and the agenda. Set per request from the caller, never
  // persisted and never rebuilt from the turn log — it is current state, not
  // conversation history, and a stale deadline is worse than none.
  bulletin: string | null;
  listening: boolean;
  startedAt: string;
}

const sessions = new Map<string, Session>();

const HISTORY_LIMIT = 24; // turns kept in the prompt window
const TRANSCRIPT_LIMIT = 12_000; // chars of rolling class transcript

/**
 * The session for `id`, rebuilt from disk if it is not in memory.
 *
 * Prefer this over getSession() anywhere a real conversation is happening.
 * Concurrent first-touches share one load: two messages arriving together
 * after a cold start must not each replay the log into the same session.
 */
export function ensureSession(id: string): Promise<Session> {
  const live = sessions.get(id);
  if (live) return Promise.resolve(live);
  let inflight = hydrating.get(id);
  if (!inflight) {
    inflight = hydrate(id).finally(() => hydrating.delete(id));
    hydrating.set(id, inflight);
  }
  return inflight;
}

const hydrating = new Map<string, Promise<Session>>();

async function hydrate(id: string): Promise<Session> {
  const s = getSession(id);
  const turns = await readTurns(id, HISTORY_LIMIT);
  if (!turns.length) return s;
  for (const t of turns) s.history.push({ role: t.role, content: t.content });
  // Restore the sticky mode and reading from the most recent turn that had
  // them. "clarify" is not a skill — it is the router giving up — so it
  // must not become a mode, exactly as when running live.
  for (let i = turns.length - 1; i >= 0; i--) {
    if (!s.mode && turns[i].role === "assistant") {
      const skill = turns[i].skill;
      if (skill && skill !== "clarify") s.mode = skill as SkillName;
    }
    if (!s.readingId && turns[i].readingId) s.readingId = turns[i].readingId!;
    if (s.mode && s.readingId) break;
  }
  console.log(`[virtual-ta] restored ${turns.length} turns for ${id}${s.mode ? ` (mode: ${s.mode})` : ""}`);
  return s;
}

// Synchronous, memory-only. Callers that might be meeting a student for
// the first time after a restart want ensureSession() instead.
export function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      mode: null,
      history: [],
      readingId: null,
      transcript: [],
      bulletin: null,
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
