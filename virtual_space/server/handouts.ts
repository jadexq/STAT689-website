// Feedback handouts: the instructor's own lecture notes, written in six
// versions, one per student, graded section by section.
//
// The instructor writes them OUTSIDE the app (plan/handout-authoring.md) and
// uploads one bundle per handout. Nothing here generates anything, and
// nothing here talks to the TA: handouts are stored, rendered and reported
// entirely by the space, so a TA outage takes the chat down and leaves the
// handouts working. See plan/app-changes.md, 2026-08-23.
//
// Three properties this file exists to protect, in order of how expensive
// they are to lose:
//
//   1. The version a student sees is RECORDED, never recomputed. Deriving it
//      per request works until `versions` or `sections` changes, and then it
//      silently rewrites what every earlier record was about.
//   2. Every record carries a hash of the exact bytes shown, plus a copy of
//      the provenance and the learning objective. An export line has to be
//      self-contained: editing a section later must split the dataset, not
//      rewrite it.
//   3. The student hash is SALTED. sha256 over six known addresses is a
//      lookup table, not pseudonymisation. Without a salt the routes fail
//      closed rather than falling back to an unsalted hash.
//
// Env:
//   HANDOUT_SALT   required behind IAP; a fixed dev value stands in locally

import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "./paths";
import type { Bundle, Generation } from "./handout-format";
import { SLOTS, slotFor } from "./roster";

export * from "./handout-format";

// ---------------------------------------------------------------------------
// Identity → a stable, salted, non-invertible handle
// ---------------------------------------------------------------------------

const TRUST_IAP = process.env.TRUST_IAP_HEADER === "1";
const SALT = (process.env.HANDOUT_SALT || "").trim();
// Local suites must be able to run, and a machine-local dataset is not one
// anybody will hold against a student. Behind IAP there is no equivalent
// excuse, so there is no fallback there.
const DEV_SALT = "dev-handout-salt-not-for-deployment";

export function saltState(): { ok: boolean; note: string } {
  if (SALT) return { ok: true, note: "HANDOUT_SALT set" };
  if (TRUST_IAP) {
    return {
      ok: false,
      note:
        "HANDOUT_SALT is unset. Handout routes are disabled: hashing six known " +
        "addresses without a salt is a lookup table, not pseudonymisation.",
    };
  }
  return { ok: true, note: `DEV salt in use (${DEV_SALT}) — set HANDOUT_SALT before deploying` };
}

export function studentHash(email: string): string {
  const salt = SALT || (TRUST_IAP ? "" : DEV_SALT);
  if (!salt) throw new Error("HANDOUT_SALT is unset");
  return createHash("sha256").update(salt + email.trim().toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

/** Roster position, which is what the rotation counts through. */
export function studentIndex(email: string): number | undefined {
  const slot = slotFor(email);
  if (!slot) return undefined;
  const i = SLOTS.findIndex((s) => s.id === slot.id);
  return i < 0 ? undefined : i;
}

// ---------------------------------------------------------------------------
// On disk
// ---------------------------------------------------------------------------
//
//   DATA_DIR/handouts/<handout_id>.handout.json          the uploaded bundle
//   DATA_DIR/handouts/responses/<handout_id>/<hash>.json one file per student
//
// One writer per response file — six students clicking at once touch six
// different files. A SINGLE student clicking quickly is a read-modify-write on
// their own file, so writes to one path serialise through a promise chain.
// Six students and a dozen clicks each does not justify anything more.

const HANDOUT_DIR = path.join(DATA_DIR, "handouts");
const RESPONSE_DIR = path.join(HANDOUT_DIR, "responses");

function bundlePath(id: string): string {
  return path.join(HANDOUT_DIR, `${id}.handout.json`);
}

function responsePath(handoutId: string, hash: string): string {
  return path.join(RESPONSE_DIR, handoutId, `${hash}.json`);
}

// A handout id reaches these functions from the URL. It is validated on the
// way in, but path traversal is the kind of thing that should be impossible
// twice rather than once.
export function safeId(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : null;
}

const writeLocks = new Map<string, Promise<unknown>>();

/** Serialise all work touching one path, so read-modify-write cannot interleave. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but do not let a rejection poison the next caller.
  writeLocks.set(
    key,
    next.catch(() => {})
  );
  return next;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write-then-rename: a crash mid-write leaves the previous version, not a
  // truncated one. These files are a term's worth of collected judgements.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function saveBundle(b: Bundle): Promise<void> {
  await withLock(bundlePath(b.handout_id), () => writeJson(bundlePath(b.handout_id), b));
}

export async function loadBundle(id: string): Promise<Bundle | null> {
  try {
    return JSON.parse(await fs.readFile(bundlePath(id), "utf8")) as Bundle;
  } catch {
    return null;
  }
}

export async function listBundles(): Promise<Bundle[]> {
  let names: string[];
  try {
    names = await fs.readdir(HANDOUT_DIR);
  } catch {
    return []; // nothing uploaded yet is not an error
  }
  const out: Bundle[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".handout.json")) continue;
    const b = await loadBundle(n.slice(0, -".handout.json".length));
    if (b) out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A student's file: their recorded assignment, and their records
// ---------------------------------------------------------------------------

/** One graded section. This is the exported line, stored as written. */
export interface Record_ {
  schema_version: 1;
  term: string;
  handout_id: string;
  section_id: string;
  section_index: number;
  student_hash: string;
  version_id: string;
  content_sha: string;
  generation: Generation;
  learning_objective: string;
  grade: number;
  tags: string[];
  comment: string;
  ts: string;
}

export interface StudentFile {
  schema_version: 1;
  handout_id: string;
  student_hash: string;
  /** section_id -> version_id, written once at first render and read back
   *  forever after. The rotation is an input to this file, not a substitute
   *  for it. */
  assigned: Record<string, string>;
  assigned_at: string;
  /** section_id -> the latest record. A student may change their mind; only
   *  the current answer is kept, because the earlier one was a mis-click far
   *  more often than it was a datum. */
  records: Record<string, Record_>;
}

export async function loadStudentFile(handoutId: string, hash: string): Promise<StudentFile | null> {
  try {
    return JSON.parse(await fs.readFile(responsePath(handoutId, hash), "utf8")) as StudentFile;
  } catch {
    return null;
  }
}

export async function listStudentFiles(handoutId: string): Promise<StudentFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(RESPONSE_DIR, handoutId));
  } catch {
    return [];
  }
  const out: StudentFile[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith(".json") || n.endsWith(".tmp")) continue;
    const f = await loadStudentFile(handoutId, n.slice(0, -".json".length));
    if (f) out.push(f);
  }
  return out;
}

