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
import type { Record_ } from "./handouts";
import { TAGS } from "./handouts";

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
/* The judgement widget. Visually a box the prose sits above, not a form the
   page is built around: the student is reading a handout, and being asked
   what they thought of it — in that order. */
.judge {
  background: #141828; border: 1px solid #2a3145; border-radius: 12px;
  padding: 14px 16px 13px; margin: 1.6em 0 0;
}
.judge .ask { font-size: 13.5px; color: #b9c3db; margin: 0 0 10px; }
.grades { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.grades button {
  width: 38px; height: 38px; border-radius: 9px; cursor: pointer;
  background: #1d2335; border: 1px solid #2a3145; color: #dfe6f5;
  font: inherit; font-size: 15px; font-weight: 600; line-height: 1;
  transition: background .12s, border-color .12s, transform .06s;
}
.grades button:hover { border-color: #6b5bb5; background: #232a41; }
.grades button:active { transform: translateY(1px); }
.grades button[aria-pressed="true"] { background: #4a3f77; border-color: #8f6fe8; color: #fff; }
.grades .ends { font-size: 11.5px; color: #6f7a96; margin-left: 4px; }
.judge .tags { display: none; flex-wrap: wrap; gap: 6px; margin: 12px 0 0; }
.judge.low .tags { display: flex; }
.tags button {
  cursor: pointer; font: inherit; font-size: 12px; padding: 4px 10px;
  border-radius: 999px; background: #1d2335; border: 1px solid #2a3145; color: #b9c3db;
}
.tags button:hover { border-color: #6b5bb5; }
.tags button[aria-pressed="true"] { background: #3a2b2b; border-color: #8a4b4b; color: #f0c9c9; }
.judge textarea {
  display: block; width: 100%; margin: 12px 0 0; min-height: 62px; resize: vertical;
  background: #0f1320; border: 1px solid #2a3145; border-radius: 9px;
  color: #dfe6f5; font: inherit; font-size: 14px; line-height: 1.5; padding: 9px 11px;
}
.judge textarea:focus { outline: none; border-color: #6b5bb5; }
.judge .state { font-size: 11.5px; color: #6f7a96; margin: 7px 0 0; min-height: 15px; }
.judge .state.saved { color: #6fd08c; }
.judge .state.failed { color: #ff8fa3; }

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

const TAG_LABELS: Record<string, string> = {
  too_abstract: "too abstract",
  too_difficult: "too difficult",
  too_simple: "too simple",
  too_long: "too long",
  missing_examples: "missing examples",
  poor_organization: "poor organization",
  unclear_notation: "unclear notation",
};

/**
 * The grading widget, rendered after a section and pre-filled from what this
 * student already said. Server-rendered rather than built by script, so a
 * student who reloads sees their answers before any JavaScript runs.
 */
export function renderJudgeWidget(sectionId: string, prior?: Record_): string {
  const grade = prior?.grade ?? null;
  const chosen = new Set(prior?.tags ?? []);
  const low = grade !== null && grade <= 3;

  const buttons = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<button type="button" class="g" data-grade="${n}" aria-pressed="${grade === n}" ` +
        `aria-label="${n} out of 5">${n}</button>`
    )
    .join("");

  const tags = TAGS.map(
    (t) =>
      `<button type="button" class="t" data-tag="${t}" aria-pressed="${chosen.has(t)}">` +
      `${escapeHtml(TAG_LABELS[t] ?? t)}</button>`
  ).join("");

  return `<div class="judge${low ? " low" : ""}" data-for="${escapeHtml(sectionId)}">
  <p class="ask">How well did this section teach what it set out to teach?</p>
  <div class="grades">${buttons}<span class="ends">1 = not at all · 5 = very well</span></div>
  <div class="tags">${tags}</div>
  <textarea placeholder="Anything you would change? (optional — this is the part that gets read)"
    aria-label="Comment on this section">${escapeHtml(prior?.comment ?? "")}</textarea>
  <p class="state" role="status">${prior ? "Saved." : ""}</p>
</div>`;
}

/**
 * Autosave. No submit button by design: a student who reads four sections and
 * closes the tab should have left four answers behind, not none.
 *
 * Inline rather than bundled — this page deliberately does not load the campus
 * bundle, and the whole behaviour is smaller than the request would be.
 */
export function judgeScript(handoutId: string): string {
  return `<script>
(function () {
  var url = "/api/handouts/" + ${JSON.stringify(encodeURIComponent(handoutId))} + "/feedback" + location.search;
  document.querySelectorAll(".judge").forEach(function (box) {
    var state = box.querySelector(".state");
    var area = box.querySelector("textarea");
    var timer = null;
    var inFlight = null;
    var lastSent = area.value;

    function read() {
      var g = box.querySelector('.g[aria-pressed="true"]');
      return {
        section_id: box.dataset.for,
        grade: g ? Number(g.dataset.grade) : null,
        tags: Array.prototype.map.call(
          box.querySelectorAll('.t[aria-pressed="true"]'), function (b) { return b.dataset.tag; }),
        comment: area.value
      };
    }

    function say(text, cls) { state.textContent = text; state.className = "state" + (cls ? " " + cls : ""); }

    function send() {
      var body = read();
      lastSent = body.comment;
      say("Saving…");
      // Serialised per widget: two clicks in quick succession must not race to
      // decide which one the server saw last.
      inFlight = (inFlight || Promise.resolve()).then(function () {
        return fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then(function (r) {
          if (!r.ok) throw new Error(String(r.status));
          say("Saved.", "saved");
        }).catch(function () {
          say("Not saved — check your connection. Your text is still here.", "failed");
        });
      });
    }

    box.querySelectorAll(".g").forEach(function (b) {
      b.addEventListener("click", function () {
        var already = b.getAttribute("aria-pressed") === "true";
        box.querySelectorAll(".g").forEach(function (o) { o.setAttribute("aria-pressed", "false"); });
        // Clicking the current grade again clears it, which is the only way
        // back from a mis-click that is not "pick a number you do not mean".
        b.setAttribute("aria-pressed", already ? "false" : "true");
        var g = already ? null : Number(b.dataset.grade);
        var low = g !== null && g <= 3;
        box.classList.toggle("low", low);
        // Tags describe what went wrong. Raising the grade above 3 makes them
        // stale rather than hidden, so clear them.
        if (!low) box.querySelectorAll(".t").forEach(function (t) { t.setAttribute("aria-pressed", "false"); });
        send();
      });
    });

    box.querySelectorAll(".t").forEach(function (b) {
      b.addEventListener("click", function () {
        b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
        send();
      });
    });

    area.addEventListener("input", function () {
      say("");
      clearTimeout(timer);
      timer = setTimeout(send, 900);
    });
    // Blur is the safety net under the debounce: closing the tab mid-timer
    // must not lose the sentence they just wrote.
    area.addEventListener("blur", function () { clearTimeout(timer); if (area.value !== lastSent) send(); });
  });
})();
</script>`;
}

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
