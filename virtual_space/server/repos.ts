// The Computer Lab's repo cards.
//
// These used to live in server/repos.json inside the image, which made adding
// a codebase mid-semester a code change and a --source=. redeploy. The
// readings had already stopped working that way; this brings the Lab into line
// with the Library, so both rooms are filled from the running app.
//
// The list lives in DATA_DIR, which docker/sync.mjs restores at boot and
// snapshots to the bucket. server/repos.json survives as the SEED: copied in
// once, the first time a deployment finds no list of its own. That is what
// makes a state wipe leave the Lab stocked rather than empty, and it is why an
// instructor who deletes every card gets an empty Lab rather than the seed
// reappearing: after seeding, the file exists, and an empty file is an answer.

import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "./paths";

export interface RepoCard {
  name: string;
  description: string;
  url: string;
}

const LIVE = path.join(DATA_DIR, "repos.json");
const SEED = path.join(__dirname, "repos.json");

// Bounds, not policy. A repo list is a handful of links maintained by one
// person; these exist so a malformed paste cannot put a megabyte of text on a
// card or a thousand cards in a room.
const MAX_CARDS = 24;
const MAX_NAME = 80;
const MAX_DESC = 400;
const MAX_URL = 300;

function parse(raw: string): RepoCard[] {
  const parsed = JSON.parse(raw) as { repos?: RepoCard[] };
  return (parsed.repos ?? []).filter((r) => r?.name && r?.url);
}

/** The list a student sees. Never throws: an unreadable list is an empty Lab. */
export async function loadRepos(): Promise<RepoCard[]> {
  try {
    return parse(await fs.readFile(LIVE, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[space] repos: ${(err as Error).message}`);
      return [];
    }
  }
  // No list of our own yet, and seeding at boot has not run or could not
  // write. Serve the seed without adopting it, so the room still works.
  try {
    return parse(await fs.readFile(SEED, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Copy the seed into DATA_DIR if nothing is there. Called once at boot, after
 * sync.mjs has restored the tree, so "nothing is there" means a fresh
 * deployment or a wiped bucket rather than a race with the restore.
 */
export async function ensureReposSeeded(): Promise<void> {
  try {
    await fs.access(LIVE);
    return; // already ours, including when it is deliberately empty
  } catch {
    /* fall through */
  }
  try {
    const seed = await fs.readFile(SEED, "utf8");
    await write(parse(seed));
    console.log(`[space] repos: seeded ${LIVE} from the bundled list`);
  } catch (err) {
    // Not fatal. loadRepos() falls back to the seed, so the Lab is stocked
    // either way; what is lost is the ability to edit until this succeeds.
    console.error(`[space] repos: could not seed: ${(err as Error).message}`);
  }
}

async function write(repos: RepoCard[]): Promise<void> {
  await fs.mkdir(path.dirname(LIVE), { recursive: true });
  // Written beside the target and renamed: rename is atomic on the same
  // filesystem, so a crash mid-write cannot leave a truncated list that the
  // next boot would read as corrupt and replace with an empty Lab.
  const tmp = `${LIVE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ repos }, null, 2) + "\n", "utf8");
  await fs.rename(tmp, LIVE);
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Replace the whole list. Whole-list replace rather than add/remove routes
 * because there is exactly one writer: it needs no merge rules, and the
 * request itself is the state the instructor is looking at.
 */
export async function saveRepos(input: unknown): Promise<{ ok: boolean; note: string; repos: RepoCard[] }> {
  const rows = (input as { repos?: unknown })?.repos;
  if (!Array.isArray(rows)) {
    return { ok: false, note: "That was not a list of repositories.", repos: await loadRepos() };
  }
  if (rows.length > MAX_CARDS) {
    return { ok: false, note: `That is more than ${MAX_CARDS} repositories.`, repos: await loadRepos() };
  }

  const repos: RepoCard[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = clean((row as RepoCard)?.name, MAX_NAME);
    const url = clean((row as RepoCard)?.url, MAX_URL);
    if (!name) return { ok: false, note: "Every repository needs a name.", repos: await loadRepos() };
    if (!url) return { ok: false, note: `${name} has no address.`, repos: await loadRepos() };

    // The client assigns this straight to an anchor's href, where a
    // javascript: URL would run on click. Only the instructor can get here,
    // but a pasted link is exactly the kind of thing nobody reads twice.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, note: `${name} does not have a valid address.`, repos: await loadRepos() };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, note: `${name} must be an http or https address.`, repos: await loadRepos() };
    }

    const key = name.toLowerCase();
    if (seen.has(key)) return { ok: false, note: `Two repositories are both called ${name}.`, repos: await loadRepos() };
    seen.add(key);

    repos.push({ name, description: clean((row as RepoCard)?.description, MAX_DESC), url: parsed.href });
  }

  try {
    await write(repos);
  } catch (err) {
    console.error(`[space] repos save: ${(err as Error).message}`);
    return { ok: false, note: "The list could not be saved.", repos: await loadRepos() };
  }
  const n = repos.length;
  return { ok: true, note: n ? `Saved ${n} ${n === 1 ? "repository" : "repositories"}.` : "The Computer Lab is now empty.", repos };
}