/**
 * Read-modify-write one student's file under its own lock.
 *
 * The mutator receives the current file (or a fresh empty one) and returns the
 * version to persist, or null to leave the file untouched.
 */
export async function updateStudentFile(
  handoutId: string,
  hash: string,
  mutate: (f: StudentFile) => StudentFile | null
): Promise<StudentFile | null> {
  const file = responsePath(handoutId, hash);
  return withLock(file, async () => {
    const current: StudentFile = (await loadStudentFile(handoutId, hash)) ?? {
      schema_version: 1,
      handout_id: handoutId,
      student_hash: hash,
      assigned: {},
      assigned_at: new Date().toISOString(),
      records: {},
    };
    const next = mutate(current);
    if (!next) return current;
    await writeJson(file, next);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Which version this student reads
// ---------------------------------------------------------------------------

/**
 * The rotation: `(studentIndex + sectionIndex) % versions.length`.
 *
 * At six students and six versions this is an exact Latin square — within any
 * one section the six students hold the six versions between them, and every
 * version is read the same number of times by a different student each time.
 * That is what keeps a version effect separable from a rater effect at one
 * judgement per cell, which a random draw only approaches in expectation and
 * never reaches at n=6.
 *
 * The same expression degrades correctly when the instructor narrows to three
 * versions or two: three readers per version, or two. Exploration and
 * replication are the same code.
 */
export function rotationVersion(studentIdx: number, sectionIdx: number, versions: string[]): string {
  return versions[(studentIdx + sectionIdx) % versions.length];
}

export type Assignment =
  | { kind: "student"; hash: string; assigned: Record<string, string> }
  | { kind: "preview"; version: string }
  | { kind: "off-roster" };

/**
 * Resolve — and persist — what this reader sees.
 *
 * Three readers, three answers:
 *
 *  - a roster student gets the rotation, WRITTEN DOWN at first render and read
 *    back forever after. Re-deriving it per request is the same class of bug as
 *    recomputing a sticky readingId: it works until the inputs change, and then
 *    it rewrites history.
 *  - the admin gets a preview. They have no slot and no avatar, and the handout
 *    page is where they check rendering — so `?version=` selects, and nothing
 *    is recorded.
 *  - anyone else is refused. NOT quietly given slot 0: that is a real student's
 *    rotation, and two people on one rotation destroys the balance the whole
 *    design rests on. The fix is a one-line STUDENTS change.
 */
export async function resolveAssignment(
  bundle: Bundle,
  email: string,
  isAdmin: boolean,
  wantVersion?: unknown
): Promise<Assignment> {
  if (isAdmin) {
    const want = String(wantVersion ?? "").trim();
    return { kind: "preview", version: bundle.versions.includes(want) ? want : bundle.versions[0] };
  }
  const idx = studentIndex(email);
  if (idx === undefined) return { kind: "off-roster" };

  const hash = studentHash(email);
  const file = await updateStudentFile(bundle.handout_id, hash, (f) => {
    let changed = false;
    for (const [sectionIdx, s] of bundle.sections.entries()) {
      const recorded = f.assigned[s.section_id];
      // A recorded version whose body is no longer in the bundle means the
      // instructor narrowed `versions` after this student had already been
      // assigned. Re-rotate rather than render a blank section, and say so —
      // the earlier records still carry their own content_sha, so the dataset
      // splits rather than lying.
      if (recorded && s.bodies[recorded]) continue;
      if (recorded) {
        console.warn(
          `[handouts] ${bundle.handout_id}/${s.section_id}: version "${recorded}" is gone from the ` +
            `bundle; re-assigning. Narrowing versions after data exists splits the dataset.`
        );
      }
      f.assigned[s.section_id] = rotationVersion(idx, sectionIdx, bundle.versions);
      changed = true;
    }
    return changed ? f : null;
  });
  return { kind: "student", hash, assigned: file!.assigned };
}
