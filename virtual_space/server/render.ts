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

import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

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
`;

// Wide tables get their own scroll box rather than pushing the page sideways.
// Exported because the handout page needs the same treatment and forking the
// pipeline is how the two drift apart.
export function wrapTables(html: string): string {
  return html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
}

export function renderMarkdownPage(title: string, markdown: string): string {
  const body = wrapTables(marked.parse(markdown, { async: false }) as string);
  const t = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main>
<div class="crumb"><a href="/">&larr; Back to the campus</a> · 📚 Course material</div>
${body}
</main>
</body>
</html>`;
}
