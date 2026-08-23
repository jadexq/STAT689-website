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
import { listReadings, loadReading, matchReading, passageBlock, searchMaterials } from "../materials.ts";
import { readQuestions, recordQuestion, writeDigest } from "../logger.ts";
import type { Session } from "../session.ts";
import type { SkillResult } from "./types.ts";

// Announcements and the agenda, as the space reported them this turn. The
// ordering rule matters: a reading can say "the homework is due Friday" and be
// a year out of date, while the board is what the instructor pinned today.
function bulletinBlock(session: Session): string {
  if (!session.bulletin) return "";
  return `

COURSE NOTICEBOARD — what the instructor has posted, and the agenda:
---
${session.bulletin}
---
Rule: for logistics — dates, deadlines, what is assigned, what happens when — the noticeboard above is authoritative and overrides anything a reading says. For everything else, the readings are the source.`;
}

const DIGEST_RE = /\b(digest|question summary|summarize .* questions|what .* students ask)\b/i;

export async function coach(session: Session, message: string): Promise<SkillResult> {
  const text = message.replace(/^\/coach\s*/i, "").trim() || message.trim();

  // Instructor asking for the collected-questions digest
  if (DIGEST_RE.test(text)) return questionDigest(session, text);

  // The student names the reading; we never coach outside the assigned set
  const named = await matchReading(text);
  if (named) session.readingId = named.id;
  if (!session.readingId) {
    // Nothing in focus: search every document for the passages that answer
    // this question. The student never has to know which file it lives in —
    // that is the whole point of asking a TA rather than a folder.
    const readings = await listReadings();
    const list = readings.map((r) => `- ${r.title}${r.link ? ` (${r.link})` : ""}`).join("\n");
    const passages = await searchMaterials(text);

    if (passages.length) {
      const found = [...new Set(passages.map((p) => p.title))];
      const system = `${BASE_PERSONA}${bulletinBlock(session)}

A student asked a question. The passages below were retrieved from the course materials because they look relevant.
Rules:
- Answer directly and completely, grounded in these passages.
- Name the document each part of your answer came from, so the student can go and read it.
- The passages are excerpts, not whole documents. If they do not actually answer the question, say so, then answer from general knowledge and label that clearly as outside the course material.
- Never present general knowledge as something a course document says.
- Keep it to three or four sentences plus at most one small code snippet unless they ask for more.
- Write plain conversational sentences, the way you would say it out loud. No headings, no bullet lists, no tables — this is rendered in a small chat bubble, not a document. Bold at most one phrase.

RETRIEVED PASSAGES:
${passageBlock(passages)}`;
      const reply = await chatLLM(system, session.history, { maxTokens: 600, temperature: 0.7 });
      return { reply, data: { sources: found } };
    }

    // Nothing matched. Say so rather than implying the materials were
    // consulted and agreed — a confident answer with no source is exactly
    // what students should not learn to trust here.
    const system = `${BASE_PERSONA}${bulletinBlock(session)}

A student has asked you something, and nothing in the course materials matched it.
Rules:
- Answer their question directly and helpfully, and say plainly that this one is not covered by the course materials — you are answering from general knowledge.
- If they ask what materials are available, list the course documents below with their links.

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

  const system = `${BASE_PERSONA}${bulletinBlock(session)}

You are answering a student's question about the course document "${loaded.reading.title}".
Rules:
- Answer directly and completely. Do not withhold the answer or turn it back into a question.
- Ground the answer in the document below, and say where it comes from — quote or point to the part you used, so the student can go and read it.
- If the document does not cover what they asked, say so plainly, then answer from general knowledge and label it as outside the course material. Never dress up general knowledge as something the document says.
- Keep it to three or four sentences plus at most one small code snippet unless they ask for more.
- Write plain conversational sentences, the way you would say it out loud. No headings, no bullet lists, no tables — this is rendered in a small chat bubble, not a document. Bold at most one phrase.

THE DOCUMENT — "${loaded.reading.title}":
---
${loaded.text}
---`;

  const reply = await chatLLM(system, session.history, { maxTokens: 600, temperature: 0.7 });
  return { reply, data: { sources: [loaded.reading.title] } };
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
