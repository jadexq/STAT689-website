// Virtual TA — one Express 5 process, one identity. Serves the unified
// chat client, routes every /api/chat message through the hybrid intent
// router to a skill, and buffers the live class transcript on /api/listen.
// Binds localhost only; the only outbound calls are the LLM API and (for
// PR review) GitHub.

import express from "express";
import path from "node:path";
import { llmInfo } from "./llm.ts";
import { listReadings } from "./materials.ts";
import { OUTPUT_DIR } from "./paths.ts";
import { appendClassTranscriptLine, initStorage, logTurn } from "./logger.ts";
import {
  appendClassTranscript,
  appendTranscript,
  classTranscriptText,
  ensureSession,
  pushHistory,
  type Session,
  type SkillName,
} from "./session.ts";
import { CLARIFY_REPLY, CLASSROOM_ENABLED, route } from "./router.ts";
import { coach } from "./skills/coach.ts";
import { classroom } from "./skills/classroom.ts";
import { author } from "./skills/author.ts";
import { review } from "./skills/review.ts";
import { announce } from "./skills/announce.ts";
import type { SkillResult } from "./skills/types.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PORT = Number(process.env.PORT || 3000);

const skills: Record<SkillName, (s: Session, m: string) => Promise<SkillResult>> = {
  coach,
  classroom,
  author,
  review,
  announce,
};

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "client")));
app.use("/output", express.static(OUTPUT_DIR));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ...llmInfo() });
});

app.get("/api/materials", async (_req, res) => {
  const readings = await listReadings();
  res.json({ readings: readings.map(({ id, title, link }) => ({ id, title, link })) });
});

app.post("/api/listen", async (req, res) => {
  const { sessionId, text, active, scope } = req.body ?? {};
  // scope:"class" — the lecturer's mic, forwarded by the virtual space:
  // goes to the class-wide transcript, not any per-student session.
  if (scope === "class") {
    if (typeof text === "string" && text.trim()) {
      appendClassTranscript(text);
      await appendClassTranscriptLine(text.trim());
    }
    res.json({ ok: true, scope: "class", transcriptChars: classTranscriptText().length });
    return;
  }
  if (typeof sessionId !== "string" || !sessionId) {
    res.status(400).json({ error: "sessionId required" });
    return;
  }
  const session = await ensureSession(sessionId);
  if (typeof active === "boolean") session.listening = active;
  if (typeof text === "string" && text.trim()) appendTranscript(session, text);
  res.json({ ok: true, listening: session.listening, transcriptChars: session.transcript.join(" ").length });
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message, readingId, skill: forcedSkill } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "sessionId and message required" });
    return;
  }
  const session = await ensureSession(sessionId);
  if (typeof readingId === "string" && readingId) session.readingId = readingId;

  pushHistory(session, "user", message);
  await logTurn({ sessionId, role: "user", skill: session.mode, readingId: session.readingId, content: message });

  // An explicit, valid skill (e.g. from the virtual space's room-based
  // modes) bypasses the router; otherwise route as usual.
  // A disabled skill must be unreachable over the wire too: the virtual
  // space sends room-based modes, and a stale client could still name one.
  const forcedOk =
    typeof forcedSkill === "string" &&
    forcedSkill in skills &&
    (CLASSROOM_ENABLED || forcedSkill !== "classroom");
  const routed = forcedOk ? (forcedSkill as SkillName) : await route(session, message);
  let result: SkillResult;
  let skill: string;
  if (routed === "clarify") {
    skill = "clarify";
    result = { reply: CLARIFY_REPLY };
  } else {
    session.mode = routed;
    skill = routed;
    result = await skills[routed](session, message);
  }

  pushHistory(session, "assistant", result.reply);
  await logTurn({ sessionId, role: "assistant", skill, readingId: session.readingId, content: result.reply });

  res.json({ reply: result.reply, skill, artifacts: result.artifacts ?? [], data: result.data ?? null });
});

// Express 5 propagates async errors here natively
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[virtual-ta] ${err.message}`);
  res.status(500).json({ error: err.message });
});

await initStorage();
app.listen(PORT, "127.0.0.1", () => {
  const { provider, model } = llmInfo();
  console.log(`Virtual TA up — http://localhost:${PORT} (LLM: ${provider}/${model})`);
});
