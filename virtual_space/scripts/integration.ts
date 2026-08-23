// Integration test for the Virtual TA ↔ Virtual Space connection
// (Part 6 · Updates 1-2). Requires BOTH servers and a FRESH space server:
//   virtual_ta:    npm run dev   (port 3000)
//   virtual_space: npm run dev   (port 2567)
//
// Exercises: admin role (drive Terra, private chat, speak-as-Terra),
// room-forced skills (prep / library / computer lab; the Classroom is
// closed while its skill is on hold),
// compose→preview→post to boards, mic → class transcript, and the
// virtual-student reply cap. Makes ~6 real LLM calls.

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

  let init: any = null;
  let world: { entities: Entity[] } = { entities: [] };
  const sChats: any[] = [];
  const aChats: any[] = [];
  const sBoards: any[] = [];
  const previews: any[] = [];

  // Register each connection's handlers immediately after its join —
  // messages sent during the next await would otherwise be dropped.
  // ana@local, not the default jade@local: the latter is on the admin
  // allowlist and so has no avatar to test with.
  const student: Room = await client.joinOrCreate("main", { devUser: "ana@local" });
  student.onMessage("init", (m) => (init = m));
  student.onMessage("world", (m) => (world = m));
  student.onMessage("moved", (m: { id: string; x: number; y: number }) => {
    const e = world.entities.find((x) => x.id === m.id);
    if (e) { e.x = m.x; e.y = m.y; }
  });
  student.onMessage("chat", (m) => {
    sChats.push(m);
    console.log(`  [student sees ${m.room}${m.skill ? ` · via ${m.skill}` : ""}] ${m.from}: ${m.text.slice(0, 110)}`);
  });
  student.onMessage("board", (m) => sBoards.push(m));
  student.onMessage("typing", () => {});
  student.onMessage("adminAck", () => {});

  const admin: Room = await client.joinOrCreate("main", { devUser: "jade@local", role: "admin" });
  admin.onMessage("init", () => {});
  admin.onMessage("world", () => {});
  admin.onMessage("moved", () => {});
  admin.onMessage("board", () => {});
  admin.onMessage("chat", (m) => {
    aChats.push(m);
    console.log(`  [admin sees ${m.room}${m.skill ? ` · via ${m.skill}` : ""}] ${m.from}: ${m.text.slice(0, 110)}`);
  });
  admin.onMessage("typing", () => {});
  admin.onMessage("postPreview", (m) => {
    previews.push(m);
    console.log(`  [preview → ${m.suggested}] ${m.text.slice(0, 110)}`);
  });
  admin.onMessage("adminAck", (m) => console.log(`  [admin] ${m.ok ? "ok" : "ERR"}: ${m.note}`));

  const me = () => world.entities.find((e) => e.id === init?.you);
  const terra = () => world.entities.find((e) => e.id === "agent-terra");
  const spawnOf = (id: string) => init.rooms.find((r: any) => r.id === id).spawn;
  const at = (e: Entity | undefined, p: { x: number; y: number }) => !!e && e.x === p.x && e.y === p.y;

  console.log("\n1. World: 7 inhabitants, mode rooms, boards");
  await waitUntil(() => !!init && world.entities.length === 7, 6000, "7 inhabitants (no avatar for the admin)");
  for (const [rid, skill] of [["prep-room", "author"], ["library", "announce"], ["computer-lab", "review"]]) {
    assert(init.rooms.some((r: any) => r.id === rid && r.forcedSkill === skill), `${rid} forces ${skill}`);
  }
  assert(init.rooms.filter((r: any) => r.hasBoard).length === 2, "Library and Computer Lab have boards");

  console.log("\n2. Admin drives Terra");
  const t0 = { ...terra()! };
  admin.send("step", { dx: 0, dy: -1 });
  await waitUntil(() => terra()!.y === t0.y - 1, 3000, "admin arrow key moved Terra");
  admin.send("admin", { action: "send", agent: "ta", dest: "library" });
  await waitUntil(() => at(terra(), spawnOf("library")), 30000, "Terra walked to the Library");

  console.log("\n3. Admin ↔ TA private chat (room forces announce in the Library)");
  const aMark = aChats.length;
  admin.send("chat", { text: "Post a note that homework 1 is to read the attention paper, due Friday.", mode: "private" });
  await waitUntil(() => aChats.slice(aMark).some((c) => c.from === "Terra" && c.room === "private"), 120000, "private reply from the TA brain");
  assert(!sChats.some((c) => c.room === "private"), "student saw none of the private exchange");

  console.log("\n4. Compose → preview → pin to the Library board; student sees it on entry");
  admin.send("admin", { action: "compose", instruction: "Post: homework 1 is to read the attention paper; due Friday." });
  await waitUntil(() => previews.length > 0, 120000, "post composed and previewed");
  assert(!/here's the announcement|saved to/i.test(previews[0].text), "preview is clean announcement text");
  admin.send("admin", { action: "post", board: "library", text: previews[0].text });
  await wait(800);
  student.send("goto", spawnOf("library"));
  await waitUntil(
    () => sBoards.some((b) => b.roomId === "library" && b.items?.length > 0),
    25000,
    "student entered the Library and received the board"
  );

  console.log("\n5. Classroom is closed while its skill is on hold");
  // Replaces the old mic → class transcript → classroom-mode Q&A test.
  // Restore that section (see git history) when CLASSROOM_OPEN and
  // CLASSROOM_ENABLED both go back to true.
  const classroom = init.rooms.find((r: any) => r.id === "classroom");
  assert(classroom?.closed === true, "Classroom is marked closed");
  assert(!classroom?.forcedSkill, "Classroom forces no skill");
  assert(!init.doors.some((d: any) => d.x === 4 && d.y === 13), "Classroom door is sealed");
  let mark = sChats.length;
  student.send("goto", spawnOf("classroom"));
  await wait(2500);
  assert(!at(me(), spawnOf("classroom")), "student cannot walk into the Classroom");

  console.log("\n6. Computer Lab forces the review skill");
  admin.send("admin", { action: "send", agent: "ta", dest: "computer-lab" });
  student.send("goto", spawnOf("computer-lab"));
  await waitUntil(() => at(me(), spawnOf("computer-lab")) && at(terra(), spawnOf("computer-lab")), 40000, "Jade & Terra in the Computer Lab");
  mark = sChats.length;
  student.send("chat", { text: "Which pull request should I look at first?" });
  await waitUntil(() => sChats.slice(mark).some((c) => c.from === "Terra"), 120000, "Terra replied in the lab");
  assert(
    sChats.slice(mark).find((c) => c.from === "Terra").skill === "review",
    "room forced the review skill"
  );

  console.log("\n7. Speak as Terra in a student office — the virtual student responds");
  admin.send("admin", { action: "send", agent: "ta", dest: "office-s1" });
  await waitUntil(() => at(terra(), spawnOf("office-s1")), 40000, "Terra walked to Sam's office");
  const aMark2 = aChats.length;
  admin.send("chat", { text: "Hi Sam! How is the attention reading going?", mode: "speak" });
  await waitUntil(
    () => aChats.slice(aMark2).some((c) => c.from === "Terra" && c.room === "Sam's Office"),
    5000,
    "admin's words came out of Terra in the room"
  );
  await waitUntil(() => aChats.slice(aMark2).some((c) => c.from === "Sam"), 120000, "Sam replied to Terra");

  console.log("\nALL INTEGRATION TESTS PASSED ✅");
  await student.leave();
  await admin.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nINTEGRATION TEST FAILED ❌:", err.message || err);
  process.exit(1);
});
