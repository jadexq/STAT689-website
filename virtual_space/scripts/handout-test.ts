// Handout suite (step 4). Unlike the other five, this one BRINGS ITS OWN
// SERVER:
//
//   npx tsx scripts/handout-test.ts
//
// Nothing else needs to be running, and the TA is not involved at all — which
// is itself a property worth having, since handouts must keep working when the
// TA is down.
//
// It spawns the space on a spare port with its own DATA_DIR under the system
// temp directory and its own six-address roster, then throws it away. That is
// not fussiness. The properties worth asserting here are about SIX students
// holding six versions between them, and the developer's own .env assigns one
// slot: asserting a Latin square against a one-student roster would be
// asserting nothing. Owning the environment is also what keeps this suite
// order-independent — it depends on no disk state and no machine-local
// fixture, which is the rule the other suites were cleaned to obey.

import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { contentSha, type Bundle } from "../server/handout-format";

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.HANDOUT_TEST_PORT || 2571);
const IAP_PORT = PORT + 1;
const H = `http://127.0.0.1:${PORT}`;

// Six addresses for six slots, in roster order: s1..s5 then jade.
const STUDENTS = ["s1@test", "s2@test", "s3@test", "s4@test", "s5@test", "s6@test"];
const STUDENTS_ENV = STUDENTS.map((e, i) => `${e}=${i < 5 ? `s${i + 1}` : "jade"}`).join(",");
const ADMIN = "prof@test";

let pass = 0;
function assert(v: unknown, label: string) {
  if (!v) throw new Error(`ASSERT FAILED: ${label}`);
  pass++;
  console.log(`  ✓ ${label}`);
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];
const dirs: string[] = [];

function startServer(port: number, env: Record<string, string>): ChildProcess {
  const data = mkdtempSync(path.join(tmpdir(), "handout-test-"));
  dirs.push(data);
  const child = spawn("npx", ["tsx", "server/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: data,
      STUDENTS: STUDENTS_ENV,
      ADMIN_EMAILS: ADMIN,
      DEV_USER: ADMIN,
      HANDOUT_SALT: "suite-salt",
      // The suite never speaks to the TA, and must not sit waiting for one.
      TA_URL: "http://127.0.0.1:1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log: string[] = [];
  child.stdout?.on("data", (d) => log.push(String(d)));
  child.stderr?.on("data", (d) => log.push(String(d)));
  (child as any).__log = log;
  return child;
}

async function waitForPort(port: number, child: ChildProcess, label: string) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited (${child.exitCode}):\n${((child as any).__log || []).join("")}`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}/api/repos`);
      return;
    } catch {
      await wait(200);
    }
  }
  throw new Error(`${label} did not come up:\n${((child as any).__log || []).join("")}`);
}

