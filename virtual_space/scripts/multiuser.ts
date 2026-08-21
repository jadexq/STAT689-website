// Multi-user + identity test (Phase A1).
//
// Until now every browser said `{ name: "Jade" }` and every visitor was
// therefore the same person — a second student EVICTED the first one's
// avatar and shared their TA conversation. Identity is now established
// server-side, so this test exists to prove the three properties that
// change depends on:
//
//   1. two different people coexist, each with their own avatar & name
//   2. the admin role is GRANTED, not claimed — a student asking for it
//      gets an ordinary avatar and their admin commands are refused
//   3. each student gets their own conversation with the TA brain
//
// Requires BOTH servers and a FRESH space server:
//   virtual_ta:    npm run dev   (port 3000)
//   virtual_space: npm run dev   (port 2567)
//
// Usage: npx tsx scripts/multiuser.ts   (makes 2 real LLM calls)

import { Client, Room } from "colyseus.js";
import fs from "node:fs";
import path from "node:path";

type Entity = { id: string; name: string; kind: string; x: number; y: number };
type Init = { you: string | null; role: string; isAdmin: boolean; email: string; name: string; rooms: any[] };

const URL = process.env.VS_URL || "ws://localhost:2567";
// Where the TA brain keeps one file per conversation (see virtual_ta/server/logger.ts).
const TA_LOGS = path.join(__dirname, "..", "..", "virtual_ta", "data", "logs");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(v: unknown, label: string) {
  if (!v) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function waitUntil(cond: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return console.log(`  ✓ ${label}`);
    await wait(200);
  }
  throw new Error(`TIMEOUT waiting for: ${label}`);
}

