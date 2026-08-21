// Announce skill (Part 5 · Update 1): compose a short class-wide
// announcement — an AI news/paper highlight from an instructor-supplied
// link, or a plain reminder. One-to-one by design: it returns the composed
// text to the caller; DISTRIBUTION to students is the virtual space's job
// (an admin-gated dispatch there). Each announcement is saved to output/
// and appended to the class-wide log data/class/announcements.jsonl.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { OUTPUT_DIR } from "../paths.ts";
import { extractText } from "unpdf";
import { chatLLM } from "../llm.ts";
import { BASE_PERSONA } from "../persona.ts";
import { stripHtml } from "../materials.ts";
import { appendAnnouncement } from "../logger.ts";
import type { Session } from "../session.ts";
import type { SkillResult } from "./types.ts";

// output/ location comes from paths.ts (a GCS mount in the cloud)
const URL_RE = /https?:\/\/[^\s)>"']+/;
const MAX_SOURCE_CHARS = 20_000;

export async function announce(session: Session, message: string): Promise<SkillResult> {
  const text = message.replace(/^\/announce\s*/i, "").trim() || message.trim();
  const url = text.match(URL_RE)?.[0] ?? null;

  let source = "";
  if (url) {
    try {
      source = await fetchReadable(url);
    } catch (err) {
      return {
        reply: `I couldn't read that link (${(err as Error).message}). Static pages work best — an arXiv abstract page, a blog post, or a PDF link. Want to try another URL, or paste the text directly?`,
      };
    }
    if (!source.trim()) {
      return {
        reply: `That page didn't yield readable text — it may be JavaScript-heavy or paywalled. An arXiv abstract page, a blog post, or a PDF link works best; or paste the key text and I'll compose from that.`,
      };
    }
  }

  const system = `${BASE_PERSONA}

You are in ANNOUNCE mode, composing a short class-wide announcement on the instructor's behalf (they will distribute it to all students).
Rules:
- 3–6 sentences, warm and plain-language: what it is, why it matters for this course, and what (if anything) students should do.
- ${
    url
      ? "Ground strictly in the SOURCE text below — do not claim anything beyond it. End the announcement with the source link."
      : "There is no source link; compose directly from the instructor's instruction (e.g. a reminder or heads-up)."
  }
- Output ONLY the announcement text, ready to send — no preamble, no commentary.`;

  const userContent = url ? `Instruction: ${text}\n\nSOURCE (${url}):\n${source}` : text;
  const composed = await chatLLM(
    system,
    [...session.history.slice(0, -1), { role: "user", content: userContent }],
    { maxTokens: 500, temperature: 0.6 }
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(OUTPUT_DIR, `announce-${stamp}.md`);
  await writeFile(file, composed + (url ? `\n\nSource: ${url}\n` : "\n"), "utf8");
  await appendAnnouncement({ sessionId: session.id, url, instruction: text, text: composed });

  return {
    reply: `Here's the announcement, ready to send:\n\n${composed}\n\nSaved to \`${file}\` and logged in the class record. Want it shorter, longer, or in a different tone?`,
    artifacts: [{ path: file, url: `/output/${path.basename(file)}` }],
    data: { announcement: composed },
  };
}

// Fetch an instructor-supplied URL and reduce it to readable text.
// HTML is tag-stripped; PDFs go through unpdf. Truncated for the prompt.
async function fetchReadable(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "virtual-ta" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  let text: string;
  if (contentType.includes("pdf") || new URL(url).pathname.toLowerCase().endsWith(".pdf")) {
    const buf = new Uint8Array(await res.arrayBuffer());
    text = (await extractText(buf, { mergePages: true })).text;
  } else {
    text = stripHtml(await res.text());
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) + "\n[…source truncated…]" : text;
}
