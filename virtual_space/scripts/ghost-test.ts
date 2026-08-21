// Regression check for the ghost-avatar fix: a second "Jade" connection
// (as happens on a page reload / role switch) must REPLACE the first
// avatar, never duplicate it.
import { Client } from "colyseus.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const client = new Client("ws://localhost:2567");

  // First Jade joins and walks into the commons.
  const first = await client.joinOrCreate("main", { name: "Jade" });
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

  // Second Jade joins WITHOUT the first leaving (reload race).
  const second = await client.joinOrCreate("main", { name: "Jade" });
  let world: any = { entities: [] };
  second.onMessage("init", () => {});
  second.onMessage("world", (m) => (world = m));
  second.onMessage("board", () => {});
  second.onMessage("chat", () => {});
  second.onMessage("typing", () => {});
  await wait(800);

  const jades = world.entities.filter((e: any) => e.name === "Jade");
  console.log(`entities: ${world.entities.length}, Jade avatars: ${jades.length}, at (${jades[0]?.x},${jades[0]?.y})`);
  if (jades.length !== 1) throw new Error(`expected exactly 1 Jade, got ${jades.length}`);
  if (world.entities.length !== 12) throw new Error(`expected 12 entities, got ${world.entities.length}`);
  console.log("GHOST TEST PASSED ✅ — rejoin replaced the stale avatar");
  await second.leave();
  process.exit(0);
}

main().catch((e) => {
  console.error("GHOST TEST FAILED ❌:", e.message || e);
  process.exit(1);
});
