// Regression check for the ghost-avatar fix: a second connection from the
// SAME person (as happens on a page reload) must REPLACE the first avatar,
// never duplicate it.
//
// Uses ana@local rather than the default dev identity on purpose: the
// default is jade@local, who is on the admin allowlist and therefore has
// no avatar at all (server/identity.ts). This suite is entirely about
// avatars, so it must run as an ordinary student.
//
// It deliberately does NOT assert a total entity count. That total was
// hardcoded to 12 and observed as 7, 9, 10 and 12: an ungraceful
// disconnect holds a seat for RECONNECT_WINDOW_S (120s), so a re-run
// inside that window legitimately starts with extra avatars. Those are
// seats inside their reconnection window, not ghosts — failing on them
// asserts something untrue. What IS invariant is asserted instead.
import { Client } from "colyseus.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = new Client("ws://localhost:2567");

  // First Ana joins and walks into the commons.
  const first = await client.joinOrCreate("main", { devUser: "ana@local" });
  let init1: any = null;
  first.onMessage("init", (m) => (init1 = m));
  first.onMessage("world", () => {});
  first.onMessage("board", () => {});
  first.onMessage("chat", () => {});
  first.onMessage("typing", () => {});
  await wait(500);
  const commons = init1.rooms.find((r: any) => r.id === "commons").spawn;
  first.send("goto", commons);
  await wait(4000); // walking

  // Second Ana joins WITHOUT the first leaving (reload race).
  const second = await client.joinOrCreate("main", { devUser: "ana@local" });
  let world: any = { entities: [] };
  second.onMessage("init", () => {});
  second.onMessage("world", (m) => (world = m));
  second.onMessage("board", () => {});
  second.onMessage("chat", () => {});
  second.onMessage("typing", () => {});
  await wait(800);

  const anas = world.entities.filter((e: any) => e.name === "Ana");
  const agents = world.entities.filter((e: any) => e.kind === "agent");
  const humans = world.entities.filter((e: any) => e.kind === "human");
  console.log(
    `entities: ${world.entities.length} (${agents.length} agents, ${humans.length} humans), ` +
      `Ana avatars: ${anas.length}, at (${anas[0]?.x},${anas[0]?.y})`
  );

  // The ghost assertion proper: the rejoin replaced the stale avatar.
  if (anas.length !== 1) throw new Error(`expected exactly 1 Ana, got ${anas.length}`);

  // The cast is fixed even though the human count is not.
  if (agents.length !== 6)
    throw new Error(`expected 6 agents (5 virtual students + TA), got ${agents.length}`);

  // Generalises the check above: nobody may appear twice, under any name.
  const names = humans.map((e: any) => e.name);
  const dupes = [...new Set(names)].filter((n) => names.filter((m) => m === n).length > 1);
  if (dupes.length) throw new Error(`duplicated human avatars: ${dupes.join(", ")}`);
  console.log("GHOST TEST PASSED ✅ — rejoin replaced the stale avatar");
  await second.leave();
  process.exit(0);
}

main().catch((e) => {
  console.error("GHOST TEST FAILED ❌:", e.message || e);
  process.exit(1);
});
