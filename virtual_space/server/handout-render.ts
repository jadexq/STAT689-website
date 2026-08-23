// The handout page: one student, one version per section, one page.
//
// Built on render.ts rather than beside it — same CSS, same table treatment,
// same "opens in its own tab and must not depend on the campus bundle" rule,
// and since the math dialect moved there, the same equations too. Math was
// this file's own for a while; readings needed it as well, and one renderer
// is how the two pages keep agreeing about what "$" means.

import { BASE_CSS, KATEX_CSS_LINK, escapeHtml, renderMathMarkdown } from "./render";
import type { Bundle, Section } from "./handout-format";
import type { Record_ } from "./handouts";
import { TAGS, type HandoutSummary } from "./handouts";

export const renderHandoutMarkdown = renderMathMarkdown;

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
${KATEX_CSS_LINK}
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

// ---------------------------------------------------------------------------
// The instructor's view
// ---------------------------------------------------------------------------

const DASH_CSS = `
.dash-sec { border: 1px solid #2a3145; border-radius: 12px; padding: 16px 18px; margin: 0 0 18px; background: #141828; }
.dash-sec h3 { margin: 0 0 6px; font-size: 17px; }
.dash-sec .obj { font-size: 13px; color: #8b96b3; font-style: italic; margin: 0 0 12px; }
.dash-sec .rate { font-size: 12.5px; color: #8b96b3; margin: 0 0 12px; }
.dash-sec .rate b { color: #dfe6f5; }
.score { display: inline-block; min-width: 26px; text-align: center; border-radius: 7px; padding: 2px 7px; font-weight: 700; font-size: 13px; }
.s1, .s2 { background: #4a1f27; color: #ffb3c0; }
.s3 { background: #4a3f1f; color: #f0d9a0; }
.s4, .s5 { background: #1f4a30; color: #a8e8bf; }
.s0 { background: #262c40; color: #8b96b3; font-weight: 400; }
.vrow { border-top: 1px solid #232a3d; padding: 10px 0 2px; font-size: 13.5px; }
.vrow:first-of-type { border-top: 0; }
.vrow .vid { font-weight: 700; margin: 0 8px; }
.vrow .app { color: #8b96b3; font-size: 12.5px; }
.vrow .who { color: #4f5871; font-size: 11.5px; float: right; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.vrow .stale { color: #ffb454; font-size: 11.5px; margin-left: 6px; }
.vrow .tg { display: inline-block; font-size: 11.5px; background: #3a2b2b; border: 1px solid #8a4b4b; color: #f0c9c9; border-radius: 999px; padding: 1px 8px; margin: 6px 4px 0 0; }
.vrow blockquote { margin: 7px 0 2px; border-left: 3px solid #4a3f77; padding: 0 0 0 12px; color: #dfe6f5; font-size: 14px; }
.tagsum { font-size: 12.5px; color: #8b96b3; margin: 12px 0 0; border-top: 1px solid #232a3d; padding-top: 10px; }
.tagsum b { color: #ffb3c0; }
.exports { font-size: 13px; margin: 0 0 14px; }
.attrib {
  font-size: 12.5px; color: #8b96b3; border: 1px solid #2a3145; border-radius: 10px;
  background: #141828; padding: 10px 13px; margin: 0 0 22px; line-height: 1.5;
}
.attrib b { color: #dfe6f5; }
.attrib.on { border-color: #5a4a22; background: #2a2416; color: #f0d9a0; }
.attrib.on b { color: #fff; }
.missing { color: #ffb3c0; }
.vrow .name { font-weight: 700; margin-left: 8px; color: #f0d9a0; }
.exports a { margin-right: 14px; }
.silent { color: #6f7a96; font-style: italic; font-size: 13px; }
`;

function gradeChip(g: number | null): string {
  return g === null ? `<span class="score s0">—</span>` : `<span class="score s${g}">${g}</span>`;
}

