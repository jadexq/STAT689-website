// The course-material index, retrieval, and the agenda parser
// (server/materials.ts, server/agenda.ts). No LLM calls and no server — this
// is the half of an answer that can be checked without asking a model
// anything.
//
// Usage: npm run test:materials  — NEVER bare `npx tsx`. virtual_ta loads
// .env only through node's --env-file-if-exists, which the npm script passes
// and a bare invocation does not; run bare, this reads the committed fixture
// instead of the corpus MATERIALS_DIR points at and reports green against the
// wrong documents. It has done exactly that once.

import {
  isPinned,
  listReadings,
  loadReading,
  matchReading,
  passageBlock,
  searchMaterials,
  searchWithin,
  stripHtml,
} from "../server/materials.ts";
import { loadAgenda, parseAgenda } from "../server/agenda.ts";

function assert(v: unknown, label: string) {
  if (!v) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function main() {
  console.log("1. Manifest and index");
  const readings = await listReadings();
  assert(readings.length > 0, `manifest lists ${readings.length} document(s)`);
  const searchable = readings.filter((r) => !isPinned(r));
  const pinned = readings.filter(isPinned);
  assert(searchable.length > 0, `${searchable.length} searchable, ${pinned.length} pinned`);
  if (searchable.length === 1) {
    console.log("  ! only one searchable document — cross-document ranking is not exercised here");
  }

  console.log("\n2. A question about the corpus finds passages");
  const first = searchable[0];
  // Query built from the document's own title, so this holds whatever the
  // instructor has actually put in the corpus.
  const hits = await searchMaterials(first.title);
  assert(hits.length > 0, `"${first.title.slice(0, 40)}…" returned ${hits.length} passage(s)`);
  assert(hits.some((h) => h.readingId === first.id), "…including the document it names");
  assert(hits.every((h) => h.text.trim().length > 0), "…all non-empty");

  console.log("\n3. Passages are labelled with their source");
  const block = passageBlock(hits.slice(0, 2));
  assert(block.includes(first.title), "the prompt block names the document");
  assert(/§ .+|part \d+/.test(block), "…and the section it came from, or its part number");

  console.log("\n4. A budget is respected");
  const small = await searchMaterials(first.title, 1_600);
  assert(small.reduce((n, p) => n + p.text.length, 0) <= 1_600, "total passage length stays inside the budget");
  assert(small.length <= hits.length, "…by returning fewer passages, not truncated ones");

  console.log("\n5. Nonsense matches nothing");
  const none = await searchMaterials("qwertzuiop plugh xyzzy frobnicate");
  assert(none.length === 0, "no passages for terms that appear nowhere");

  console.log("\n6. Naming a document loads it");
  const loaded = await loadReading(first.id);
  assert(!!loaded && loaded.text.length > 0, `loaded "${first.title}" (${loaded!.text.length} chars)`);

  // ---- pinned readings (2d) ----
  console.log("\n7. Pinned readings are out of retrieval and out of matching");
  if (!pinned.length) {
    console.log("  ! nothing pinned in this corpus — skipped");
  } else {
    for (const p of pinned) {
      const inIndex = (await searchMaterials(p.title)).some((h) => h.readingId === p.id);
      assert(!inIndex, `"${p.title}" is not in the chunk index`);
      const matched = await matchReading(`what does the ${p.title} say about week 3?`);
      assert(matched?.id !== p.id, "…and naming it does not pin the conversation to it");
      assert(!!(await loadReading(p.id)), "…but it can still be loaded by id");
    }
  }

  // ---- long documents (2f) ----
  console.log("\n8. A long document is retrieved within, not truncated");
  const long = (
    await Promise.all(
      searchable.map(async (r) => ({ r, len: (await loadReading(r.id))?.text.length ?? 0 }))
    )
  ).sort((a, b) => b.len - a.len)[0];
  const full = await loadReading(long.r.id);
  if (!full?.truncated) {
    console.log(`  ! longest document is ${long.len} chars, under the cap — not exercised here`);
  } else {
    // Take a heading from the LAST quarter of the document and ask for it.
    // Before 2f, a named reading was the first 28k characters, so anything
    // down here was unreachable however it was phrased.
    const all = await searchWithin(long.r.id, long.r.title, 10_000_000);
    const lastQuarter = all.filter((p) => p.part > all.length * 0.75 && p.heading);
    assert(lastQuarter.length > 0, `"${long.r.title}" has headed sections in its last quarter`);
    const target = lastQuarter[Math.floor(lastQuarter.length / 2)];
    const got = await searchWithin(long.r.id, target.heading);
    assert(got.length > 0, `a question about "§ ${target.heading.slice(0, 48)}" retrieves passages`);
    assert(got.some((p) => p.part === target.part), "…including the section it asked about");
    assert(
      got.every((p, i, a) => i === 0 || a[i - 1].part <= p.part),
      "…returned in document order"
    );
  }

  // ---- the agenda (2c) ----
  console.log("\n9. The agenda parser");
  const spec = [
    "| Date | Week | Lecture | Content | Homework | Topic |",
    "|:--|---|---|---|---|---|",
    "| 2026/08/24 | 1 | 1 | Overview | submit CV | Intro |",
    "| 2026/08/26 | 1 | 2 | More overview | - | |",
    "| 08/28 | 1 | 3 | Undatable | | |",
    "| 2026/13/40 | 1 | 4 | Impossible date | | |",
    "| 2026/09/14 | 4 | 9 | | | Later |",
    "",
  ].join("\n");
  const parsed = parseAgenda(spec);
  assert(parsed.rows.length === 3, `3 datable rows of 5 (${parsed.problems.length} reported)`);
  assert(parsed.rows[1].topic === "Intro", "a blank Topic continues the block above");
  assert(parsed.rows[2].topic === "Later", "…and a filled one starts a new block");
  assert(parsed.rows[0].planned && !parsed.rows[2].planned, "a row with no content is scheduled-but-unplanned");
  assert(
    parsed.problems.some((p) => p.includes("08/28")),
    "a two-digit year is reported, not guessed"
  );
  assert(
    parsed.problems.some((p) => p.includes("2026/13/40")),
    "…and so is a date that is well-formed but not real"
  );
  assert(
    parsed.problems.every((p) => /^Line \d+:/.test(p)),
    "…each naming the line to fix"
  );
  const malformed = parseAgenda("| Date | Content |\n|--|--|\n| 2026/08/24 |\n| 2026/08/26 | ok |\n");
  assert(malformed.rows.length === 2, "a row with missing cells does not stop the rest parsing");

  console.log("\n10. The corpus's own agenda");
  const live = await loadAgenda();
  if (!live) {
    console.log("  ! no reading marked `\"agenda\": true` — skipped");
  } else {
    assert(live.rows.length > 0, `${live.rows.length} dated session(s)`);
    assert(live.problems.length === 0, "no rows the parser had to refuse");
    assert(
      live.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.iso)),
      "every row carries a four-digit year"
    );
    assert(
      live.rows.every((r, i, a) => i === 0 || a[i - 1].iso <= r.iso),
      "…and they come back in date order"
    );
  }

  console.log("\n11. Formats");
  assert(
    stripHtml("<style>x{}</style><p>Hello <b>there</b></p><script>bad()</script>").trim() ===
      "Hello there",
    "HTML strips to its text, script and style included"
  );
  const byExt = new Set(readings.map((r) => r.file.split(".").pop()));
  console.log(`  · corpus formats present: ${[...byExt].join(", ")}`);
  if (!byExt.has("pdf")) console.log("  ! no PDF in this corpus — extraction not exercised");

  console.log("\nMATERIALS TEST PASSED ✅");
}

main().catch((err) => {
  console.error("\nMATERIALS TEST FAILED ❌:", err.message || err);
  process.exit(1);
});
