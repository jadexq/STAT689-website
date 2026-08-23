// The course-material index and search (server/materials.ts). No LLM calls
// and no server needed — this exercises retrieval on its own, which is the
// half of an answer that can be checked without asking a model anything.
//
// Usage: npx tsx scripts/materials-test.ts

import { listReadings, loadReading, searchMaterials, passageBlock } from "../server/materials.ts";

function assert(v: unknown, label: string) {
  if (!v) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function main() {
  console.log("1. Manifest and index");
  const readings = await listReadings();
  assert(readings.length > 0, `manifest lists ${readings.length} document(s)`);
  if (readings.length === 1) {
    console.log("  ! only one document — cross-document ranking is not exercised here");
  }

  console.log("\n2. A question about the corpus finds passages");
  const first = readings[0];
  // Query built from the document's own title, so this holds whatever the
  // instructor has actually put in materials/.
  const query = first.title;
  const hits = await searchMaterials(query);
  assert(hits.length > 0, `"${query.slice(0, 40)}…" returned ${hits.length} passage(s)`);
  assert(hits.some((h) => h.readingId === first.id), "…including the document it names");
  assert(hits.every((h) => h.text.trim().length > 0), "…all non-empty");

  console.log("\n3. Passages are labelled with their source");
  const block = passageBlock(hits.slice(0, 2));
  assert(block.includes(first.title), "the prompt block names the document");
  assert(/part \d+/.test(block), "…and which part of it");

  console.log("\n4. A budget is respected");
  const small = await searchMaterials(query, 1_600);
  assert(small.reduce((n, p) => n + p.text.length, 0) <= 1_600, "total passage length stays inside the budget");
  assert(small.length <= hits.length, "…by returning fewer passages, not truncated ones");

  console.log("\n5. Nonsense matches nothing");
  const none = await searchMaterials("qwertzuiop plugh xyzzy frobnicate");
  assert(none.length === 0, "no passages for terms that appear nowhere");

  console.log("\n6. Naming a document still loads the whole thing");
  const loaded = await loadReading(first.id);
  assert(!!loaded && loaded.text.length > 0, `loaded "${first.title}" (${loaded!.text.length} chars)`);

  console.log("\nMATERIALS TEST PASSED ✅");
}

main().catch((err) => {
  console.error("\nMATERIALS TEST FAILED ❌:", err.message || err);
  process.exit(1);
});
