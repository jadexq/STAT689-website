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
// Where the TA writes conversation files. Defaults to the sibling project,
// which is right when both servers run from source; set TA_LOGS_DIR when the
// servers are in a container and you are reaching them over VS_URL.
const TA_LOGS =
  process.env.TA_LOGS_DIR?.trim() ||
  path.join(__dirname, "..", "..", "virtual_ta", "data", "logs");

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

// The TA DROPS a message sent while busy: MainRoom.scheduleReplies
// filters busy agents out of the reply set and agentRespond returns early.
// That is deliberate, but it means a caller must RETRY — and it is why this
// suite used to fail whenever it ran after smoke/integration, which leave
// TA mid-LLM-call. Waiting longer cannot help: nothing is in flight to
// wait for. So speak, wait a while, and speak again if nothing came back.
async function sayUntilAnswered(j: Joined, text: string, who: string, budgetMs = 180_000) {
  const mark = j.chats.length;
  const heard = () => j.chats.slice(mark).some((c) => c.from === "TA");
  const deadline = Date.now() + budgetMs;
  let attempts = 0;
  while (!heard() && Date.now() < deadline) {
    attempts++;
    j.room.send("chat", { text });
    const until = Date.now() + 25_000;
    while (!heard() && Date.now() < until) await wait(500);
  }
  if (!heard()) {
    throw new Error(
      `TIMEOUT: TA never answered ${who} across ${attempts} attempt(s) in ${budgetMs / 1000}s — ` +
        `the TA may be stuck busy rather than merely slow`
    );
  }
  console.log(`  ✓ TA answered ${who}${attempts > 1 ? ` (took ${attempts} attempts — the TA was busy)` : ""}`);
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
  notices: { text: string }[];
}

async function join(client: Client, devUser: string, role?: "admin"): Promise<Joined> {
  const j: Joined = { room: null as any, init: null, world: [], chats: [], acks: [], notices: [] };
  j.room = await client.joinOrCreate("main", { devUser, ...(role ? { role } : {}) });
  j.room.onMessage("init", (m: Init) => (j.init = m));
  j.room.onMessage("world", (m: { entities: Entity[] }) => (j.world = m.entities));
  j.room.onMessage("moved", (m: { id: string; x: number; y: number }) => {
    const e = j.world.find((x) => x.id === m.id);
    if (e) { e.x = m.x; e.y = m.y; }
  });
  j.room.onMessage("chat", (m) => j.chats.push(m));
  j.room.onMessage("adminAck", (m) => j.acks.push(m));
  j.room.onMessage("board", () => {});
  j.room.onMessage("typing", () => {});
  j.room.onMessage("notice", (m) => j.notices.push(m));
  j.room.onMessage("doors", () => {});
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
  assert(ana.world.filter((e) => e.kind === "agent").length === 6, "6 agents (5 virtual students + TA)");
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
  const taEnt = () => ana.world.find((e) => e.id === "agent-ta")!;
  impostor.room.send("admin", { action: "direct", agent: "ta", instruction: "Say anything." });
  await waitUntil(() => impostor.acks.length > 0, 3000, "the server answered the admin command");
  assert(impostor.acks[0].ok === false, "…by refusing it");
  assert(/not on the instructor list/i.test(impostor.acks[0].note), "…for the right reason: not an admin");
  const c = spawn("commons");

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
  // Sequentially, not together: TA handles one caller at a time
  // (AgentRuntime.busy), so a second message sent while the TA is thinking is
  // dropped by design — that is a queueing property, not an identity one.
  const files = ["space:ana@local", "space:omar@local"].map(logFileFor);
  for (const f of files) fs.rmSync(f, { force: true });
  const ta = ana.init!.rooms.find((r: any) => r.id === "office-ta");
  const inTaOffice = (j: Joined) => {
    const e = j.world.find((x) => x.id === j.init!.you);
    return !!e && e.x >= ta.x1 && e.x <= ta.x2 && e.y >= ta.y1 && e.y <= ta.y2;
  };

  // This suite used to have to WALK the TA home first: their position
  // persisted between suites, so a TA left in someone else's office by an
  // earlier run never answered here (open-issues A2). The TA cannot move
  // any more, so there is nothing left to place — the assertion replaces
  // ninety seconds of retrying.
  const taAtHome = () => {
    const t = ana.world.find((e) => e.id === "agent-ta");
    return !!t && t.x >= ta.x1 && t.x <= ta.x2 && t.y >= ta.y1 && t.y <= ta.y2;
  };
  assert(taAtHome(), "the TA is in the TA office, as they always are");

  ana.room.send("goto", spawn("office-ta"));
  await waitUntil(() => inTaOffice(ana), 30000, "Ana reached the TA office");
  await sayUntilAnswered(ana, "Hi TA, this is Ana.", "Ana");
  assert(fs.existsSync(files[0]), "Ana has a conversation file of their own");

  console.log("\n6. One student at a time — the door is shut behind Ana");
  const nMark = omar.notices.length;
  omar.room.send("goto", spawn("office-ta"));
  await waitUntil(() => omar.notices.length > nMark, 8000, "Omar was told the door is shut");
  assert(/occupied|shut/i.test(omar.notices[nMark].text), "…and told why, not silently ignored");
  assert(/Ana/.test(omar.notices[nMark].text), "…and by whom");
  await wait(1500);
  assert(!inTaOffice(omar), "Omar did not get in while Ana was inside");

  console.log("\n7. The door reopens when Ana leaves");
  ana.room.send("goto", spawn("commons"));
  await waitUntil(() => !inTaOffice(ana), 30000, "Ana walked out");
  omar.room.send("goto", spawn("office-ta"));
  await waitUntil(() => inTaOffice(omar), 30000, "Omar got in once the office was free");
  // No retry loop needed for busy-ness any more: with one visitor at a time
  // the TA cannot be mid-answer for somebody else when Omar speaks. The
  // helper stays because the TA can still be slow, not because messages drop.
  await sayUntilAnswered(omar, "Hi TA, this is Omar.", "Omar");
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
