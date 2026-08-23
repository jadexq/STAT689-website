// Markdown readings, rendered to a page a student can actually read.
//
// Markdown is the best format for the TA — no extraction step, nothing lost —
// and the worst one for a browser, which shows raw text or offers a download.
// So the file route renders it on the way out. Server-side, because the
// client bundle is already ~1.2 MB and a student who never opens a reading
// should not pay for a markdown parser.
//
// The source is the instructor's own file, so raw HTML inside it is passed
// through rather than sanitised — the same trust the .html passthrough
// already assumes, and the same trust a pinned board post assumes. That is
// the boundary to watch if readings ever come from anyone but the instructor.

import katex from "katex";
import { Marked, type TokenizerAndRendererExtension } from "marked";

// ---------- math ----------
// This used to live only in handout-render.ts, on the reasoning that a course
// reading saying "$5 and $10 in the same line" must keep saying that rather
// than quietly becoming a formula. The guard in `mathInline` is what actually
// buys that, though, not the separation.
//
// Pre-emptive, not a bug report: no reading in the corpus uses math today.
// But the course is attention and transformers, the handout page already sets
// equations, and a reading that picks up a `$…$` under the old split would
// have shown it raw with nothing to catch it. One dialect, one implementation,
// so the two pages cannot drift.

// throwOnError:false renders a malformed expression in red instead of taking
// the whole page down. One typo in one formula must not blank the page.
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

const marked = new Marked({ gfm: true, breaks: false });
marked.use({ extensions: [mathBlock, mathInline] });

// Every markdown surface in the app goes through this: readings and handouts
// alike. Exported so handout-render.ts renders section bodies the same way.
export function renderMathMarkdown(markdown: string): string {
  return wrapTables(marked.parse(markdown, { async: false }) as string);
}

// Pages that render math must link this, and the `/katex` mount in index.ts
// must stay for it to resolve. Kept next to the renderer so the two are not
// separately forgettable.
export const KATEX_CSS_LINK = '<link rel="stylesheet" href="/katex/katex.min.css">';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Styling is inline and self-contained: the page opens in its own tab and
// must not depend on the campus bundle having loaded.
export const BASE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 24px 96px;
  background: #0f1320; color: #dfe6f5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 16px; line-height: 1.62;
}
main { max-width: 760px; margin: 0 auto; }
.crumb { font-size: 13px; color: #8b96b3; margin-bottom: 28px; }
.crumb a { color: #8f6fe8; text-decoration: none; }
.crumb a:hover { text-decoration: underline; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.9em 0 .6em; }
h1 { font-size: 30px; margin-top: 0; }
h2 { font-size: 23px; border-bottom: 1px solid #2a3145; padding-bottom: .3em; }
h3 { font-size: 18.5px; }
h4 { font-size: 16px; color: #b9c3db; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1.05em; }
a { color: #8f6fe8; }
code {
  background: #171c2c; border: 1px solid #2a3145; border-radius: 5px;
  padding: .1em .35em; font-size: 13.5px;
}
pre {
  background: #171c2c; border: 1px solid #2a3145; border-radius: 10px;
  padding: 14px 16px; overflow-x: auto;
}
pre code { background: none; border: 0; padding: 0; font-size: 13px; line-height: 1.5; }
blockquote {
  border-left: 3px solid #4a3f77; margin-left: 0; padding: .1em 0 .1em 16px; color: #b9c3db;
}
/* Wide tables scroll inside their own box rather than the page. */
.table-wrap { overflow-x: auto; margin: 0 0 1.2em; }
table { border-collapse: collapse; font-size: 14.5px; min-width: 100%; }
th, td { border: 1px solid #2a3145; padding: 7px 11px; text-align: left; vertical-align: top; }
th { background: #1d2335; font-weight: 600; }
tr:nth-child(even) td { background: #141828; }
hr { border: 0; border-top: 1px solid #2a3145; margin: 2em 0; }
img { max-width: 100%; height: auto; }
/* A wide equation scrolls in its own box rather than the page. */
.math-block { overflow-x: auto; overflow-y: hidden; padding: 2px 0 6px; margin: 0 0 1.1em; }
.katex { font-size: 1.04em; }
`;

// Wide tables get their own scroll box rather than pushing the page sideways.
// Exported because the handout page needs the same treatment and forking the
// pipeline is how the two drift apart.
export function wrapTables(html: string): string {
  return html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
}

// `downloadHref` puts a save link in the crumb bar. Rendering markdown is
// what makes a reading readable, and it is also what takes the file away —
// there is no "save as" for a page the server generated. The link hands back
// the instructor's original file. Omitted for pages with no file behind them
// (the handout error page renders through here too).
export function renderMarkdownPage(title: string, markdown: string, downloadHref?: string): string {
  const body = renderMathMarkdown(markdown);
  const t = escapeHtml(title);
  const save = downloadHref
    ? ` · <a href="${escapeHtml(downloadHref)}" download>&darr; Download the file</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
${KATEX_CSS_LINK}
<style>${BASE_CSS}</style>
</head>
<body>
<main>
<div class="crumb"><a href="/">&larr; Back to the campus</a> · 📚 Course material${save}</div>
${body}
</main>
</body>
</html>`;
}
