// The TA's one skill: answer a student's question directly, grounded in the
// course materials, saying which document the answer came from. Also collects
// their questions into a per-reading digest the instructor can ask for.
//
// It used to be Socratic — hints and counter-questions, never the answer.
// The instructor changed that on 2026-08-22: students should get an answer,
// with the source named so they can go read it. The name `coach` stayed
// because `session.mode` is persisted and restored from logged turns, so
// renaming it would strand every existing conversation's sticky mode.

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

A student has asked you something, and no course document is in focus yet.
Rules:
- Answer their question directly and helpfully. Be clear that you are answering from general knowledge, not from the course materials.
- If they ask what materials are available, list the course documents below with their links.
- If one of the documents below plainly covers their question, name it and offer to answer from it.

COURSE MATERIALS:
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

You are answering a student's question about the course document "${loaded.reading.title}".
Rules:
- Answer directly and completely. Do not withhold the answer or turn it back into a question.
- Ground the answer in the document below, and say where it comes from — quote or point to the part you used, so the student can go and read it.
- If the document does not cover what they asked, say so plainly, then answer from general knowledge and label it as outside the course material. Never dress up general knowledge as something the document says.
- Keep it to a few sentences plus at most one small code snippet unless they ask for more.

THE DOCUMENT — "${loaded.reading.title}":
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
