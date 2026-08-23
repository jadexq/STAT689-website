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
import { SLOTS, assignedStudents, displayNameFor, slotFor } from "./roster";

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

// A salt that CHANGES after data exists is worse than one that is missing:
// every hash moves, so every student silently loses their recorded version
// assignment and every record already collected becomes an orphan under a
// hash nobody holds any more. Nothing errors; the dashboard just shows fewer
// responses than it did last week.
//
// So the first response file written also stamps a fingerprint of the salt
// beside it, and every handout route checks it. A changed salt then fails the
// way a missing one does — loudly, with the fix named — instead of quietly
// deleting a term of work. See open-issues D8.
function saltFingerprint(): string {
  const salt = SALT || (TRUST_IAP ? "" : DEV_SALT);
  return createHash("sha256").update(`fingerprint:${salt}`, "utf8").digest("hex").slice(0, 16);
}

let guardOnce: Promise<{ ok: boolean; note: string }> | null = null;

/** saltState(), plus "and it is the same salt the existing data was written under". */
export function saltGuard(): Promise<{ ok: boolean; note: string }> {
  if (guardOnce) return guardOnce;
  guardOnce = (async () => {
    const base = saltState();
    if (!base.ok) return base;
    const seen = (await fs.readFile(FINGERPRINT_FILE, "utf8").catch(() => null))?.trim();
    // No fingerprint means no responses have ever been written here, so there
    // is nothing yet to orphan and changing the salt is still free.
    if (!seen || seen === saltFingerprint()) return base;
    return {
      ok: false,
      note:
        "HANDOUT_SALT does not match the salt the existing responses were written under. " +
        "Handout routes are disabled rather than silently orphaning them: every student_hash " +
        "would change, so every recorded version assignment and every collected grade would " +
        "become unreachable. Restore the previous salt, or migrate the files under " +
        "DATA_DIR/space/handouts/responses/ to the new hashes and delete .salt-fingerprint.",
    };
  })();
  return guardOnce;
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
const FINGERPRINT_FILE = path.join(HANDOUT_DIR, ".salt-fingerprint");

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
  /** null means "commented but not graded" — see saveRecord(). */
  grade: number | null;
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
    // wx: written exactly once, by whoever creates the first response.
    await fs
      .writeFile(FINGERPRINT_FILE, `${saltFingerprint()}\n`, { flag: "wx" })
      .catch(() => {});
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
  | { kind: "student"; hash: string; assigned: Record<string, string>; records: Record<string, Record_> }
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
  return { kind: "student", hash, assigned: file!.assigned, records: file!.records };
}

// ---------------------------------------------------------------------------
// Recording a judgement
// ---------------------------------------------------------------------------

// Shown only at a grade of 3 or below: a tag list next to a good grade invites
// tagging for its own sake, and "what went wrong" is the question worth asking.
export const TAGS = [
  "too_abstract",
  "too_difficult",
  "too_simple",
  "too_long",
  "missing_examples",
  "poor_organization",
  "unclear_notation",
] as const;

const MAX_COMMENT = 4000;

export interface FeedbackInput {
  section_id: unknown;
  grade: unknown;
  tags: unknown;
  comment: unknown;
}

/**
 * Write one student's judgement of one section.
 *
 * The version, the content hash, the provenance and the objective are all
 * taken from the SERVER's copy — the caller supplies a section, a grade, tags
 * and prose, and nothing else. A record that trusted the client for the
 * version id would be a record anyone could mislabel.
 *
 * A null grade is allowed and is not an oversight. A student who types a
 * comment and navigates away before clicking a number has still said the most
 * useful thing on the page; losing it to preserve a non-null column would be
 * the wrong trade. Such records export, and are skipped when deriving pairs.
 */