export function renderDashboard(sum: HandoutSummary): string {
  const b = sum.bundle;
  const body = sum.sections
    .map((s) => {
      const rows = s.rows.length
        ? s.rows
            .map(
              (r) =>
                `<div class="vrow">${gradeChip(r.grade)}<span class="vid">${escapeHtml(r.version_id)}</span>` +
                `<span class="app">${escapeHtml(r.approach)} · ${escapeHtml(r.prompt_template)}</span>` +
                (r.current ? "" : `<span class="stale">⚠ edited since graded</span>`) +
                `<span class="who">${escapeHtml(r.who)}</span>` +
                (r.name ? `<span class="name">${escapeHtml(r.name)}</span>` : "") +
                (r.tags.length ? `<div>${r.tags.map((t) => `<span class="tg">${escapeHtml(t)}</span>`).join("")}</div>` : "") +
                (r.comment ? `<blockquote>${escapeHtml(r.comment)}</blockquote>` : "") +
                `</div>`
            )
            .join("")
        : `<div class="silent">Nobody has answered this one yet.</div>`;
      const tags = s.tagCounts.length
        ? `<div class="tagsum">${s.tagCounts.map(([t, n]) => `<b>${escapeHtml(t)}</b> ×${n}`).join(" · ")}</div>`
        : "";
      return `<div class="dash-sec">
<h3>${escapeHtml(s.title)} ${gradeChip(s.mean === null ? null : Math.round(s.mean))}</h3>
<div class="obj">${escapeHtml(s.learning_objective)}</div>
<div class="rate"><b>${s.responded}</b> of ${sum.cohort} answered${
        s.mean === null ? "" : ` · mean ${s.mean.toFixed(2)}`
      }</div>
${rows}${tags}</div>`;
    })
    .join("\n");

  const id = encodeURIComponent(b.handout_id);

  // Said plainly, because the alternative is a false sense of what this data
  // is. At one reader per version the version id IS a student id within a
  // section: anyone holding the roster order can recompute
  // (studentIndex + sectionIndex) % versions.length and read straight off who
  // said what. The hash protects an EXPORTED file from someone who lacks the
  // roster — a real but narrow thing — and protects nothing from you.
  //
  // Names stay off by default anyway, for a different reason: judging the
  // writing goes better when you do not know whose reaction you are reading.
  const attrib = sum.named
    ? `<div class="attrib on">👤 <b>Names are showing.</b> ` +
      `Turn them off to read the comments without knowing whose they are — that is the better ` +
      `way to judge the writing. <a href="/admin/handouts/${id}">hide names</a></div>`
    : `<div class="attrib">Rows are labelled by a salted hash, but this data is ` +
      `<b>not anonymous to you</b> — with one reader per version, the version id identifies the ` +
      `student within a section, and the rotation is arithmetic anyone with the roster can redo. ` +
      `The default view hides names because judging the writing goes better blind, not because ` +
      `it cannot be undone. <a href="/admin/handouts/${id}?names=1">show names</a></div>`;

  const missing = sum.notAnswered.length
    ? `<div class="attrib">🔔 <span class="missing"><b>Not answered at all:</b> ` +
      `${sum.notAnswered.map(escapeHtml).join(", ")}</span> — of ${sum.cohort} on the roster.</div>`
    : `<div class="attrib">✅ Everyone on the roster (${sum.cohort}) has answered something.</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(b.title)} — feedback</title>
<style>${BASE_CSS}${HANDOUT_CSS}${DASH_CSS}</style>
</head>
<body>
<main>
<div class="crumb"><a href="/">&larr; Back to the campus</a> · 📊 Handout feedback</div>
<h1>${escapeHtml(b.title)}</h1>
<div class="hmeta">
  <span class="chip">${escapeHtml(b.chapter)}</span>
  <span class="chip">${escapeHtml(b.term)}</span>
  ${b.sections.length} sections × ${b.versions.length} versions
</div>
<p class="exports">
  <a href="/handout/${id}">preview the handout</a>
  <a href="/admin/handouts/${id}?format=jsonl">records (.jsonl)</a>
  <a href="/admin/handouts/${id}?format=jsonl&amp;pairs=1">derived pairs (.jsonl)</a>
</p>
${missing}
${attrib}
${body}
<div class="hfoot">Worst first. Every cell holds one judgement, so no single grade is a
measurement — the comments are the evidence and the grades are the index into them.</div>
</main>
</body>
</html>`;
}
