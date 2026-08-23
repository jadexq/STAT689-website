// Course grounding. The instructor drops readings into materials/ and lists
// them in manifest.json.
//
// Two ways in. If the student NAMES a document, its full text goes into the
// prompt (loadReading) — nothing beats the whole thing when it fits. If they
// just ask a question, searchMaterials picks the most relevant passages
// across every document.
//
// The search is keyword scoring over ~1,500-character chunks: no embedding
// provider, no vector store, no build step. That is a deliberate stop short
// of the vector retrieval this comment used to promise. With a handful of
// readings, tf-idf over chunks finds the right passage and costs nothing;
// past roughly twenty documents it is worth revisiting.
//
// Chunking earns its keep either way: two whole documents at the 28k cap
// would blow out prompt cost and latency long before retrieval quality
// became the binding constraint.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractText } from "unpdf";
import { DATA_DIR } from "./paths.ts";

export interface Reading {
  id: string;
  title: string;
  file: string;
  link?: string;
  // Which root this reading's manifest was found in. Filled by listReadings,
  // never read from the manifest itself.
  root?: string;
  // Always in the prompt, never in the chunk index. For the document where
  // retrieval MISSING it produces a confidently wrong answer rather than a
  // vague one — a deadline, above all. Without the index half of that rule
  // the document would be in the prompt twice, once pinned and once as a
  // retrieved passage; and the agenda in particular is a single markdown
  // table, which chunking shreds across rows.
  pinned?: boolean;
  // This reading is the course schedule: read as prose like any other, and
  // additionally parsed as a table by agenda.ts. Marked in the manifest
  // rather than found by filename, so a rename cannot silently turn the
  // schedule off. Implies pinned.
  agenda?: boolean;
}

// Pinned documents are handled whole, by whoever always includes them. They
// are kept out of retrieval entirely — out of the chunk index, and out of
// matchReading, because naming one would also pin session.readingId to it for
// the rest of the conversation and starve every later question of search.
export function isPinned(r: Reading): boolean {
  return Boolean(r.pinned || r.agenda);
}

// Where the corpus lives — TWO roots, each with its own manifest.json.
//
//   UPLOAD_DIR  DATA_DIR/materials. Written by the instructor at run time and
//               restored from the bucket at boot, so adding a reading is a
//               drag and drop rather than a git commit and a deploy. It is
//               also where the real course documents belong: materials/ is
//               tracked, this repo is private only for now, and git history
//               outlives that decision.
//   SHIPPED_DIR the repo's own materials/, or MATERIALS_DIR if set — which
//               REPLACES the shipped fixture rather than adding to it, and is
//               how the real corpus is pointed at locally.
//
// Uploads are searched first, so re-uploading an id corrects a shipped
// reading without a deploy. A manifest entry can only name a file inside its
// own root.
const SHIPPED_DIR = process.env.MATERIALS_DIR?.trim()
  ? path.resolve(process.env.MATERIALS_DIR.trim())
  : path.join(import.meta.dirname, "..", "materials");
const UPLOAD_DIR = path.join(DATA_DIR, "materials");
const ROOTS = [UPLOAD_DIR, SHIPPED_DIR];
const MAX_READING_CHARS = 28_000;

async function manifestAt(root: string): Promise<Reading[]> {
  const raw = await readFile(path.join(root, "manifest.json"), "utf8").catch(() => null);
  if (raw === null) return []; // a root with no manifest yet is normal
  try {
    return (JSON.parse(raw).readings ?? []) as Reading[];
  } catch (err) {
    // One unparseable manifest must not empty the whole corpus.
    console.error(`[virtual-ta] ${path.join(root, "manifest.json")}: ${(err as Error).message}`);
    return [];
  }
}