// The TA brain's filename transform for a session id.
const logFileFor = (sessionId: string) =>
  path.join(TA_LOGS, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)}.jsonl`);

interface Joined {
  room: Room;
  init: Init | null;
  world: Entity[];
  chats: any[];
  acks: { ok: boolean; note: string }[];
}

async function join(client: Client, devUser: string, role?: "admin"): Promise<Joined> {
  const j: Joined = { room: null as any, init: null, world: [], chats: [], acks: [] };
  j.room = await client.joinOrCreate("main", { devUser, ...(role ? { role } : {}) });
  j.room.onMessage("init", (m: Init) => (j.init = m));
  j.room.onMessage("world", (m: { entities: Entity[] }) => (j.world = m.entities));
  j.room.onMessage("chat", (m) => j.chats.push(m));
  j.room.onMessage("adminAck", (m) => j.acks.push(m));
  j.room.onMessage("board", () => {});
  j.room.onMessage("typing", () => {});
  j.room.onMessage("postPreview", () => {});
  await waitUntil(() => !!j.init, 5000, `joined as ${devUser}${role ? ` (requesting ${role})` : ""}`);
  return j;
}

async function main() {
  console.log(`Connecting to ${URL} …`);
  const client = new Client(URL);

  console.log("\n1. Two different people, two avatars");
  const ana = await join(client, "ana@local");
  const omar = await join(client, "omar@local");
  const nameOf = (j: Joined) => j.world.find((e) => e.id === j.init!.you)?.name;

  // Counts are relative, not absolute: a seat is held for a couple of
  // minutes after an ungraceful disconnect (allowReconnection), so a
  // re-run inside that window legitimately starts with extra avatars.
  await waitUntil(
    () => ["Ana", "Omar"].every((n) => ana.world.some((e) => e.kind === "human" && e.name === n)),
    5000,
    "both humans are in the world"
  );
  assert(ana.world.filter((e) => e.kind === "agent").length === 6, "6 agents (5 virtual students + Terra)");
  const afterTwo = ana.world.length;
  assert(ana.init!.email === "ana@local", "Ana's identity came from the server, not the client");
  assert(nameOf(ana) === "Ana" && nameOf(omar) === "Omar", "each has their own display name");
  assert(ana.init!.you !== omar.init!.you, "each has their own avatar");
  // The old behaviour: Omar joining would have deleted Ana's entity.
  assert(!!ana.world.find((e) => e.id === ana.init!.you), "Ana survived Omar joining");

  console.log("\n2. The admin role is granted, not claimed");
  const impostor = await join(client, "mallory@local", "admin");
  assert(impostor.init!.role === "student", "a student asking for admin is still a student");
  assert(impostor.init!.isAdmin === false, "…and is not offered the role switch");
  assert(impostor.init!.you !== null, "…and gets an ordinary avatar");
  const spawn = (id: string) => ana.init!.rooms.find((r: any) => r.id === id).spawn;
  const terraAt = () => ana.world.find((e) => e.id === "agent-terra")!;
  impostor.room.send("admin", { action: "send", agent: "ta", dest: "commons" });
  await waitUntil(() => impostor.acks.length > 0, 3000, "the server answered the admin command");
  assert(impostor.acks[0].ok === false, "…by refusing it");
  await wait(500);
  const c = spawn("commons");
  assert(!(terraAt().x === c.x && terraAt().y === c.y), "Terra did not move");

  console.log("\n3. The instructor does get it");
  const jade = await join(client, "jade@local", "admin");
  assert(jade.init!.role === "admin", "the allowlisted instructor is admin");
  assert(jade.init!.you === null, "…with no avatar of their own");
  await waitUntil(
    () => ana.world.length === afterTwo + 1,
    5000,
    "exactly one avatar was added by the two extra joins — the impostor's, not the admin's"
  );

  console.log("\n4. Chat still reaches only the same room");
  ana.room.send("goto", spawn("commons"));
  await waitUntil(
    () => { const e = ana.world.find((x) => x.id === ana.init!.you)!; return e.x === c.x && e.y === c.y; },
    20000,
    "Ana walked to the Common Area"
  );
  const mark = ana.chats.length;
  omar.room.send("chat", { text: "(Omar, alone in the office)" });
  await wait(1500);
  assert(ana.chats.length === mark, "Ana did not hear Omar from another room");

  console.log("\n5. Separate conversations with the TA brain");
  // Each student's turns must land in their OWN file. Previously both were
  // "space:Jade" and their histories were interleaved into one conversation.
  //
  // Sequentially, not together: Terra handles one caller at a time
  // (AgentRuntime.busy), so a second message sent while she is thinking is
  // dropped by design — that is a queueing property, not an identity one.
  const files = ["space:ana@local", "space:omar@local"].map(logFileFor);
  for (const f of files) fs.rmSync(f, { force: true });
  const ta = ana.init!.rooms.find((r: any) => r.id === "office-ta");
  const inTaOffice = (j: Joined) => {
    const e = j.world.find((x) => x.id === j.init!.you);
    return !!e && e.x >= ta.x1 && e.x <= ta.x2 && e.y >= ta.y1 && e.y <= ta.y2;
  };

  ana.room.send("goto", spawn("office-ta"));
  await waitUntil(() => inTaOffice(ana), 30000, "Ana reached the TA office");
  const benMark = ana.chats.length;
  ana.room.send("chat", { text: "Hi Terra, this is Ana." });
  await waitUntil(
    () => ana.chats.slice(benMark).some((c) => c.from === "Terra"),
    180000,
    "Terra answered Ana (and is free again)"
  );
  assert(fs.existsSync(files[0]), "Ana has a conversation file of their own");

  omar.room.send("goto", spawn("office-ta"));
  await waitUntil(() => inTaOffice(omar), 30000, "Omar reached the TA office");
  omar.room.send("chat", { text: "Hi Terra, this is Omar." });
  await waitUntil(() => fs.existsSync(files[1]), 60000, "Omar has a conversation file of their own");

  const anaLog = fs.readFileSync(files[0], "utf8");
  const omarLog = fs.readFileSync(files[1], "utf8");
  assert(anaLog.includes("this is Ana.") && !anaLog.includes("this is Omar."), "Ana's file holds only Ana's turns");
  assert(omarLog.includes("this is Omar.") && !omarLog.includes("this is Ana."), "Omar's file holds only Omar's turns");

  console.log("\nALL MULTI-USER TESTS PASSED ✅");
  for (const j of [ana, omar, impostor, jade]) await j.room.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nMULTI-USER TEST FAILED ❌:", err.message || err);
  process.exit(1);
});
