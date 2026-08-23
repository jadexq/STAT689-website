// The class project repository, in the corpus.
//
// Students ask "how do I contribute to the project?" and "what goes in the
// write-up?". The answers are in the repo's README, so the README is a
// reading like any other: fetched from GitHub, cached under DATA_DIR, listed
// in a manifest, indexed by materials.ts. No token — the repo is public, and
// raw.githubusercontent.com is not the REST API, so the unauthenticated
// 60-requests-an-hour ceiling does not apply.
//
// Three rules this file exists to keep:
//
//   1. It never blocks startup. The class server booting must not depend on
//      GitHub being reachable. startRepoSync() returns immediately and the
//      fetch lands whenever it lands.
//   2. An absent README is a normal state, not an error. On the first boot
//      with no network there is no cached copy to fall back to, so "fall back
//      to the cache" is not a complete rule on day one — the corpus simply
//      has one fewer reading, and the next sync picks it up.
//   3. It writes only when the bytes changed. indexKey() is size + mtime, so
//      rewriting a byte-identical README would force a full reindex of the
//      whole corpus on every interval, for nothing.
//
// Its own root, not the upload root: saveUpload() rewrites that manifest
// wholesale, and a second writer sharing it would clobber an upload that
// landed between the read and the write. One writer per manifest.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPO_DIR, type Reading } from "./materials.ts";

interface RepoSource {
  id: string;
  title: string;
  owner: string;
  repo: string;
}

// The same repository the Computer Lab cards point at
// (virtual_space/server/repos.json). Two processes, two lists: the space's is
// what a student clicks, this one is what the TA can quote. They are one line
// each and they name the same repo; if that stops being true, add a repo here
// and a card there.
const SOURCES: RepoSource[] = [
  { id: "project-readme", title: "Class project — README", owner: "jadexq", repo: "STAT689-project" },
];

const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

function rawUrl(s: RepoSource): string {
  // HEAD, not "main": a default-branch rename would otherwise 404 silently
  // and the README would quietly go stale.
  return `https://raw.githubusercontent.com/${s.owner}/${s.repo}/HEAD/README.md`;
}

function pageUrl(s: RepoSource): string {
  return `https://github.com/${s.owner}/${s.repo}`;
}

// Returns true if the file now holds these bytes AND they are new.
async function writeIfChanged(file: string, bytes: Buffer): Promise<boolean> {
  const existing = await readFile(file).catch(() => null);
  if (existing && existing.equals(bytes)) return false;
  await writeFile(file, bytes);
  return true;
}

async function fetchReadme(s: RepoSource): Promise<Buffer | null> {
  const res = await fetch(rawUrl(s), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) {
    // A repo with no README yet. Not an error — the instructor has not
    // written one, and the corpus is correct to be missing it.
    console.warn(`[virtual-ta] ${s.owner}/${s.repo} has no README.md yet`);
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// One pass over every source. Exported so a test can run it synchronously
// instead of waiting out the interval.
export async function syncRepoDocs(): Promise<{ id: string; changed: boolean }[]> {
  const results: { id: string; changed: boolean }[] = [];
  await mkdir(REPO_DIR, { recursive: true });

  // Built from SOURCES, not accumulated: a source removed from the list
  // leaves the corpus on the next sync rather than lingering forever. Its
  // cached file stays on disk, unreferenced and harmless.
  const readings: Reading[] = [];
  for (const s of SOURCES) {
    const file = `${s.id}.md`;
    let changed = false;
    try {
      const bytes = await fetchReadme(s);
      if (bytes) changed = await writeIfChanged(path.join(REPO_DIR, file), bytes);
    } catch (err) {
      // Network down, GitHub down, DNS — keep whatever is cached and try
      // again next interval. Warn rather than throw: this runs unawaited.
      console.warn(`[virtual-ta] README sync for ${s.owner}/${s.repo}: ${(err as Error).message}`);
    }
    results.push({ id: s.id, changed });
    // Listed only if the bytes are actually on disk, from this fetch or an
    // earlier one. A manifest entry for a file that is not there would show
    // an empty reading on the Library shelf.
    const cached = await readFile(path.join(REPO_DIR, file)).catch(() => null);
    if (cached?.length) {
      // An ordinary reading: not pinned, so retrieval handles it like any
      // other prose. `link` points at the repo rather than the raw file, so
      // a student who follows the citation lands somewhere useful.
      readings.push({ id: s.id, title: s.title, file, link: pageUrl(s) });
    }
  }

  // Written only when it differs, same as the file. indexKey() does not stat
  // the manifest, so this is not about the index — it is about not dirtying a
  // tree that docker/sync.mjs snapshots to the bucket on a timer.
  const next = JSON.stringify({ readings }, null, 2) + "\n";
  const manifest = path.join(REPO_DIR, "manifest.json");
  const prev = await readFile(manifest, "utf8").catch(() => null);
  if (prev !== next) await writeFile(manifest, next);
  return results;
}

// Fire and forget, at boot and every few hours. Never awaited by the caller:
// see rule 1 above. The interval is unref'd so it does not hold the process
// open — a script that imports this module still exits.
export function startRepoSync(): void {
  void syncRepoDocs();
  setInterval(() => void syncRepoDocs(), SYNC_EVERY_MS).unref();
}
