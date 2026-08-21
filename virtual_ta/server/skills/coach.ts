// Coach skill (M3–M5): Socratic coaching grounded ONLY in the reading the
// student names, plus collection of their questions into a per-reading
// digest the instructor can ask for.

import { chatLLM } from "../llm.ts";
import { BASE_PERSONA } from "../persona.ts";
import { listReadings, loadReading, matchReading } from "../materials.ts";
import { readQuestions, recordQuestion, writeDigest } from "../logger.ts";
import type { Session } from "../session.ts";
import type { SkillResult } from "./types.ts";

const DIGEST_RE = /\b(digest|question summary|summarize .* questions|what .* students ask)\b/i;

export async function coach(session: Session, message: string): Promise<SkillResult> {
  const text = message.replace(/^\/coach\s*/i, "").trim() || message.trim();

  // Instructor asking for the collected-questions digest
  if (DIGEST_RE.test(text)) return questionDigest(session, text);

  // The student names the reading; we never coach outside the assigned set
  const named = await matchReading(text);
  if (named) session.readingId = named.id;
  if (!session.readingId) {
    // No reading picked yet: answer the student's question first, then
    // invite them to pick one — never stonewall with just the list.
    const readings = await listReadings();
    const list = readings.map((r) => `- ${r.title}${r.link ? ` (${r.link})` : ""}`).join("\n");
    const system = `${BASE_PERSONA}

You are in COACHING mode, but the student has not picked an assigned reading yet.
Rules:
- First, answer their message directly and helpfully — briefly, from the reading list below or general knowledge. If they ask what materials are available, list the assigned readings with their links.
- Then close by inviting them to pick one of the assigned readings (by title or link) so you can coach them through it.
- Do not start Socratic coaching until a reading is chosen.

ASSIGNED READINGS:
${list}`;
    const reply = await chatLLM(system, session.history, { maxTokens: 500, temperature: 0.7 });
    return { reply };
  }

  const loaded = await loadReading(session.readingId);
  if (!loaded) {
    session.readingId = null;
    return { reply: "Hmm, I couldn't load that reading. Could you name it again, or pick another assigned one?" };
  }

  // Collect the student's question for the instructor digest
  if (text.includes("?")) await recordQuestion(loaded.reading.id, text);

  const system = `${BASE_PERSONA}

You are in COACHING mode, working through the assigned reading "${loaded.reading.title}" with a student before class (flipped classroom).
Rules:
- Be Socratic: guide with questions and hints; do NOT hand over full answers or summaries the student should build themselves. Confirm and extend their correct steps.
- Ground everything strictly in the reading below. If asked about something the reading doesn't cover, say so and steer back.
- Keep each reply short (a few sentences, at most one small code snippet), and end most replies with one probing question.

THE READING:
---
${loaded.text}
---`;

  const reply = await chatLLM(system, session.history, { maxTokens: 600, temperature: 0.7 });
  return { reply };
}

async function questionDigest(session: Session, text: string): Promise<SkillResult> {
  let readingId = session.readingId;
  const named = await matchReading(text);
  if (named) readingId = named.id;
  if (!readingId) {
    return { reply: "Which reading's question digest do you want? Name the reading and I'll pull it together." };
  }
  const raw = await readQuestions(readingId);
  if (!raw.trim()) {
    return { reply: `No student questions collected for **${readingId}** yet — they'll accumulate here as students ask things while I coach them.` };
  }
  const markdown = await chatLLM(
    `${BASE_PERSONA}

You are preparing an instructor-facing digest of the questions students asked while working through the reading "${readingId}". Organize the raw questions below into a clean Markdown digest: group them by theme, merge duplicates, order themes by how often they came up, and add a one-line "what students are struggling with" summary at the top. Output only the Markdown.`,
    [{ role: "user", content: raw }],
    { maxTokens: 1200, temperature: 0.4 }
  );
  const file = await writeDigest(readingId, markdown);
  return { reply: markdown, artifacts: [{ path: file }] };
}