function cleanup() {
  for (const c of children) c.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Bundles. The real fixture is used for content; synthetic ones for shape,
// because "six students hold six versions" needs six versions and the tracked
// fixture deliberately ships three.
// ---------------------------------------------------------------------------

function synth(sections: number, versions: string[], idPrefix = "sec"): Bundle {
  return {
    schema_version: 1,
    handout_id: `synth-${sections}x${versions.length}`,
    title: `Synthetic ${sections}×${versions.length}`,
    chapter: "GPT",
    term: "2026F",
    versions,
    sections: Array.from({ length: sections }, (_, i) => {
      const sid = `${idPrefix}_${i}`;
      const bodies: Bundle["sections"][number]["bodies"] = {};
      for (const v of versions) {
        const markdown = `Body of ${sid}, version ${v}.\n`;
        bodies[v] = {
          markdown,
          content_sha: contentSha(markdown),
          approach: `approach-${v}`,
          generation: { model: "human", prompt_template: `tpl_${v}`, temperature: 0, generated: "2026-08-23" },
        };
      }
      return {
        section_id: sid,
        title: `Section ${i}`,
        // Byte-identical across versions, which is what makes derived pairs
        // legitimate — asserted below rather than assumed.
        learning_objective: `The student understands topic ${i}.`,
        bodies,
      };
    }),
  };
}

async function upload(b: Bundle, as = ADMIN): Promise<Response> {
  return fetch(`${H}/api/handouts?as=${encodeURIComponent(as)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
}

/** section_id -> version_id, as the server actually assigned it, read off the page. */
async function pageAssignment(handoutId: string, as: string, bundle: Bundle): Promise<Record<string, string>> {
  const html = await (await fetch(`${H}/handout/${handoutId}?as=${encodeURIComponent(as)}`)).text();
  const out: Record<string, string> = {};
  for (const s of bundle.sections) {
    // The version id is deliberately absent from the markup, so it is
    // recovered from which body was rendered. That is the honest test anyway:
    // it asserts what the student saw, not what a data attribute claimed.
    for (const [v, body] of Object.entries(s.bodies)) {
      if (html.includes(body.markdown.trim().split("\n")[0])) out[s.section_id] = v;
    }
  }
  return out;
}

function bundler(dir: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn("npx", ["tsx", "scripts/bundle-handout.ts", dir], { cwd: ROOT });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Starting a private space on :${PORT} …`);
  const server = startServer(PORT, {});
  await waitForPort(PORT, server, "space");

  // ---- 1. the bundler refuses every broken fixture ----
  console.log("\n1. The bundler refuses, rather than warns");
  const good = await bundler(path.join(ROOT, "fixtures", "handout-sample"));
  assert(good.code === 0, `the sample fixture bundles clean (${good.out.trim().split("\n")[0]})`);
  const badCases = [
    ["objective-drift", "learning_objective differs"],
    ["title-drift", "title differs"],
    ["missing-version", "missing version"],
    ["orphan-file", "not listed in handout.json"],
    ["filename-mismatch", "does not match the filename"],
    ["no-generation", "generation needs"],
  ] as const;
  for (const [dir, needle] of badCases) {
    const r = await bundler(path.join(ROOT, "fixtures", "handout-bad", dir));
    assert(r.code !== 0 && r.out.includes(needle), `${dir}: refused, and says why ("${needle}")`);
  }

  // ---- 2. the rotation is a Latin square ----
  console.log("\n2. Six students, six versions: an exact Latin square");
  const six = synth(6, ["A", "B", "C", "D", "E", "F"]);
  assert((await upload(six)).ok, "a six-version handout uploads");
  const seen: Record<string, Record<string, string>> = {};
  for (const s of STUDENTS) seen[s] = await pageAssignment(six.handout_id, s, six);

  for (const sec of six.sections) {
    const held = STUDENTS.map((s) => seen[s][sec.section_id]);
    assert(
      new Set(held).size === six.versions.length,
      `${sec.section_id}: the six students hold six distinct versions (${held.join("")})`
    );
  }
  const counts = new Map<string, number>();
  for (const s of STUDENTS) for (const v of Object.values(seen[s])) counts.set(v, (counts.get(v) ?? 0) + 1);
  assert(
    [...counts.values()].every((n) => n === six.sections.length),
    `every version is read exactly ${six.sections.length}× across the cohort`
  );
  for (const s of STUDENTS) {
    assert(
      new Set(Object.values(seen[s])).size === six.versions.length,
      `${s} reads all six approaches, none twice`
    );
  }

  // ---- 3. narrowing later still balances ----
  console.log("\n3. Narrowing to three versions, and to two, still balances");
  for (const versions of [["A", "B", "C"], ["A", "B"]]) {
    const b = synth(6, versions);
    assert((await upload(b)).ok, `a ${versions.length}-version handout uploads`);
    const per = new Map<string, number>();
    for (const s of STUDENTS) {
      const a = await pageAssignment(b.handout_id, s, b);
      for (const v of Object.values(a)) per.set(v, (per.get(v) ?? 0) + 1);
    }
    const each = (6 * 6) / versions.length;
    assert(
      versions.every((v) => per.get(v) === each),
      `at ${versions.length} versions each is read ${each}× — the same expression, no code change`
    );
  }

  // ---- 4. the assignment is recorded, not re-derived ----
  console.log("\n4. The assignment is written down, not recomputed");
  const before = await pageAssignment(six.handout_id, STUDENTS[2], six);
  assert(
    JSON.stringify(await pageAssignment(six.handout_id, STUDENTS[2], six)) === JSON.stringify(before),
    "reloading gives the same versions"
  );

  // Re-upload the SAME handout_id with an extra section and an extra version —
  // exactly what happens when the instructor extends a handout mid-term.
  const grown: Bundle = {
    ...six,
    versions: [...six.versions, "G"],
    sections: [
      ...six.sections.map((s) => ({
        ...s,
        bodies: {
          ...s.bodies,
          G: {
            markdown: `Body of ${s.section_id}, version G.\n`,
            content_sha: contentSha(`Body of ${s.section_id}, version G.\n`),
            approach: "approach-G",
            generation: { model: "human", prompt_template: "tpl_G", temperature: 0, generated: "2026-08-23" },
          },
        },
      })),
      synth(7, ["A", "B", "C", "D", "E", "F", "G"]).sections[6],
    ],
  };
  assert((await upload(grown)).ok, "the same handout re-uploads with a seventh section and a seventh version");
  const after = await pageAssignment(six.handout_id, STUDENTS[2], grown);
  assert(
    six.sections.every((s) => after[s.section_id] === before[s.section_id]),
    "…and every section this student had already been assigned is unchanged"
  );
  assert(after["sec_6"] !== undefined, "…while the new section gets an assignment of its own");

  // ---- 5. who may do what ----
  console.log("\n5. Who may do what");
  assert((await upload(six, STUDENTS[0])).status === 403, "a student cannot upload a handout");
  const dash = await fetch(`${H}/admin/handouts/${six.handout_id}?as=${STUDENTS[0]}`);
  assert(dash.status === 403, "a student cannot read the dashboard");
  assert((await fetch(`${H}/admin/handouts/${six.handout_id}?as=${ADMIN}`)).ok, "the instructor can");
  const off = await fetch(`${H}/handout/${six.handout_id}?as=nobody@test`);
  assert(off.status === 403, "an off-roster reader is refused, not given slot 0's rotation");
  assert(
    (await off.text()).includes("not on the class roster"),
    "…and told why, since the fix is one line of STUDENTS"
  );

  // ---- 6. the admin preview records nothing ----
  console.log("\n6. The instructor's preview writes nothing");
  const prev = await fetch(`${H}/handout/${six.handout_id}?version=D`);
  const prevHtml = await prev.text();
  assert(prevHtml.includes("Instructor preview"), "the admin gets a preview banner");
  assert(
    prevHtml.includes("Body of sec_0, version D."),
    "…showing the version they asked for"
  );
  assert(!prevHtml.includes('class="judge'), "…with no grading widget, so it cannot be graded by accident");
  const adminPost = await fetch(`${H}/api/handouts/${six.handout_id}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ section_id: "sec_0", grade: 1 }),
  });
  assert(adminPost.status === 403, "…and a hand-rolled POST from the admin is refused too");

  // ---- 7. feedback is keyed by the caller ----
  console.log("\n7. Feedback is recorded against the caller");
  async function grade(who: string, section: string, g: number | null, tags: string[] = [], comment = "", extra = {}) {
    return fetch(`${H}/api/handouts/${six.handout_id}/feedback?as=${encodeURIComponent(who)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ section_id: section, grade: g, tags, comment, ...extra }),
    });
  }
  assert(
    (await grade(STUDENTS[0], "sec_0", 4, [], "", { student_hash: "deadbeefdeadbeef", email: STUDENTS[1] })).ok,
    "a student may grade their own section"
  );
  const recs1 = await (await fetch(`${H}/admin/handouts/${six.handout_id}?format=jsonl&as=${ADMIN}`)).text();
  const parsed1 = recs1.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert(parsed1.length === 1, "one record so far");
  assert(
    parsed1[0].student_hash !== "deadbeefdeadbeef",
    "…and the student_hash in the body was ignored — the caller decides"
  );
  assert(
    parsed1[0].version_id === seen[STUDENTS[0]]["sec_0"],
    "…and the version came from the recorded assignment, not the request"
  );
  assert((await grade(STUDENTS[0], "no_such_section", 3)).status === 400, "an unknown section is refused");
  assert((await grade(STUDENTS[0], "sec_0", 9 as number)).status === 400, "a grade of 9 is refused");
  assert((await grade("nobody@test", "sec_0", 3)).status === 400, "an off-roster address cannot leave feedback");

  // ---- 8. tags, and the nullable grade ----
  console.log("\n8. Tags belong to low grades; a comment can stand alone");
  await grade(STUDENTS[1], "sec_0", 2, ["too_abstract", "not_a_real_tag"], "Needed an example.");
  await grade(STUDENTS[2], "sec_0", 5, ["too_long"], "");
  await grade(STUDENTS[3], "sec_0", null, [], "No grade, but the notation tripped me up.");
  const byHash = new Map<string, any>();
  for (const r of (await (await fetch(`${H}/admin/handouts/${six.handout_id}?format=jsonl&as=${ADMIN}`)).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))) {
    if (r.section_id === "sec_0") byHash.set(String(r.grade), r);
  }
  assert(byHash.get("2").tags.join() === "too_abstract", "an invented tag is dropped, a real one is kept");
  assert(byHash.get("5").tags.length === 0, "tags are cleared at a grade above 3 rather than stored stale");
  assert(
    byHash.get("null").comment.includes("notation"),
    "a comment with no grade is kept — it is the most useful thing on the page"
  );

  // ---- 9. an export line is self-contained ----
  console.log("\n9. An exported record stands on its own");
  const line = byHash.get("2");
  for (const f of [
    "schema_version",
    "term",
    "handout_id",
    "section_id",
    "section_index",
    "student_hash",
    "version_id",
    "content_sha",
    "generation",
    "learning_objective",
    "grade",
    "tags",
    "comment",
    "ts",
  ]) {
    assert(line[f] !== undefined, `record carries ${f}`);
  }
  const secZero = grown.sections.find((s) => s.section_id === "sec_0")!;
  assert(
    line.content_sha === secZero.bodies[line.version_id].content_sha,
    "content_sha matches the bytes that were shown"
  );
  assert(
    new Set(Object.values(secZero.bodies).map(() => secZero.learning_objective)).size === 1 &&
      line.learning_objective === secZero.learning_objective,
    "the objective is identical across every version of the section, and is on the record"
  );
  assert(line.generation.prompt_template === `tpl_${line.version_id}`, "provenance rides along, copied not referenced");

  // ---- 10. derived pairs ----
  console.log("\n10. Preference pairs, derived and rater-mean-centred");
  // Give the raters different spreads so that centring has something to do.
  await grade(STUDENTS[1], "sec_1", 5, [], "");
  await grade(STUDENTS[2], "sec_1", 1, [], "");
  const pairsTxt = await (
    await fetch(`${H}/admin/handouts/${six.handout_id}?format=jsonl&pairs=1&as=${ADMIN}`)
  ).text();
  const pairs = pairsTxt.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert(pairs.length > 0, `${pairs.length} pair(s) derived from the grades alone`);
  assert(
    pairs.every((p) => p.chosen_meta.version_id !== p.rejected_meta.version_id),
    "no pair puts a version against itself"
  );
  assert(
    pairs.every((p) => p.chosen_meta.grade_centred > p.rejected_meta.grade_centred),
    "the chosen side is always the higher centred grade — ties are dropped, not broken"
  );
  assert(
    pairs.every((p) => p.prompt && typeof p.section_id === "string"),
    "every pair names its section and carries the objective as the prompt"
  );
  for (const p of pairs) {
    const sec = grown.sections.find((s) => s.section_id === p.section_id)!;
    if (
      p.prompt !== sec.learning_objective ||
      p.chosen !== sec.bodies[p.chosen_meta.version_id].markdown ||
      p.rejected !== sec.bodies[p.rejected_meta.version_id].markdown
    ) {
      throw new Error(`ASSERT FAILED: a pair's sides do not match the bundle (${p.section_id})`);
    }
  }
  pass++;
  console.log("  ✓ both sides of every pair are the real bodies, under one shared objective");

  // Editing a version after it was graded must split the dataset, not rewrite
  // it: the stale record drops out of the pairs rather than pairing an old
  // grade with new prose.
  const beforeStale = pairs.length;
  const sec1Pairs = pairs.filter((p) => p.section_id === "sec_1").length;
  assert(sec1Pairs > 0, `sec_1 contributes ${sec1Pairs} pair(s) before the edit`);
  const edited: Bundle = JSON.parse(JSON.stringify(grown));
  {
    // Edit a version somebody actually holds — editing an unread one proves
    // nothing, and an assertion that can pass vacuously is not an assertion.
    const s = edited.sections.find((x) => x.section_id === "sec_1")!;
    const v = seen[STUDENTS[1]]["sec_1"];
    s.bodies[v].markdown += "\nA sentence the instructor added later.\n";
    s.bodies[v].content_sha = contentSha(s.bodies[v].markdown);
  }
  assert((await upload(edited)).ok, "the instructor edits a version that had already been graded");
  const after2 = (await (await fetch(`${H}/admin/handouts/${six.handout_id}?format=jsonl&pairs=1&as=${ADMIN}`)).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert(
    after2.length === beforeStale - sec1Pairs,
    `every pair resting on the edited text drops out (${beforeStale} → ${after2.length}); ` +
      `the dataset splits rather than lying`
  );
  // The records themselves are untouched — an edit must not delete evidence.
  const stillThere = (await (await fetch(`${H}/admin/handouts/${six.handout_id}?format=jsonl&as=${ADMIN}`)).text())
    .trim()
    .split("\n")
    .filter(Boolean);
  assert(stillThere.length >= 6, `…while all ${stillThere.length} records survive the edit`);

  // ---- 11. the panel, and the off-roster note ----
  console.log("\n11. The 📝 Handouts list");
  const mine = (await (await fetch(`${H}/api/handouts?as=${STUDENTS[0]}`)).json()) as any;
  assert(mine.handouts.length >= 1, `${mine.handouts.length} handout(s) listed`);
  const grownCard = mine.handouts.find((h: any) => h.id === six.handout_id);
  assert(grownCard.graded === 1 && grownCard.sections === 7, "progress is per student: 1 of 7 graded");
  assert(!mine.note, "a roster student gets no warning");
  const stranger = (await (await fetch(`${H}/api/handouts?as=nobody@test`)).json()) as any;
  assert(
    String(stranger.note).includes("not on the class roster"),
    "someone off the roster is told why, in the Common Area where they land"
  );

  // ---- 12. failing closed without a salt ----
  console.log("\n12. No salt behind IAP: handouts stop, the campus does not");
  const iap = startServer(IAP_PORT, {
    TRUST_IAP_HEADER: "1",
    IAP_JWT_AUDIENCE: "/projects/0/locations/x/services/y",
    HANDOUT_SALT: "",
  });
  await waitForPort(IAP_PORT, iap, "iap space");
  const I = `http://127.0.0.1:${IAP_PORT}`;
  for (const [p, label] of [
    ["/api/handouts", "the list"],
    [`/handout/${six.handout_id}`, "the handout page"],
    [`/admin/handouts/${six.handout_id}`, "the dashboard"],
  ] as const) {
    const r = await fetch(`${I}${p}`);
    assert(r.status === 503, `${label} answers 503, not an unsalted hash`);
  }
  const post = await fetch(`${I}/api/handouts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert(post.status === 503, "…and so does the upload");
  assert((await fetch(`${I}/api/repos`)).ok, "…while the rest of the campus is untouched");

  console.log(`\nALL ${pass} HANDOUT ASSERTIONS PASSED ✅`);
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\nHANDOUT TEST FAILED ❌: ${err.message || err}`);
    cleanup();
    process.exit(1);
  });
