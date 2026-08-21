// Course grounding. The instructor drops readings into materials/ and lists
// them in manifest.json; every skill grounds on this same curated set. For
// v1 the selected reading's full text goes into the prompt (chunked
// retrieval with embeddings is the later upgrade for large collections).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractText } from "unpdf";

export interface Reading {
  id: string;
  title: string;
  file: string;
  link?: string;
}

const MATERIALS_DIR = path.join(import.meta.dirname, "..", "materials");
const MAX_READING_CHARS = 28_000;

export async function listReadings(): Promise<Reading[]> {
  const raw = await readFile(path.join(MATERIALS_DIR, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  return (manifest.readings ?? []) as Reading[];
}

export async function loadReading(id: string): Promise<{ reading: Reading; text: string } | null> {
  const reading = (await listReadings()).find((r) => r.id === id);
  if (!reading) return null;
  const filePath = path.join(MATERIALS_DIR, reading.file);
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
  text = text.replace(/\r\n/g, "\n").trim();
  if (text.length > MAX_READING_CHARS) {
    text = text.slice(0, MAX_READING_CHARS) + "\n\n[…reading truncated for length…]";
  }
  return { reading, text };
}

// Match a reading the student named in free text, by title words, id, or link.
export async function matchReading(message: string): Promise<Reading | null> {
  const readings = await listReadings();
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