export async function listReadings(): Promise<Reading[]> {
  const out: Reading[] = [];
  const seen = new Set<string>();
  for (const root of ROOTS) {
    for (const r of await manifestAt(root)) {
      if (!r?.id || !r?.file || seen.has(r.id)) continue;
      seen.add(r.id);
      // Assigned here, never taken from the manifest: a reading's root is
      // where its manifest was found, and a manifest does not get to say
      // otherwise.
      out.push({ ...r, root });
    }
  }
  return out;
}

// The reading's file on disk, or null if the manifest is trying to reach out
// of its own root with "../".
function filePathOf(reading: Reading): string | null {
  const root = reading.root ?? SHIPPED_DIR;
  const filePath = path.join(root, reading.file);
  return path.relative(root, filePath).startsWith("..") ? null : filePath;
}

// Full text of one reading, PDFs extracted and HTML stripped. Uncapped —
// callers decide how much of it they can afford.
async function rawText(reading: Reading): Promise<string | null> {
  const filePath = filePathOf(reading);
  if (!filePath) return null;

  let text: string;
  const ext = path.extname(reading.file).toLowerCase();
  if (ext === ".pdf") {
    const buf = await readFile(filePath);
    const result = await extractText(new Uint8Array(buf), { mergePages: true });
    text = result.text;
  } else {
    text = await readFile(filePath, "utf8");
    if (ext === ".html" || ext === ".htm") text = stripHtml(text);
  }
  return text.replace(/\r\n/g, "\n").trim();
}

export async function loadReading(
  id: string
): Promise<{ reading: Reading; text: string; truncated: boolean } | null> {
  const reading = (await listReadings()).find((r) => r.id === id);
  if (!reading) return null;
  let text = await rawText(reading);
  if (text === null) return null;
  // `truncated` is the caller's cue to retrieve within the document instead
  // of accepting the first 28k. The first real reading is 113k, so this is
  // the normal case, not the edge one — and the naming path is sticky, so a
  // truncated answer poisons the rest of the conversation, not one turn.
  const truncated = text.length > MAX_READING_CHARS;
  if (truncated) text = text.slice(0, MAX_READING_CHARS) + "\n\n[…reading truncated for length…]";
  return { reading, text, truncated };
}

// What the file is, for a consumer that has to decide how to present it.
export function formatOf(reading: Reading): string {
  return path.extname(reading.file).replace(/^\./, "").toLowerCase();
}

// The file itself, unprocessed. Serving it is the virtual space's job — this
// port is not reachable from a browser — so the bytes leave here as they are
// on disk and the space decides how to render them.
export async function readingFile(
  id: string
): Promise<{ reading: Reading; bytes: Buffer; format: string } | null> {
  const reading = (await listReadings()).find((r) => r.id === id);
  if (!reading) return null;
  const filePath = filePathOf(reading);
  if (!filePath) return null;
  const bytes = await readFile(filePath).catch(() => null);
  if (!bytes) return null;
  return { reading, bytes, format: formatOf(reading) };
}

// Match a reading the student named in free text, by title words, id, or link.
export async function matchReading(message: string): Promise<Reading | null> {
  const readings = (await listReadings()).filter((r) => !isPinned(r));
  const lower = message.toLowerCase();
  for (const r of readings) {
    if (lower.includes(r.id.toLowerCase()) || lower.includes(r.title.toLowerCase())) return r;
    if (r.link && lower.includes(r.link.toLowerCase())) return r;
  }
  // fall back to title-word overlap: the uniquely best-scoring reading wins
  const STOP = new Set(["gentle", "introduction", "guide", "notes", "reading", "with", "from", "about"]);
  let best: Reading | null = null;
  let bestHits = 0;
  let tie = false;
  for (const r of readings) {
    const words = r.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !STOP.has(w));
    const hits = words.filter((w) => lower.includes(w)).length;
    if (hits > bestHits) {
      best = r;
      bestHits = hits;
      tie = false;
    } else if (hits === bestHits && hits > 0) {
      tie = true;
    }
  }
  return bestHits > 0 && !tie ? best : null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

