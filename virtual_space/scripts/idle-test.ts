// The idle sweep that frees the TA office (MainRoom.sweepSoloRooms).
//
// Not part of the default suite: the real windows are 4 and 5 MINUTES, and
// a test that sleeps five minutes gets skipped, which is worse than not
// having it. So the windows are env-tunable and this script asks for short
// ones. Start the space server with:
//
//   SOLO_WARN_S=4 SOLO_IDLE_S=8 npm run dev      (virtual_space, port 2567)
//
// then: npx tsx scripts/idle-test.ts   (makes one real LLM call)

import { Client, Room } from "colyseus.js";

type Entity = { id: string; name: string; kind: string; x: number; y: number };
type Init = { you: string | null; rooms: any[] };

const URL = process.env.VS_URL || "ws://localhost:2567";
const BUDGET_MS = 60_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return console.log(`  ✓ ${label}`);
    await wait(200);
  }
  throw new Error(`TIMEOUT waiting for: ${label}`);
}

function assert(v: unknown, label: string) {
  if (!v) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

interface Joined {
  room: Room;
  init: Init | null;
  world: Entity[];
  notices: { text: string }[];
}

async function join(client: Client, devUser: string): Promise<Joined> {
  const j: Joined = { room: null as any, init: null, world: [], notices: [] };
  j.room = await client.joinOrCreate("main", { devUser });
  j.room.onMessage("init", (m: Init) => (j.init = m));
  j.room.onMessage("world", (m: { entities: Entity[] }) => (j.world = m.entities));
  j.room.onMessage("moved", (m: { id: string; x: number; y: number }) => {
    const e = j.world.find((x) => x.id === m.id);
    if (e) { e.x = m.x; e.y = m.y; }
  });
  j.room.onMessage("notice", (m) => {
    j.notices.push(m);
    console.log(`  [notice → ${devUser}] ${m.text}`);
  });
  for (const t of ["chat", "board", "typing", "adminAck", "doors"]) j.room.onMessage(t, () => {});
  await waitUntil(() => !!j.init, 5000, `joined as ${devUser}`);
  return j;
}

async function main() {
  console.log(`Connecting to ${URL} …`);
  const client = new Client(URL);
  const ana = await join(client, "ana@local");
  const omar = await join(client, "omar@local");

  const ta = ana.init!.rooms.find((r: any) => r.id === "office-ta");
  const spawn = (id: string) => ana.init!.rooms.find((r: any) => r.id === id).spawn;
  const inside = (j: Joined) => {
    const e = j.world.find((x) => x.id === j.init!.you);
    return !!e && e.x >= ta.x1 && e.x <= ta.x2 && e.y >= ta.y1 && e.y <= ta.y2;
  };

  console.log("\n1. Ana takes the TA office and then says nothing");
  ana.room.send("goto", spawn("office-ta"));
  await waitUntil(() => inside(ana), 30000, "Ana is in the TA office");

  console.log("\n2. She is warned before she is moved");
  const warnMark = ana.notices.length;
  try {
    await waitUntil(() => ana.notices.slice(warnMark).some((n) => /Still there/i.test(n.text)), BUDGET_MS,
      "Ana got the warning first");
  } catch {
    throw new Error(
      `No warning in ${BUDGET_MS / 1000}s. The server is probably running with the real 4-minute window — ` +
        `restart it with SOLO_WARN_S=4 SOLO_IDLE_S=8 (see the header of this file).`
    );
  }
  assert(inside(ana), "…and is still in the office at that point — a warning, not a warning shot");

  console.log("\n3. Then she is walked home and the door reopens");
  await waitUntil(() => ana.notices.some((n) => /being freed/i.test(n.text)), BUDGET_MS, "Ana was told the office is being freed");
  await waitUntil(() => !inside(ana), 30000, "Ana left the TA office without touching anything");
  omar.room.send("goto", spawn("office-ta"));
  await waitUntil(() => inside(omar), 30000, "Omar can now get in");

  console.log("\n4. Talking resets the clock");
  // One message, then wait out most of a fresh idle window. If speaking did
  // not reset the timer, Omar would already have been evicted by now — he
  // has been in the room longer than the window at this point.
  const before = omar.notices.length;
  const idleMs = Number(process.env.SOLO_IDLE_S || 8) * 1000;
  omar.room.send("chat", { text: "(still here)" });
  await wait(idleMs * 0.8);
  assert(!omar.notices.slice(before).some((n) => /being freed/i.test(n.text)), "Omar was not evicted after speaking");
  assert(inside(omar), "…and is still in the office");

  console.log("\nIDLE TEST PASSED ✅");
  await ana.room.leave();
  await omar.room.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nIDLE TEST FAILED ❌:", err.message || err);
  process.exit(1);
});
