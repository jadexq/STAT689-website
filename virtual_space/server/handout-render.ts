// The handout page: one student, one version per section, one page.
//
// Built on render.ts rather than beside it — same CSS, same table treatment,
// same "opens in its own tab and must not depend on the campus bundle" rule.
// What it adds is math, because the GPT chapter is nanoGPT and a handout that
// cannot set an equation is not usable for it.
//
// Math goes through its OWN marked instance. render.ts's global `marked` is
// what course readings use, and a reading that says "$5 and $10 in the same
// line" must keep saying that rather than quietly becoming a formula. Two
// instances, two dialects, no shared mutable options.

import katex from "katex";
import { Marked, type TokenizerAndRendererExtension } from "marked";
import { BASE_CSS, escapeHtml, wrapTables } from "./render";
import type { Bundle, Section } from "./handout-format";

// throwOnError:false renders a malformed expression in red instead of taking
// the whole page down. One typo in one formula must not blank a handout the
// student is being asked to grade.
function tex(src: string, displayMode: boolean): string {
  return katex.renderToString(src, { displayMode, throwOnError: false, strict: false });
}

const mathBlock: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  start: (src) => src.indexOf("$$"),
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$(?:\n+|$)/.exec(src);
    if (m) return { type: "mathBlock", raw: m[0], text: m[1].trim() };
  },
  renderer: (t) => `<div class="math-block">${tex(t.text, true)}</div>`,
};

const mathInline: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start: (src) => src.indexOf("$"),
  tokenizer(src) {
    // No space just inside the delimiters, and no digit just after the closer,
    // so "$5 and $10" and "costs $20." stay prose. Inline code is safe without
    // help: the lexer consumes a backtick span whole before this ever sees the
    // dollar inside it.
    const m = /^\$(?![\s$])((?:\\.|[^$\\])+?)(?<![\s\\])\$(?!\d)/.exec(src);
    if (m) return { type: "mathInline", raw: m[0], text: m[1] };
  },
  renderer: (t) => tex(t.text, false),
};

const md = new Marked({ gfm: true, breaks: false });
md.use({ extensions: [mathBlock, mathInline] });

export function renderHandoutMarkdown(markdown: string): string {
  return wrapTables(md.parse(markdown, { async: false }) as string);
}

const HANDOUT_CSS = `
.hmeta { font-size: 13px; color: #8b96b3; margin: -.4em 0 2.4em; }
.hmeta .chip {
  background: #1d2335; border: 1px solid #2a3145; border-radius: 999px;
  padding: 2px 9px; margin-right: 7px; letter-spacing: .03em;
}
.preview {
  background: #2a2416; border: 1px solid #5a4a22; border-radius: 10px;
  padding: 11px 14px; font-size: 13.5px; margin: 0 0 2em; color: #f0d9a0;
}
.preview a { color: #f0c14b; font-weight: 600; }
.preview .vers { margin-left: 4px; }
.hsec { margin: 0 0 2.6em; }
.hsec > h2 { margin-top: 2.2em; }
.hsec .obj {
  font-size: 13.5px; color: #8b96b3; font-style: italic;
  border-left: 3px solid #2a3145; padding-left: 12px; margin: 0 0 1.4em;
}
.math-block { overflow-x: auto; overflow-y: hidden; padding: 2px 0 6px; margin: 0 0 1.1em; }
.katex { font-size: 1.04em; }
.hfoot { color: #8b96b3; font-size: 13px; border-top: 1px solid #2a3145; padding-top: 18px; margin-top: 3em; }
`;

export interface HandoutPageOpts {
  bundle: Bundle;
  /** section_id -> version_id, already resolved. */
  assigned: Record<string, string>;
  /** Set for the admin: names the version and says nothing is recorded. */
  preview?: string;
  /** Rendered after each section's prose. 4c puts the grading widget here. */
  afterSection?: (s: Section, versionId: string, index: number) => string;
  /** Injected before </body>. 4c puts the autosave script here. */
  scripts?: string;
  /** Injected into <head>. */
  head?: string;
}

export function renderHandoutPage(o: HandoutPageOpts): string {
  const { bundle, assigned } = o;
  const parts: string[] = [];

  for (const [i, s] of bundle.sections.entries()) {
    const versionId = o.preview ?? assigned[s.section_id];
    const body = s.bodies[versionId];
    if (!body) continue;
    parts.push(
      // No version id in the markup. Nothing client-side needs it — 4c posts a
      // section_id and the server looks the assignment up, because a record
      // must never take the version from the client — so putting it here would
      // be pure leak to anyone who opens view-source.
      `<section class="hsec" data-section="${escapeHtml(s.section_id)}">`,
      `<h2>${escapeHtml(s.title)}</h2>`,
      `<div class="obj">${escapeHtml(s.learning_objective)}</div>`,
      renderHandoutMarkdown(body.markdown),
      o.afterSection?.(s, versionId, i) ?? "",
      `</section>`
    );
  }

  // The version id is deliberately absent from the student's page. It appears
  // only in the admin's preview banner: a student who can see which arm they
  // are in is reading a study, not a handout.
  const banner = o.preview
    ? `<div class="preview">👁 <b>Instructor preview</b> — showing version
       <b class="vers">${escapeHtml(o.preview)}</b> of every section. Nothing you do here is recorded.
       ${bundle.versions
         .map((v) =>
           v === o.preview
             ? ""
             : ` <a href="?version=${encodeURIComponent(v)}">show ${escapeHtml(v)}</a>`
         )
         .join("")}</div>`
    : "";

  const n = bundle.sections.length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(bundle.title)}</title>
<link rel="stylesheet" href="/katex/katex.min.css">
<style>${BASE_CSS}${HANDOUT_CSS}</style>
${o.head ?? ""}
</head>
<body>
<main>
<div class="crumb"><a href="/">&larr; Back to the campus</a> · 📝 Handout</div>
<h1>${escapeHtml(bundle.title)}</h1>
<div class="hmeta">
  <span class="chip">${escapeHtml(bundle.chapter)}</span>
  <span class="chip">${escapeHtml(bundle.term)}</span>
  ${n} section${n === 1 ? "" : "s"}
</div>
${banner}
${parts.join("\n")}
<div class="hfoot">That is the whole handout. Thank you — what you wrote here is what decides
how the next one gets written.</div>
</main>
${o.scripts ?? ""}
</body>
</html>`;
}