export async function saveRecord(
  bundle: Bundle,
  email: string,
  input: FeedbackInput
): Promise<{ ok: true; record: Record_ } | { ok: false; note: string }> {
  const idx = studentIndex(email);
  if (idx === undefined) return { ok: false, note: "You are not on the class roster for this handout." };

  const sectionId = String(input.section_id ?? "");
  const sectionIndex = bundle.sections.findIndex((s) => s.section_id === sectionId);
  if (sectionIndex < 0) return { ok: false, note: "No such section in this handout." };
  const section = bundle.sections[sectionIndex];

  const rawGrade = input.grade;
  let grade: number | null = null;
  if (rawGrade !== null && rawGrade !== undefined && rawGrade !== "") {
    const n = Number(rawGrade);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { ok: false, note: "A grade is a whole number from 1 to 5." };
    grade = n;
  }

  const allowed = new Set<string>(TAGS);
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map(String).filter((t) => allowed.has(t)))]
    : [];
  const comment = String(input.comment ?? "").slice(0, MAX_COMMENT).trim();

  const hash = studentHash(email);
  let record!: Record_;
  await updateStudentFile(bundle.handout_id, hash, (f) => {
    // The assignment must already exist — it is written when the page renders.
    // Falling back to the rotation here would let a POST that never opened the
    // page invent an assignment, which is how a record ends up describing text
    // the student never saw.
    const versionId = f.assigned[sectionId];
    if (!versionId) return null;
    const body = section.bodies[versionId];
    if (!body) return null;
    record = {
      schema_version: 1,
      term: bundle.term,
      handout_id: bundle.handout_id,
      section_id: sectionId,
      section_index: sectionIndex,
      student_hash: hash,
      version_id: versionId,
      content_sha: body.content_sha,
      // Copied, not referenced: an exported line has to survive the instructor
      // editing the source, and the objective is the prompt half of every
      // preference pair derived from these grades.
      generation: body.generation,
      learning_objective: section.learning_objective,
      grade,
      tags: grade !== null && grade <= 3 ? tags : [],
      comment,
      ts: new Date().toISOString(),
    };
    f.records[sectionId] = record;
    return f;
  });
  if (!record) return { ok: false, note: "Open the handout before grading it." };
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Reading the result back
// ---------------------------------------------------------------------------

export interface SectionSummary {
  section_id: string;
  title: string;
  learning_objective: string;
  responded: number;
  /** Mean of the grades given, or null if nobody graded it. Worst-first order
   *  is by this — the point of the view is which section to rewrite next. */
  mean: number | null;
  tagCounts: [string, number][];
  rows: {
    version_id: string;
    approach: string;
    prompt_template: string;
    grade: number | null;
    tags: string[];
    comment: string;
    /** First 8 hex of the salted hash: enough to notice one rater who grades
     *  everything harshly, without organising the view around people. */
    who: string;
    /** The roster name, only when the caller asked for names. See renderDashboard. */
    name?: string;
    /** False once the instructor has edited this version since it was graded. */
    current: boolean;
  }[];
}

export interface HandoutSummary {
  bundle: Bundle;
  /** Slots that belong to a real person. NOT SLOTS.length — a slot with no
   *  address is a character played by an AI, not a student who has not
   *  answered, and counting it makes every response rate look worse than it is. */
  cohort: number;
  /** Roster names with no records at all for this handout. Identity in the
   *  NEGATIVE: chasing a non-responder needs a name, and it attaches that name
   *  to no opinion. */
  notAnswered: string[];
  /** True when ?names=1 was asked for — the view says so, rather than the
   *  reader having to notice. */
  named: boolean;
  sections: SectionSummary[];
}

export async function summarise(bundle: Bundle, named = false): Promise<HandoutSummary> {
  const files = await listStudentFiles(bundle.handout_id);
  const sections: SectionSummary[] = [];
  const roster = assignedStudents();
  const nameByHash = new Map(roster.map(({ email }) => [studentHash(email), displayNameFor(email)]));

  for (const s of bundle.sections) {
    const rows: SectionSummary["rows"] = [];
    const tagCounts = new Map<string, number>();
    let sum = 0;
    let graded = 0;

    for (const f of files) {
      const r = f.records[s.section_id];
      if (!r) continue;
      if (r.grade !== null) {
        sum += r.grade;
        graded++;
      }
      for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      rows.push({
        version_id: r.version_id,
        approach: s.bodies[r.version_id]?.approach ?? "?",
        prompt_template: r.generation.prompt_template,
        grade: r.grade,
        tags: r.tags,
        comment: r.comment,
        who: r.student_hash.slice(0, 8),
        ...(named ? { name: nameByHash.get(r.student_hash) ?? "off-roster" } : {}),
        current: s.bodies[r.version_id]?.content_sha === r.content_sha,
      });
    }
    // Worst grade first, then whoever left a comment, then ungraded. The
    // grades are the index into the comments, not the finding.
    rows.sort((a, b) => (a.grade ?? 99) - (b.grade ?? 99) || (b.comment ? 1 : 0) - (a.comment ? 1 : 0));

    sections.push({
      section_id: s.section_id,
      title: s.title,
      learning_objective: s.learning_objective,
      responded: rows.length,
      mean: graded ? sum / graded : null,
      tagCounts: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]),
      rows,
    });
  }
  sections.sort((a, b) => (a.mean ?? 99) - (b.mean ?? 99));

  const answered = new Set(files.filter((f) => Object.keys(f.records).length).map((f) => f.student_hash));
  const notAnswered = roster
    .filter(({ email }) => !answered.has(studentHash(email)))
    .map(({ email }) => displayNameFor(email));

  return { bundle, cohort: roster.length, notAnswered, named, sections };
}

