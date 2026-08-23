// End-to-end smoke test: joins as the student AND as the admin and
// exercises the core loop — movement, same-room chat isolation, Terra's
// brain-backed replies, compose→preview→post to the Library board.
//
// Requires BOTH servers, and a FRESH space server (agents persist
// position across client connections):
//   virtual_ta:    npm run dev   (port 3000)
//   virtual_space: npm run dev   (port 2567)
//
// Usage: npx tsx scripts/smoke.ts   (makes ~2 real LLM calls)

import { Client, Room } from "colyseus.js";

type Entity = { id: string; name: string; kind: string; color: string; x: number; y: number };

const URL = process.env.VS_URL || "ws://localhost:2567";

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(cond: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) {
      console.log(`  ✓ ${label}`);
      return;
    }
    await wait(200);
  }
  throw new Error(`TIMEOUT waiting for: ${label}`);
}

function assert(v: unknown, label: string) {
  if (!v) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function main() {
  console.log(`Connecting to ${URL} …`);
  const client = new Client(URL);
  // ana@local, not the default jade@local: the latter is on the admin
  // allowlist and so has no avatar to test with.
  const student: Room = await client.joinOrCreate("main", { devUser: "ana@local" });

  let init: any = null;
  let world: { entities: Entity[] } = { entities: [] };
  const chats: any[] = [];
  const boards: any[] = [];

  student.onMessage("init", (m) => (init = m));
  student.onMessage("world", (m) => (world = m));
  // Movement arrives as a delta now (see MainRoom.broadcastMove); the full
  // roster only comes on joins, leaves and teleports.
  student.onMessage("moved", (m: { id: string; x: number; y: number }) => {
    const e = world.entities.find((x) => x.id === m.id);
    if (e) { e.x = m.x; e.y = m.y; }
  });
  student.onMessage("chat", (m) => {
    chats.push(m);
    console.log(`  [chat/${m.room}${m.skill ? ` · via ${m.skill}` : ""}] ${m.from}: ${m.text.slice(0, 120)}`);
  });
  student.onMessage("board", (m) => boards.push(m));
  student.onMessage("typing", (m) => console.log(`  (${m.name} is typing…)`));
  student.onMessage("adminAck", () => {});

  const me = () => world.entities.find((e) => e.id === init?.you);
  const terra = () => world.entities.find((e) => e.id === "agent-terra");
  const spawnOf = (id: string) => init.rooms.find((r: any) => r.id === id).spawn;
  const at = (e: Entity | undefined, p: { x: number; y: number }) => !!e && e.x === p.x && e.y === p.y;

  console.log("\n1. Join / world state — 1 human + 5 virtual students + Terra");
  await waitUntil(() => !!init, 5000, "init received");
  await waitUntil(() => world.entities.length === 7, 5000, "7 inhabitants present");
  assert(world.entities.filter((e) => e.kind === "agent").length === 6, "6 agents (5 students + Terra)");
  assert(at(me(), spawnOf("office-jade")), "I spawned in Jade's office");
  assert(at(terra(), spawnOf("office-ta")), "Terra is in the TA office");

  console.log("\n2. Movement");
  const bx = me()!.x;
  student.send("step", { dx: 1, dy: 0 });
  await waitUntil(() => me()!.x === bx + 1, 3000, "arrow-key step applied by server");
  student.send("step", { dx: 0, dy: -100 }); // invalid: must be ignored
  student.send("goto", { x: 0, y: 0 }); // wall: must be ignored
  await wait(400);
  assert(me()!.x === bx + 1, "invalid moves rejected by server");
  student.send("goto", spawnOf("commons"));
  await waitUntil(() => at(me(), spawnOf("commons")), 15000, "click-to-walk (BFS) reached the Common Area");

  console.log("\n3. Same-room isolation: chat with no agent nearby");
  const before = chats.length;
  student.send("chat", { text: "(talking to myself in the commons)" });
  await wait(4000);
  assert(!chats.slice(before).some((c) => c.from !== "Ana"), "no agent replied from another room");

  console.log("\n4. Admin role: no avatar, gated powers");
  student.send("admin", { action: "send", agent: "ta", dest: "commons" });
  await wait(600);
  assert(!at(terra(), spawnOf("commons")), "student's admin command was rejected");
  const admin: Room = await client.joinOrCreate("main", { devUser: "jade@local", role: "admin" });
  admin.onMessage("init", () => {});
  admin.onMessage("world", () => {});
  admin.onMessage("moved", () => {});
  admin.onMessage("board", () => {});
  admin.onMessage("chat", () => {});
  admin.onMessage("typing", () => {});
  const previews: any[] = [];
  admin.onMessage("postPreview", (m) => {
    previews.push(m);
    console.log(`  [preview → board ${m.suggested}] ${m.text.slice(0, 120)}`);
  });
  admin.onMessage("adminAck", (m) => console.log(`  [admin] ${m.ok ? "ok" : "ERR"}: ${m.note}`));
  await wait(500);
  assert(world.entities.length === 7, "admin joined without adding an avatar");
  admin.send("admin", { action: "send", agent: "ta", dest: "commons" });
  await waitUntil(() => at(terra(), spawnOf("commons")), 30000, "admin sent Terra to the Common Area");

  console.log("\n5. Proximity chat — Terra answers from the TA brain");
  const mark = chats.length;
  student.send("chat", { text: "Hi Terra! In one sentence, what should I focus on this week?" });
  await waitUntil(() => chats.slice(mark).some((c) => c.from === "Terra"), 120000, "Terra replied via the TA brain");

  console.log("\n6. Board post: compose → preview → pin to the Library");
  admin.send("admin", {
    action: "compose",
    instruction: "Post a reminder that office hours are tomorrow at 2pm.",
  });
  await waitUntil(() => previews.length > 0, 120000, "post composed and previewed to admin");
  admin.send("admin", { action: "post", board: "library", text: previews[0].text });
  await wait(800);
  const boardsBefore = boards.length;
  student.send("goto", spawnOf("library"));
  await waitUntil(
    () => boards.slice(boardsBefore).some((b) => b.roomId === "library" && b.items?.length > 0),
    20000,
    "student walked into the Library and saw the pinned post"
  );

  console.log("\nALL SMOKE TESTS PASSED ✅");
  await student.leave();
  await admin.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED ❌:", err.message || err);
  process.exit(1);
});
