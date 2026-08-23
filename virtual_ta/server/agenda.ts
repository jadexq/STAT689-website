// The course agenda, read as a schedule rather than as prose.
//
// It is a markdown table because that is the one format that is legible to a
// human editing it, to a browser rendering it, and to the TA reading it. The
// cost is that a table is easy to parse badly, and this file exists to parse
// it well — three properties the instructor's real agenda has, each of which
// a naive parser gets wrong:
//
//   1. Topic SPANS. It is written once on the first row of a block and left
//      blank underneath. Blank means "continues above", not "no topic".
//   2. Dates must carry the year. "08/24" is ambiguous the moment a student
//      opens the page in January, and inferring the year from the clock shows
//      them next year's course. A configured year is one more thing to forget
//      each August; a self-describing date needs neither. So four digits are
//      required, and a row that cannot be dated is REPORTED, never guessed.
//   3. Most rows are empty. Weeks 4-15 are placeholders — scheduled but not
//      planned yet. That is a fact about the course, not a gap in the data,
//      and it is displayed as such.
//
// Columns are matched by header name, not position, so the instructor can
// reorder or add one without touching this file.

import { listReadings, readingFile } from "./materials.ts";

export interface AgendaRow {
  date: string; // exactly as written
  iso: string; // YYYY-MM-DD
  week: string;
  lecture: string;
  content: string;
  homework: string;
  topic: string; // filled down from the block above when blank
  planned: boolean; // has content or homework — see (3) above
}

export interface Agenda {
  rows: AgendaRow[];
  // Rows this file refused to guess at. Surfaced rather than swallowed: a
  // silently dropped session is a class a student never hears about.
  problems: string[];
}

const EMPTY = new Set(["", "-", "–", "—", "n/a", "tbd"]);

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isSeparator(line: string): boolean {
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line.trim()) && line.includes("-");
}

// Four digits or nothing. Also rejects a date that parses but is not real
// (2026/13/40), which a regex alone would let through.
function toIso(raw: string): string | null {
  const m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d] = m;
  const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export function parseAgenda(markdown: string): Agenda {
  const lines = markdown.split("\n");
  const rows: AgendaRow[] = [];
  const problems: string[] = [];

  const headerAt = lines.findIndex((l) => l.trim().startsWith("|") && /\bdate\b/i.test(l));
  if (headerAt < 0) {
    return { rows, problems: ["No table found — the agenda needs a markdown table with a Date column."] };
  }
  const header = cells(lines[headerAt]).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const at = (c: string[], i: number) => (i >= 0 && i < c.length ? c[i] : "");
  const iDate = col("date");
  const iWeek = col("week");
  const iLecture = col("lecture");
  const iContent = col("content");
  const iHomework = col("homework");
  const iTopic = col("topic");

  let topic = "";
  for (let n = headerAt + 1; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim().startsWith("|")) continue;
    if (isSeparator(line)) continue;
    const c = cells(line);
    const date = at(c, iDate);
    const spanned = at(c, iTopic);
    if (spanned) topic = spanned; // a new block starts here

    const iso = toIso(date);
    if (!iso) {
      // Not a hard failure: the rest of the agenda still renders. But the row
      // is named, with its line number, so the fix is a one-line edit.
      problems.push(
        date
          ? `Line ${n + 1}: cannot read the date "${date}" — write it as 2026/08/24, with the year.`
          : `Line ${n + 1}: no date on this row — it will not appear in the schedule.`
      );
      continue;
    }

    const content = at(c, iContent);
    const homework = at(c, iHomework);
    const meaningful = (s: string) => !EMPTY.has(s.toLowerCase());
    rows.push({
      date,
      iso,
      week: at(c, iWeek),
      lecture: at(c, iLecture),
      content,
      homework,
      topic,
      planned: meaningful(content) || meaningful(homework),
    });
  }

  rows.sort((a, b) => a.iso.localeCompare(b.iso));
  return { rows, problems };
}

// The agenda from the corpus, or null if the instructor has not marked one.
// Marked by `"agenda": true` in manifest.json rather than found by filename,
// so renaming the file does not silently turn the schedule off.
export async function loadAgenda(): Promise<Agenda | null> {
  const reading = (await listReadings()).find((r) => r.agenda);
  if (!reading) return null;
  const file = await readingFile(reading.id);
  if (!file) return null;
  const agenda = parseAgenda(file.bytes.toString("utf8"));
  for (const p of agenda.problems) console.warn(`[virtual-ta] agenda: ${p}`);
  return agenda;
}