/** Every stored record, newest handout schema, one object per graded section. */
export async function exportRecords(bundle: Bundle): Promise<Record_[]> {
  const files = await listStudentFiles(bundle.handout_id);
  return files.flatMap((f) => Object.values(f.records)).sort(
    (a, b) => a.section_index - b.section_index || a.student_hash.localeCompare(b.student_hash)
  );
}

export interface Pair {
  handout_id: string;
  section_id: string;
  prompt: string;
  chosen: string;
  rejected: string;
  chosen_meta: { version_id: string; content_sha: string; prompt_template: string; grade_centred: number };
  rejected_meta: { version_id: string; content_sha: string; prompt_template: string; grade_centred: number };
}

/**
 * Preference pairs, derived rather than observed.
 *
 * Six students grade six versions of a section once each, so a section yields
 * up to C(6,2) = 15 orderable pairs. They compare ACROSS students, which is
 * the cost of dropping the pairwise probe, so each rater's own mean is
 * subtracted before ordering — the standard correction, and reasonable with
 * six calibrated readers. Ties are dropped rather than broken arbitrarily.
 *
 * A record whose content_sha no longer matches the bundle is skipped: the
 * instructor has edited that version since it was graded, and pairing an old
 * grade with new prose is exactly the corruption the hash exists to catch.
 */
export async function exportPairs(bundle: Bundle): Promise<{ pairs: Pair[]; stale: number; ties: number }> {
  const files = await listStudentFiles(bundle.handout_id);
  const bySection = new Map<string, { r: Record_; centred: number }[]>();
  let stale = 0;
  let ties = 0;

  for (const f of files) {
    const graded = Object.values(f.records).filter((r) => r.grade !== null);
    if (!graded.length) continue;
    // Centred within this handout: it is the unit the instructor exports, and
    // a rater's mean over one handout is what their grades on it are relative to.
    const mean = graded.reduce((a, r) => a + (r.grade as number), 0) / graded.length;
    for (const r of graded) {
      const section = bundle.sections.find((s) => s.section_id === r.section_id);
      const body = section?.bodies[r.version_id];
      if (!body || body.content_sha !== r.content_sha) {
        stale++;
        continue;
      }
      const list = bySection.get(r.section_id) ?? [];
      list.push({ r, centred: (r.grade as number) - mean });
      bySection.set(r.section_id, list);
    }
  }

  const pairs: Pair[] = [];
  for (const [sectionId, list] of bySection) {
    const section = bundle.sections.find((s) => s.section_id === sectionId)!;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const diff = list[i].centred - list[j].centred;
        if (Math.abs(diff) < 1e-9) {
          ties++;
          continue;
        }
        const [hi, lo] = diff > 0 ? [list[i], list[j]] : [list[j], list[i]];
        // Two records of the same version tell us about two readers, not two
        // approaches. Nothing to learn and it would be over-counted.
        if (hi.r.version_id === lo.r.version_id) continue;
        const meta = (x: typeof hi) => ({
          version_id: x.r.version_id,
          content_sha: x.r.content_sha,
          prompt_template: x.r.generation.prompt_template,
          grade_centred: Number(x.centred.toFixed(4)),
        });
        pairs.push({
          handout_id: bundle.handout_id,
          section_id: sectionId,
          // Both sides carry the same objective by construction — the bundler
          // refuses a section whose versions disagree about it.
          prompt: section.learning_objective,
          chosen: section.bodies[hi.r.version_id].markdown,
          rejected: section.bodies[lo.r.version_id].markdown,
          chosen_meta: meta(hi),
          rejected_meta: meta(lo),
        });
      }
    }
  }
  return { pairs, stale, ties };
}
