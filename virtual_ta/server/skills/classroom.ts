// In-class skill (M7–M8): the browser streams the live lecture transcript
// to /api/listen (Web Speech API); this skill answers on demand over that
// rolling transcript + the course materials, and exports Markdown class
// notes when asked to "take notes".

import { chatLLM } from "../llm.ts";
import { BASE_PERSONA } from "../persona.ts";
import { listReadings } from "../materials.ts";
import { writeClassNotes } from "../logger.ts";
import { classTranscriptText, transcriptText, type Session } from "../session.ts";
import type { SkillResult } from "./types.ts";

const NOTES_RE = /\b(take|export|save|write)\s+(the\s+|some\s+)?notes\b/i;

export async function classroom(session: Session, message: string): Promise<SkillResult> {
  const text = message.replace(/^\/class\s*/i, "").trim() || message.trim();
  // Prefer the class-wide transcript (the lecturer's mic via the virtual
  // space); fall back to this session's own mic buffer (the TA's web client).
  const transcript = classTranscriptText() || transcriptText(session);

  if (NOTES_RE.test(text)) {
    if (!transcript) {
      return { reply: "I don't have any lecture transcript yet — flip on classroom listening (the mic) and I'll take notes from what I hear." };
    }
    const markdown = await chatLLM(
      `${BASE_PERSONA}

Turn the raw (speech-recognized, possibly noisy) lecture transcript below into clean, well-structured Markdown class notes: a title with today's date, the key points in order, any definitions, examples, and code that came up, and a short "open questions" list if anything was left unresolved. Fix obvious speech-recognition glitches silently. Output only the Markdown.`,
      [{ role: "user", content: transcript }],
      { maxTokens: 2000, temperature: 0.4 }
    );
    const file = await writeClassNotes(markdown);
    return { reply: `Notes saved. Here's what I captured:\n\n${markdown}`, artifacts: [{ path: file }] };
  }

  const readings = await listReadings().catch(() => []);
  const system = `${BASE_PERSONA}

You are in IN-CLASS mode: a lecture is happening right now and the rolling live transcript is below. The instructor or a student is asking you something mid-class.
Rules:
- Answer fast and factually, grounded first in the live transcript, then in general knowledge of the topic — and say which you're drawing on if it matters.
- Writing code when asked is encouraged; keep it minimal and runnable.
- Keep replies tight; people are in class.
Assigned readings this term (for context): ${readings.map((r) => r.title).join("; ") || "none listed"}.

LIVE TRANSCRIPT SO FAR:
---
${transcript || "(no transcript captured yet — listening may be off)"}
---`;

  const reply = await chatLLM(system, session.history, { maxTokens: 700, temperature: 0.5 });
  return { reply };
}
