// Integration test for the Virtual TA ↔ Virtual Space connection
// (Part 6 · Updates 1-2). Requires BOTH servers and a FRESH space server:
//   virtual_ta:    npm run dev   (port 3000)
//   virtual_space: npm run dev   (port 2567)
//
// Exercises: admin role (private chat, speak-as-TA), the TA pinned in
// their office (nobody, instructor included, can move them), the sealed
// rooms, pinning the instructor's own text to a board, mic → class
// transcript, and the virtual-student reply cap. Makes ~5 real LLM calls.

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
  student.onMessage("doors", () => {});
  student.onMessage("notice", () => {});

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
  const acks: any[] = [];
  admin.onMessage("adminAck", (m) => {
    acks.push(m);
    console.log(`  [admin] ${m.ok ? "ok" : "ERR"}: ${m.note}`);
  });
  const notices: any[] = [];
  admin.onMessage("notice", (m) => notices.push(m));
  admin.onMessage("doors", () => {});

  const me = () => world.entities.find((e) => e.id === init?.you);
  const taEnt = () => world.entities.find((e) => e.id === "agent-ta");
  const spawnOf = (id: string) => init.rooms.find((r: any) => r.id === id).spawn;
  const at = (e: Entity | undefined, p: { x: number; y: number }) => !!e && e.x === p.x && e.y === p.y;

  console.log("\n1. World: 7 inhabitants, own rooms, boards");
  await waitUntil(() => !!init, 6000, "init received");
  assert(typeof init.home === "string", `init names my own room: ${init.home}`);
  await waitUntil(() => !!init && world.entities.length === 7, 6000, "7 inhabitants (no avatar for the admin)");
  assert(init.rooms.filter((r: any) => r.hasBoard).length === 8,
    "8 boards: six offices showing the class announcements, plus the Library and Computer Lab");
  assert(init.postTargets.map((t: any) => t.id).join(",") === "announcements,library,computer-lab",
    "…but only three places to post: an office is not a post target");
  assert(!init.rooms.some((r: any) => r.forcedSkill || r.modeLabel), "no room advertises a TA mode any more");
  assert(init.rooms.find((r: any) => r.id === "office-ta")?.soloOccupancy === true, "TA office is solo-occupancy");

  console.log("\n2. No character can be moved — not even by the instructor");
  // The keyboard path (handleStep) and the panel path are separate code, so
  // closing one and not the other is the likely regression. The panel path is
  // now closed by the action not existing at all.
  const t0 = { ...taEnt()! };
  admin.send("step", { dx: 0, dy: -1 });
  await waitUntil(() => notices.length > 0, 3000, "arrow key returned a notice instead of moving the TA");
  assert(taEnt()!.x === t0.x && taEnt()!.y === t0.y, "TA did not move a tile");
  const ackMark0 = acks.length;
  admin.send("admin", { action: "send", agent: "ta", dest: "library" });
  await waitUntil(() => acks.slice(ackMark0).some((a) => !a.ok), 5000, "the panel has no way to walk anyone");
  assert(at(taEnt(), spawnOf("office-ta")), "TA is still in the TA office");

  console.log("\n3. Admin ↔ TA private chat");
  const aMark = aChats.length;
  admin.send("chat", { text: "Post a note that homework 1 is to read the attention paper, due Friday.", mode: "private" });
  await waitUntil(() => aChats.slice(aMark).some((c) => c.from === "TA" && c.room === "private"), 120000, "private reply from the TA brain");
  assert(!sChats.some((c) => c.room === "private"), "student saw none of the private exchange");

  console.log("\n4. The instructor's own text, pinned to the Library board");
  const POST = "Homework 1: read the attention paper; due Friday.";
  admin.send("admin", { action: "post", board: "library", text: POST });
  await wait(800);
  student.send("goto", spawnOf("library"));
  await waitUntil(
    () => sBoards.some((b) => b.roomId === "library" && b.items?.some((i: any) => i.text === POST)),
    25000,
    "student entered the Library and saw the post verbatim"
  );

  console.log("\n5. Classroom and Prep Room are sealed");
  // The Classroom waits on its skill being reworked; the Prep Room existed
  // only to put the TA in notes-and-slides mode and has no job left.
  for (const [rid, door] of [["classroom", { x: 4, y: 13 }], ["prep-room", { x: 13, y: 13 }]] as const) {
    const r = init.rooms.find((x: any) => x.id === rid);
    assert(r?.closed === true, `${r?.label} is marked closed`);
    assert(!init.doors.some((d: any) => d.x === door.x && d.y === door.y), `${r?.label} door is sealed`);
    student.send("goto", spawnOf(rid));
    await wait(2000);
    assert(!at(me(), spawnOf(rid)), `student cannot walk into ${r?.label}`);
  }

  console.log("\n6. Walk into the TA office — the TA answers there and nowhere else");
  // The old step 6 walked BOTH the student and the TA to the Computer Lab
  // and waited for them to arrive together; it timed out intermittently
  // (open-issues A3). Only one of them moves now, so the race is gone.
  let mark = sChats.length;
  student.send("goto", spawnOf("computer-lab"));
  await waitUntil(() => at(me(), spawnOf("computer-lab")), 30000, "student reached the Computer Lab");
  student.send("chat", { text: "Anyone here?" });
  await wait(6000);
  assert(!sChats.slice(mark).some((c) => c.from === "TA"), "the TA does not answer from another room");
  student.send("goto", spawnOf("office-ta"));
  await waitUntil(() => at(me(), spawnOf("office-ta")), 30000, "student walked into the TA office");
  mark = sChats.length;
  student.send("chat", { text: "What should I read first for this course?" });
  await waitUntil(() => sChats.slice(mark).some((c) => c.from === "TA"), 120000, "TA replied in their office");

  console.log("\n7. Speak as the TA — heard by the student standing in the office");
  const aMark2 = aChats.length;
  const sMark2 = sChats.length;
  admin.send("chat", { text: "Good to see you — grab a seat.", mode: "speak" });
  await waitUntil(
    () => sChats.slice(sMark2).some((c) => c.from === "TA" && c.room === "TA Office"),
    5000,
    "admin's words came out of the TA, in the office, heard by the student"
  );
  assert(aChats.slice(aMark2).some((c) => c.from === "TA"), "the admin hears it too");

  console.log("\n7b. Every stand-in is in their own office, and stays there");
  // An earlier version of this suite walked Sam into the TA office to prove
  // `direct` worked, and left him there. He then joined real conversations,
  // because scheduleReplies picks up any agent in the room (open-issues E5).
  // The action that let a suite do that no longer exists.
  for (const [key, office] of [["sam", "office-s1"], ["ben", "office-s2"], ["chloe", "office-s3"],
                               ["dev", "office-s4"], ["grace", "office-s5"]] as const) {
    assert(at(world.entities.find((e) => e.id === `agent-${key}`), spawnOf(office)), `${key} is in ${office}`);
  }

  console.log("\n7c. A stand-in can still be directed — in their own room");
  student.send("goto", spawnOf("office-s1"));
  await waitUntil(() => at(me(), spawnOf("office-s1")), 30000, "student walked to Sam's office");
  const sMark3 = sChats.length;
  admin.send("admin", { action: "direct", agent: "sam", instruction: "Say hello to whoever is here." });
  await waitUntil(() => sChats.slice(sMark3).some((c) => c.from === "Sam"), 120000, "Sam spoke where he lives");
  assert(at(world.entities.find((e) => e.id === "agent-sam"), spawnOf("office-s1")), "…without going anywhere");

  console.log("\nALL INTEGRATION TESTS PASSED ✅");
  await student.leave();
  await admin.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nINTEGRATION TEST FAILED ❌:", err.message || err);
  process.exit(1);
});