// ---------- retrieval over chunks ----------

const CHUNK_CHARS = 1_500;
const CHUNK_OVERLAP = 200; // so an answer straddling a boundary is not halved
const DEFAULT_CONTEXT_CHARS = 12_000;
// One long document must not crowd out the rest — but with a corpus this
// small the opposite failure is the live one: every query was hitting this
// cap against a single 113k reading and getting a quarter of the evidence it
// could afford. Worth lowering again past roughly ten documents.
const MAX_CHUNKS_PER_DOC = 8;

export interface Passage {
  readingId: string;
  title: string;
  link?: string;
  part: number; // 1-based position of the chunk within its document
  heading: string; // the heading trail this chunk sits under, "" if none
  text: string;
}

// Words too common to discriminate. Short tokens are dropped separately, so
// this only needs the frequent long ones.
const STOPWORDS = new Set([
  "the", "and", "that", "this", "with", "from", "have", "has", "was", "were", "are", "for",
  "you", "your", "what", "which", "when", "where", "how", "why", "does", "did", "can", "about",
  "into", "than", "then", "them", "they", "there", "their", "would", "could", "should", "will",
  "been", "being", "some", "more", "most", "much", "many", "also", "just", "like", "over",
  "such", "these", "those", "explain", "tell", "know",
]);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Split a document at its headings, carrying the heading trail down. This is
// what makes a passage self-describing: retrieval can then tell the TA the
// answer came from "§ 5. Tooling › Choosing an agent" rather than just from
// somewhere in a 113k document, and the student can go and find it.
//
// A document with no headings — an extracted PDF, a single markdown table —
// comes back as one section with an empty trail, which is exactly the
// behaviour this replaced.
function sections(text: string, title = ""): { heading: string; text: string }[] {
  // A document's own H1 is its title, which the passage label already
  // carries. Left in, every heading trail would open by repeating it, and
  // its words would score twice — once as title terms, once as heading terms.
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const isDocTitle = (x: string) => Boolean(title) && norm(x) === norm(title);

  const out: { heading: string; text: string }[] = [];
  const trail: string[] = [];
  let buf: string[] = [];
  let heading = "";
  let inFence = false;

  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) out.push({ heading, text: t });
    buf = [];
  };

  for (const line of text.split("\n")) {
    // A shell comment inside a fenced block is not a heading, and the real
    // readings are full of them.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) {
      buf.push(line);
      continue;
    }
    flush();
    const level = m[1].length;
    trail.length = Math.min(trail.length, level - 1);
    trail[level - 1] = m[2].trim();
    heading = trail.filter((h, i) => h && !(i === 0 && isDocTitle(h))).join(" › ");
  }
  flush();
  return out;
}

// Split on blank lines and regroup into chunks, so a chunk boundary lands
// between paragraphs wherever the paragraphs are small enough to allow it.
function chunkText(text: string): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const para of paras) {
    if (para.length >= CHUNK_CHARS) {
      flush();
      // A single huge paragraph (common in extracted PDFs) is cut on length,
      // with an overlap so a sentence spanning the cut survives in one piece.
      for (let i = 0; i < para.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        out.push(para.slice(i, i + CHUNK_CHARS));
      }
      continue;
    }
    if (cur.length + para.length + 2 > CHUNK_CHARS) flush();
    cur += (cur ? "\n\n" : "") + para;
  }
  flush();
  return out;
}

interface Indexed extends Passage {
  tf: Map<string, number>;
  titleTerms: Set<string>;
  headingTerms: Set<string>;
}

let index: { key: string; chunks: Indexed[]; df: Map<string, number> } | null = null;

// Rebuild when the manifest or any file changes, so the instructor can drop
// in a reading without restarting the server.
async function indexKey(readings: Reading[]): Promise<string> {
  const parts: string[] = [];
  for (const r of readings) {
    const p = filePathOf(r);
    const s = p ? await stat(p).catch(() => null) : null;
    parts.push(`${r.id}:${r.file}:${s ? `${s.size}@${s.mtimeMs}` : "missing"}`);
  }
  return parts.join("|");
}

