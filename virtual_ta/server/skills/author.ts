// Author skill (M9): drafts lecture notes (Markdown) or a self-contained
// HTML slide deck (no external dependencies, arrow-key navigation) into
// output/. Grounds on a named reading or the captured class transcript
// when one is available.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chatLLM } from "../llm.ts";
import { BASE_PERSONA } from "../persona.ts";
import { loadReading, matchReading } from "../materials.ts";
import { transcriptText, type Session } from "../session.ts";
import type { SkillResult } from "./types.ts";

const OUTPUT_DIR = path.join(import.meta.dirname, "..", "..", "output");
const DECK_RE = /\b(slide|slides|deck|presentation)\b/i;

export async function author(session: Session, message: string): Promise<SkillResult> {
  const text = message.replace(/^\/(notes|slides)\s*/i, "").trim() || message.trim();
  const wantDeck = DECK_RE.test(message);

  // Grounding: a named reading first, else the live-class transcript
  let grounding = "";
  const named = await matchReading(text);
  if (named) {
    const loaded = await loadReading(named.id);
    if (loaded) grounding = `SOURCE MATERIAL — "${loaded.reading.title}":\n${loaded.text}`;
  } else if (transcriptText(session)) {
    grounding = `CAPTURED CLASS TRANSCRIPT:\n${transcriptText(session)}`;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  if (wantDeck) {
    const html = await chatLLM(
      `${BASE_PERSONA}

You are in AUTHORING mode, producing an HTML lecture slide deck.
Output a COMPLETE, SELF-CONTAINED HTML document and nothing else (no Markdown fences, no commentary):
- All CSS and JS inline; zero external resources (it must work offline from a file).
- One <section class="slide"> per slide; navigation with ←/→ arrow keys, Space, and click; a slide counter.
- Clean, modern lecture styling: large readable type, a title slide, an agenda, content slides with at most ~5 bullets each, code in <pre><code> blocks where relevant, and a closing summary slide.
- 8–14 slides unless the request says otherwise.
${grounding ? `Base the content on the source below; do not invent claims beyond it.\n\n${grounding}` : "Base the content on the request itself; keep claims standard and uncontroversial."}`,
      [{ role: "user", content: text }],
      { maxTokens: 8000, temperature: 0.6 }
    );
    const cleaned = html.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "").trim();
    const file = path.join(OUTPUT_DIR, `slides-${slug(text)}-${stamp}.html`);
    await writeFile(file, cleaned, "utf8");
    const url = `/output/${path.basename(file)}`;
    return {
      reply: `Deck's ready — ${countSlides(cleaned)} slides, self-contained HTML (works offline, arrow keys to navigate). Open it at ${url} or from \`${file}\`. Want me to restructure, retheme, or expand any slide?`,
      artifacts: [{ path: file, url }],
    };
  }

  const markdown = await chatLLM(
    `${BASE_PERSONA}

You are in AUTHORING mode, producing instructor lecture notes in clean Markdown: a clear heading structure, key concepts with crisp explanations, worked examples or code where they help, and a short recap at the end. Output only the Markdown.
${grounding ? `Base the content on the source below; do not invent claims beyond it.\n\n${grounding}` : ""}`,
    [{ role: "user", content: text }],
    { maxTokens: 4000, temperature: 0.6 }
  );
  const file = path.join(OUTPUT_DIR, `notes-${slug(text)}-${stamp}.md`);
  await writeFile(file, markdown, "utf8");
  return {
    reply: `Notes drafted and saved to \`${file}\`. Here they are:\n\n${markdown}`,
    artifacts: [{ path: file, url: `/output/${path.basename(file)}` }],
  };
}

function slug(text: string): string {
  return (
    text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 5).join("-") || "draft"
  );
}

function countSlides(html: string): number {
  return (html.match(/class="slide"/g) || []).length || 1;
}
