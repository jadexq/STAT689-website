// Regression check for the ghost-avatar fix: a second connection from the
// SAME person (as happens on a page reload) must REPLACE the first avatar,
// never duplicate it.
//
// Uses ana@local rather than the default dev identity on purpose: the
// default is jade@local, who is on the admin allowlist and therefore has
// no avatar at all (server/identity.ts). This suite is entirely about
// avatars, so it must run as an ordinary student.
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
  console.log(`entities: ${world.entities.length}, Ana avatars: ${anas.length}, at (${anas[0]?.x},${anas[0]?.y})`);
  if (anas.length !== 1) throw new Error(`expected exactly 1 Ana, got ${anas.length}`);
  if (world.entities.length !== 12) throw new Error(`expected 12 entities, got ${world.entities.length}`);
  console.log("GHOST TEST PASSED ✅ — rejoin replaced the stale avatar");
  await second.leave();
  process.exit(0);
}

main().catch((e) => {
  console.error("GHOST TEST FAILED ❌:", e.message || e);
  process.exit(1);
});