async function buildIndex(): Promise<NonNullable<typeof index>> {
  const readings = (await listReadings()).filter((r) => !isPinned(r));
  const key = await indexKey(readings);
  if (index?.key === key) return index;

  const chunks: Indexed[] = [];
  for (const r of readings) {
    const text = await rawText(r).catch(() => null);
    if (!text) continue;
    const titleTerms = new Set(terms(r.title));
    let part = 0;
    for (const section of sections(text, r.title)) {
      const headingTerms = new Set(terms(section.heading));
      for (const t of chunkText(section.text)) {
        const tf = new Map<string, number>();
        for (const w of terms(t)) tf.set(w, (tf.get(w) ?? 0) + 1);
        chunks.push({
          readingId: r.id,
          title: r.title,
          link: r.link,
          part: ++part,
          heading: section.heading,
          text: t,
          tf,
          titleTerms,
          headingTerms,
        });
      }
    }
  }
  const df = new Map<string, number>();
  for (const c of chunks) for (const w of c.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  index = { key, chunks, df };
  console.log(`[virtual-ta] indexed ${chunks.length} chunks from ${readings.length} document(s)`);
  return index;
}

function bare(c: Indexed): Passage {
  return { readingId: c.readingId, title: c.title, link: c.link, part: c.part, heading: c.heading, text: c.text };
}

// idf is a property of the corpus, so N and df always come from the whole
// index even when the candidate set is one document.
function scoreAgainst(
  candidates: Indexed[],
  df: Map<string, number>,
  N: number,
  q: string[]
): { c: Indexed; score: number }[] {
  return candidates
    .map((c) => {
      let score = 0;
      for (const w of q) {
        const n = df.get(w);
        if (!n) continue;
        const idf = Math.log(1 + N / n);
        const tf = c.tf.get(w) ?? 0;
        // Saturating tf: the tenth occurrence of a word says little more than
        // the second, and without this a long chunk wins on repetition alone.
        if (tf) score += idf * (1 + Math.log(tf));
        // A term in the document's TITLE is strong evidence about the
        // document, so it lifts every chunk of it — that is how "the
        // attention reading" pulls up passages that never repeat the word.
        if (c.titleTerms.has(w)) score += idf * 0.75;
        // A term in the section HEADING is the same argument one level down,
        // and it is the reason chunking on headings improves retrieval and
        // not just citation: "what does it say about MCP" now finds the
        // section called MCP even where the body says "the protocol".
        if (c.headingTerms.has(w)) score += idf * 0.5;
      }
      return { c, score };
    })
    .sort((a, b) => b.score - a.score);
}

// The most relevant passages across every course document, best first, up to
// a character budget. Empty when nothing matches — the caller should then say
// the materials do not cover it rather than pretend otherwise.
export async function searchMaterials(
  query: string,
  budgetChars = DEFAULT_CONTEXT_CHARS
): Promise<Passage[]> {
  const { chunks, df } = await buildIndex();
  if (!chunks.length) return [];
  const q = [...new Set(terms(query))];
  if (!q.length) return [];

  const out: Passage[] = [];
  const perDoc = new Map<string, number>();
  let used = 0;
  for (const { c, score } of scoreAgainst(chunks, df, chunks.length, q)) {
    if (score <= 0) break;
    const n = perDoc.get(c.readingId) ?? 0;
    if (n >= MAX_CHUNKS_PER_DOC) continue;
    if (used + c.text.length > budgetChars) continue;
    perDoc.set(c.readingId, n + 1);
    used += c.text.length;
    out.push(bare(c));
  }
  return out;
}

// Retrieval INSIDE one document, for when the student has named a reading too
// long to include whole.
//
// The alternative — the first 28k characters — was measured against the first
// real reading and is worse than it looks: 25% of the document, with the
// section the student asked about outside the slice, and session.readingId is
// sticky, so every later question in that conversation is answered from the
// same first quarter. Passages come back in document order, because an
// excerpt that jumps around reads like a different document.
export async function searchWithin(
  readingId: string,
  query: string,
  budgetChars = MAX_READING_CHARS
): Promise<Passage[]> {
  const { chunks, df } = await buildIndex();
  const mine = chunks.filter((c) => c.readingId === readingId);
  if (!mine.length) return [];
  const q = [...new Set(terms(query))];
  if (!q.length) return [];

  const picked: Indexed[] = [];
  let used = 0;
  for (const { c, score } of scoreAgainst(mine, df, chunks.length, q)) {
    if (score <= 0) break;
    if (used + c.text.length > budgetChars) continue;
    used += c.text.length;
    picked.push(c);
  }
  return picked.sort((a, b) => a.part - b.part).map(bare);
}

// The passages laid out for a prompt, each labelled with the document it
// came from so the TA can name its source instead of implying one.
export function passageBlock(passages: Passage[]): string {
  return passages
    .map((p) => {
      const where = p.heading ? `§ ${p.heading}` : `part ${p.part}`;
      return `--- from "${p.title}", ${where}${p.link ? ` · ${p.link}` : ""} ---\n${p.text}`;
    })
    .join("\n\n");
}

// ---------- uploads ----------

// Adding a reading used to cost a container build. It now costs a drag and
// drop: the file lands in DATA_DIR/materials, which docker/sync.mjs restores
// at boot and snapshots on a timer, and the manifest there is rewritten to
// match. The index rebuilds on its own — indexKey() watches file size and
// mtime, so the next question already sees the new reading.
//
// Callers are trusted to have checked that the uploader is the instructor.
// This port binds to 127.0.0.1; the virtual space is the gatekeeper.

const ALLOWED_EXT = new Set([".md", ".markdown", ".html", ".htm", ".txt", ".pdf"]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface UploadRequest {
  id: string;
  title: string;
  filename: string;
  bytes: Buffer;
  agenda?: boolean;
  pinned?: boolean;
  link?: string;
}

export async function saveUpload(req: UploadRequest): Promise<{ ok: boolean; note: string; id?: string }> {
  const id = req.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    return { ok: false, note: "The id must be lowercase letters, digits and hyphens." };
  }
  // basename() alone, so neither "../" nor an absolute path survives.
  const filename = path.basename(req.filename.trim());
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return { ok: false, note: `${ext || "That file type"} is not a reading — use .md, .html, .txt or .pdf.` };
  }
  if (!req.bytes.length) return { ok: false, note: "That file is empty." };
  if (req.bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, note: `That file is ${Math.round(req.bytes.length / 1e6)} MB — the limit is 20 MB.` };
  }

  await mkdir(UPLOAD_DIR, { recursive: true });
  // The id owns the filename, so re-uploading a reading replaces its file
  // instead of leaving the old bytes orphaned under a different name.
  const stored = `${id}${ext}`;
  await writeFile(path.join(UPLOAD_DIR, stored), req.bytes);

  const readings = (await manifestAt(UPLOAD_DIR)).filter((r) => r.id !== id);
  const entry: Reading = { id, title: req.title.trim() || id, file: stored };
  if (req.link) entry.link = req.link;
  if (req.pinned) entry.pinned = true;
  if (req.agenda) entry.agenda = true;
  // Only one agenda: marking a new one un-marks the old, or the schedule
  // would depend on manifest order.
  if (req.agenda) for (const r of readings) delete r.agenda;
  readings.push(entry);
  await writeFile(
    path.join(UPLOAD_DIR, "manifest.json"),
    JSON.stringify({ readings }, null, 2) + "\n"
  );
  return { ok: true, id, note: `"${entry.title}" is on the shelf.` };
}
