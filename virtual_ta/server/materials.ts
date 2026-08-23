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

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { extractText } from "unpdf";

export interface Reading {
  id: string;
  title: string;
  file: string;
  link?: string;
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

// Where the corpus lives. Defaults to the repo's own materials/ folder;
// MATERIALS_DIR points it somewhere else, which is how the real course
// documents are tested locally without committing them — they are large and
// some carry vendor names, and this repo is private only for now. The
// deployed corpus question is settled separately (plan, step 2e).
const MATERIALS_DIR = process.env.MATERIALS_DIR?.trim()
  ? path.resolve(process.env.MATERIALS_DIR.trim())
  : path.join(import.meta.dirname, "..", "materials");
const MAX_READING_CHARS = 28_000;

export async function listReadings(): Promise<Reading[]> {
  const raw = await readFile(path.join(MATERIALS_DIR, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  return (manifest.readings ?? []) as Reading[];
}

// Full text of one reading, PDFs extracted and HTML stripped. Uncapped —
// callers decide how much of it they can afford.
async function rawText(reading: Reading): Promise<string | null> {
  const filePath = path.join(MATERIALS_DIR, reading.file);
  // Keep a manifest entry from reaching outside materials/ with "../".
  if (path.relative(MATERIALS_DIR, filePath).startsWith("..")) return null;

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

export async function loadReading(id: string): Promise<{ reading: Reading; text: string } | null> {
  const reading = (await listReadings()).find((r) => r.id === id);
  if (!reading) return null;
  let text = await rawText(reading);
  if (text === null) return null;
  if (text.length > MAX_READING_CHARS) {
    text = text.slice(0, MAX_READING_CHARS) + "\n\n[…reading truncated for length…]";
  }
  return { reading, text };
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
  const filePath = path.join(MATERIALS_DIR, reading.file);
  // Same guard as rawText: a manifest entry must not reach outside the corpus.
  if (path.relative(MATERIALS_DIR, filePath).startsWith("..")) return null;
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
const MAX_CHUNKS_PER_DOC = 4; // one long document must not crowd out the rest

export interface Passage {
  readingId: string;
  title: string;
  link?: string;
  part: number; // 1-based position of the chunk within its document
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
}

let index: { key: string; chunks: Indexed[]; df: Map<string, number> } | null = null;

// Rebuild when the manifest or any file changes, so the instructor can drop
// in a reading without restarting the server.
async function indexKey(readings: Reading[]): Promise<string> {
  const parts: string[] = [];
  for (const r of readings) {
    const s = await stat(path.join(MATERIALS_DIR, r.file)).catch(() => null);
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
    chunkText(text).forEach((t, i) => {
      const tf = new Map<string, number>();
      for (const w of terms(t)) tf.set(w, (tf.get(w) ?? 0) + 1);
      chunks.push({ readingId: r.id, title: r.title, link: r.link, part: i + 1, text: t, tf, titleTerms });
    });
  }
  const df = new Map<string, number>();
  for (const c of chunks) for (const w of c.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  index = { key, chunks, df };
  console.log(`[virtual-ta] indexed ${chunks.length} chunks from ${readings.length} document(s)`);
  return index;
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
  const N = chunks.length;

  const scored = chunks.map((c) => {
    let score = 0;
    for (const w of q) {
      const n = df.get(w);
      if (!n) continue;
      const idf = Math.log(1 + N / n);
      const tf = c.tf.get(w) ?? 0;
      // Saturating tf: the tenth occurrence of a word says little more than
      // the second, and without this a long chunk wins on repetition alone.
      if (tf) score += idf * (1 + Math.log(tf));
      // A term in the document's TITLE is strong evidence about the document,
      // so it lifts every chunk of it — that is how "the attention reading"
      // pulls up passages that never repeat the word.
      if (c.titleTerms.has(w)) score += idf * 0.75;
    }
    return { c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const out: Passage[] = [];
  const perDoc = new Map<string, number>();
  let used = 0;
  for (const { c, score } of scored) {
    if (score <= 0) break;
    const n = perDoc.get(c.readingId) ?? 0;
    if (n >= MAX_CHUNKS_PER_DOC) continue;
    if (used + c.text.length > budgetChars) continue;
    perDoc.set(c.readingId, n + 1);
    used += c.text.length;
    out.push({ readingId: c.readingId, title: c.title, link: c.link, part: c.part, text: c.text });
  }
  return out;
}

// The passages laid out for a prompt, each labelled with the document it
// came from so the TA can name its source instead of implying one.
export function passageBlock(passages: Passage[]): string {
  return passages
    .map((p) => `--- from "${p.title}" (part ${p.part})${p.link ? ` · ${p.link}` : ""} ---\n${p.text}`)
    .join("\n\n");
}
