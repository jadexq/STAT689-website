// The idle sweep that frees the TA office (MainRoom.sweepSoloRooms).
//
// Two rules, both time-based:
//   - the TA office is freed when its occupant goes quiet (SOLO_*)
//   - anyone idle anywhere else is walked back to their own room (HOME_*)
//
// Not part of the default suite: the real windows are minutes, and a test
// that sleeps for minutes gets skipped, which is worse than not having it.
// The windows are env-tunable, and they must be set ON THE SERVER:
//
//   SOLO_WARN_S=4 SOLO_IDLE_S=8 HOME_IDLE_S=10 npm run dev   (port 2567)
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
  // WHERE she lands, not just that she left — open-issues.md E8. This path
  // walked every evicted occupant to one hardcoded office, which looks
  // correct for exactly as long as one account holds that slot.
  {
    const h = spawn(ana.init!.home!);
    const meA = () => ana.world.find((x) => x.id === ana.init!.you)!;
    await waitUntil(() => meA().x === h.x && meA().y === h.y, 40000,
      `…and was walked to HER OWN room (${ana.init!.home}), not somebody else's office`);
  }
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

  console.log("\n5. Idle anywhere else, and you are walked back to your own room");
  // A rostered student, so "home" is an office rather than the hall — the
  // hall is where an unassigned address lands, and you cannot be returned to
  // somewhere you already are.
  // Whoever .env actually assigns a slot to. Hardcoding one address meant
  // this block silently skipped every time the roster changed.
  const who = (process.env.IDLE_TEST_STUDENT || "jadewang@tamu.edu").toLowerCase();
  const student = await join(client, who);
  if (student.init!.home === "commons") {
    console.log(`  ! ${who} has no slot — set STUDENTS in .env, or IDLE_TEST_STUDENT. Skipping.`);
  } else {
    const homeSpawn = spawn(student.init!.home!);
    const meJ = () => student.world.find((x) => x.id === student.init!.you)!;
    const atHome = () => meJ().x === homeSpawn.x && meJ().y === homeSpawn.y;
    assert(atHome(), `${who} started in their own room (${student.init!.home})`);
    student.room.send("goto", spawn("library"));
    await waitUntil(() => { const l = spawn("library"); return meJ().x === l.x && meJ().y === l.y; }, 30000,
      `${who} walked to the Library`);
    const nMark = student.notices.length;
    await waitUntil(() => student.notices.slice(nMark).some((n) => /heading back/i.test(n.text)), BUDGET_MS,
      `${who} was told they are being sent home`);
    await waitUntil(atHome, 40000, "…and walked back to their own room without touching anything");
  }
  // 6 is the one that actually pins E8 down. Step 3 evicts Ana, who has no
  // slot, so "her own room" is the commons — that catches a hardcoded office
  // but cannot tell "their own office" from "the commons for everybody". The
  // call site E8 fixed is this one, and only a rostered occupant exercises it.
  console.log("\n6. A ROSTERED student evicted from the TA office lands in their OWN office");
  if (student.init!.home === "commons") {
    console.log(`  ! ${who} has no slot — this is the assertion that needs one. Skipping.`);
  } else {
    const home = spawn(student.init!.home!);
    const meJ = () => student.world.find((x) => x.id === student.init!.you)!;
    student.room.send("goto", spawn("office-ta"));
    await waitUntil(() => inside(student), 30000, `${who} is in the TA office`);
    const mark = student.notices.length;
    await waitUntil(() => student.notices.slice(mark).some((n) => /being freed/i.test(n.text)), BUDGET_MS,
      `${who} was told the office is being freed`);
    await waitUntil(() => !inside(student), 30000, `${who} left the TA office`);
    await waitUntil(() => meJ().x === home.x && meJ().y === home.y, 40000,
      `…and landed in THEIR OWN office (${student.init!.home}), not the commons and not somebody else's`);
  }

  await student.room.leave();

  console.log("\nIDLE TEST PASSED ✅");
  await ana.room.leave();
  await omar.room.leave();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nIDLE TEST FAILED ❌:", err.message || err);
  process.exit(1);
});
