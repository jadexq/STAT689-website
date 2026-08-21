// Restart-memory test (Phase A3).
//
// On Cloud Run with min-instances=0, every quiet spell is a restart, and
// anything held in RAM is gone. This checks the one thing that makes that
// survivable: a session absent from memory is rebuilt from the durable
// turn log, rather than treating a returning student as a stranger.
//
// No server and no LLM calls — a fresh process IS the cold start. We write
// turns to the log, then ask for a session that was never in this process's
// memory and see what comes back.
//
// Usage: npx tsx scripts/memory.ts

import { initStorage, logTurn } from "../server/logger.ts";
import { ensureSession, getSession } from "../server/session.ts";

function assert(v: unknown, label: string) {
  if (!v) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function main() {
  await initStorage();
  const id = `test:memory-${Date.now()}`;

  console.log("\n1. A conversation happens and is logged");
  await logTurn({ sessionId: id, role: "user", skill: null, readingId: null, content: "What is a Gumbel distribution?" });
  await logTurn({ sessionId: id, role: "assistant", skill: "coach", readingId: "week3", content: "Let's start with what you already know about extremes." });
  await logTurn({ sessionId: id, role: "user", skill: "coach", readingId: "week3", content: "Something about maxima?" });
  await logTurn({ sessionId: id, role: "assistant", skill: "coach", readingId: "week3", content: "Right — it is the limit law for maxima." });
  console.log("  ✓ 4 turns written");

  console.log("\n2. The server restarts (this process has never seen the session)");
  assert(getSession(`${id}-untouched`).history.length === 0, "an unknown session starts empty");

  console.log("\n3. The student comes back");
  const s = await ensureSession(id);
  assert(s.history.length === 4, "all 4 turns were restored");
  assert(s.history[0].content.includes("Gumbel"), "…oldest first, in order");
  assert(s.history[3].role === "assistant", "…with roles intact");
  assert(s.mode === "coach", "the sticky mode was restored");
  assert(s.readingId === "week3", "the selected reading was restored");

  console.log("\n4. A second call does not replay the log again");
  const again = await ensureSession(id);
  assert(again === s, "the same session object comes back");
  assert(again.history.length === 4, "history was not duplicated");

  console.log("\n5. Concurrent first-touches share one load");
  const id2 = `test:memory-race-${Date.now()}`;
  await logTurn({ sessionId: id2, role: "user", skill: null, content: "hello" });
  const [a, b] = await Promise.all([ensureSession(id2), ensureSession(id2)]);
  assert(a === b, "both callers got the same session");
  assert(a.history.length === 1, "the log was replayed exactly once");

  console.log("\nALL MEMORY TESTS PASSED ✅");
}

main().catch((err) => {
  console.error("\nMEMORY TEST FAILED ❌:", err.message || err);
  process.exit(1);
});
