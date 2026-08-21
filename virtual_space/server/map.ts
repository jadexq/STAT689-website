// The campus map, generated programmatically from room definitions
// (hand-authoring 34 rows of walls got error-prone at this size).
//
// Layout (43 x 34 tiles):
//   rows  1-6   six student offices (S1-S6)
//   rows  8-12  commons — north hall
//   rows 14-19  four student offices (S7-S10) + Jade's office,
//               with side passages at both edges
//   rows 21-25  commons — south hall
//   rows 27-32  Classroom | Prep Room | Library | Computer Lab | TA Office
//
// The bottom rooms are MODE SELECTORS for the TA's brain (forcedSkill),
// and Library / Computer Lab have bulletin BOARDS the TA can pin posts to.

export const TILE = 32;

export interface RoomDef {
  id: string;
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  spawn: { x: number; y: number };
  tint: string; // floor color hint for the client
  kind: "office" | "special" | "commons";
  // When the TA agent stands in this room, chat with her is handled by
  // this skill in the TA brain (bypasses the intent router).
  forcedSkill?: string;
  modeLabel?: string; // shown on the TA's avatar while she is in the room
  hasBoard?: boolean; // room has a bulletin board the TA can pin posts to
}

const OFFICE_TINT_A = "#2e3a54";
const OFFICE_TINT_B = "#33405c";

export const ROOMS: RoomDef[] = [
  // --- band 1: student offices S1-S6 (rows 1-6) ---
  { id: "office-s1",  label: "Sam's Office",   x1: 1,  y1: 1, x2: 6,  y2: 6, spawn: { x: 3,  y: 3 }, tint: OFFICE_TINT_A, kind: "office" },
  { id: "office-s2",  label: "Ava's Office",   x1: 8,  y1: 1, x2: 13, y2: 6, spawn: { x: 10, y: 3 }, tint: OFFICE_TINT_B, kind: "office" },
  { id: "office-s3",  label: "Ben's Office",   x1: 15, y1: 1, x2: 20, y2: 6, spawn: { x: 17, y: 3 }, tint: OFFICE_TINT_A, kind: "office" },
  { id: "office-s4",  label: "Chloe's Office", x1: 22, y1: 1, x2: 27, y2: 6, spawn: { x: 24, y: 3 }, tint: OFFICE_TINT_B, kind: "office" },
  { id: "office-s5",  label: "Dev's Office",   x1: 29, y1: 1, x2: 34, y2: 6, spawn: { x: 31, y: 3 }, tint: OFFICE_TINT_A, kind: "office" },
  { id: "office-s6",  label: "Emma's Office",  x1: 36, y1: 1, x2: 41, y2: 6, spawn: { x: 38, y: 3 }, tint: OFFICE_TINT_B, kind: "office" },
  // --- band 2: student offices S7-S10 + Jade (rows 14-19) ---
  { id: "office-s7",  label: "Felix's Office", x1: 4,  y1: 14, x2: 9,  y2: 19, spawn: { x: 6,  y: 16 }, tint: OFFICE_TINT_B, kind: "office" },
  { id: "office-s8",  label: "Grace's Office", x1: 11, y1: 14, x2: 16, y2: 19, spawn: { x: 13, y: 16 }, tint: OFFICE_TINT_A, kind: "office" },
  { id: "office-s9",  label: "Hana's Office",  x1: 18, y1: 14, x2: 23, y2: 19, spawn: { x: 20, y: 16 }, tint: OFFICE_TINT_B, kind: "office" },
  { id: "office-s10", label: "Ivan's Office",  x1: 25, y1: 14, x2: 30, y2: 19, spawn: { x: 27, y: 16 }, tint: OFFICE_TINT_A, kind: "office" },
  { id: "office-jade", label: "Jade's Office", x1: 32, y1: 14, x2: 37, y2: 19, spawn: { x: 34, y: 16 }, tint: "#2c4257", kind: "office" },
  // --- bottom band: special rooms + TA office (rows 27-32) ---
  { id: "classroom",    label: "Classroom",    x1: 1,  y1: 27, x2: 8,  y2: 32, spawn: { x: 4,  y: 29 }, tint: "#27443a", kind: "special", forcedSkill: "classroom", modeLabel: "in class" },
  { id: "prep-room",    label: "Prep Room",    x1: 10, y1: 27, x2: 16, y2: 32, spawn: { x: 13, y: 29 }, tint: "#2a4448", kind: "special", forcedSkill: "author", modeLabel: "prepping notes/slides" },
  { id: "library",      label: "Library",      x1: 18, y1: 27, x2: 25, y2: 32, spawn: { x: 21, y: 29 }, tint: "#4d3b20", kind: "special", forcedSkill: "announce", modeLabel: "at the library", hasBoard: true },
  { id: "computer-lab", label: "Computer Lab", x1: 27, y1: 27, x2: 33, y2: 32, spawn: { x: 30, y: 29 }, tint: "#233d52", kind: "special", forcedSkill: "review", modeLabel: "reviewing code", hasBoard: true },
  { id: "office-ta",    label: "TA Office",    x1: 35, y1: 27, x2: 41, y2: 32, spawn: { x: 38, y: 29 }, tint: "#3a3158", kind: "special" },
  // --- commons: catch-all for all remaining floor; rect = south hall (label/spawn) ---
  { id: "commons", label: "Common Area", x1: 1, y1: 21, x2: 41, y2: 25, spawn: { x: 21, y: 23 }, tint: "#2b3247", kind: "commons" },
];

// Extra floor rects that are part of the commons (halls + side passages).
const COMMONS_RECTS = [
  { x1: 1, y1: 8, x2: 41, y2: 12 },   // north hall
  { x1: 1, y1: 21, x2: 41, y2: 25 },  // south hall
  { x1: 1, y1: 13, x2: 2, y2: 20 },   // west passage
  { x1: 39, y1: 13, x2: 41, y2: 20 }, // east passage
];

// Door tiles punched through walls (also exported so the client can
// render thresholds).
export const DOORS: { x: number; y: number }[] = [
  // band 1 offices → north hall
  { x: 3, y: 7 }, { x: 10, y: 7 }, { x: 17, y: 7 }, { x: 24, y: 7 }, { x: 31, y: 7 }, { x: 38, y: 7 },
  // band 2 offices → north hall
  { x: 6, y: 13 }, { x: 13, y: 13 }, { x: 20, y: 13 }, { x: 27, y: 13 }, { x: 34, y: 13 },
  // bottom rooms → south hall
  { x: 4, y: 26 }, { x: 13, y: 26 }, { x: 21, y: 26 }, { x: 30, y: 26 }, { x: 38, y: 26 },
];

export const COLS = 43;
export const ROWS = 34;

function buildMap(): string[] {
  const grid: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill("#"));
  const carve = (r: { x1: number; y1: number; x2: number; y2: number }) => {
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) grid[y][x] = ".";
  };
  for (const r of ROOMS) if (r.id !== "commons") carve(r);
  for (const r of COMMONS_RECTS) carve(r);
  for (const d of DOORS) grid[d.y][d.x] = ".";
  return grid.map((row) => row.join(""));
}

export const MAP: string[] = buildMap();

export function walkable(x: number, y: number): boolean {
  return MAP[y]?.[x] === ".";
}

export function roomAt(x: number, y: number): string | null {
  for (const r of ROOMS) {
    if (r.kind === "commons") continue;
    if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2) return r.id;
  }
  return walkable(x, y) ? "commons" : null;
}

export function roomById(id: string): RoomDef | undefined {
  return ROOMS.find((r) => r.id === id);
}

// The skill forced by whatever room the given tile is in (if any).
export function forcedSkillAt(x: number, y: number): string | undefined {
  const rid = roomAt(x, y);
  return rid ? roomById(rid)?.forcedSkill : undefined;
}

// Breadth-first search over the tile grid. Returns the path as a list of
// tiles to step through (excluding the start tile), or null if unreachable.
export function findPath(
  from: { x: number; y: number },
  to: { x: number; y: number }
): { x: number; y: number }[] | null {
  if (!walkable(to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];
  const key = (x: number, y: number) => y * COLS + x;
  const prev = new Map<number, number>();
  const visited = new Set<number>([key(from.x, from.y)]);
  const queue: { x: number; y: number }[] = [from];
  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const d of dirs) {
      const nx = cur.x + d.x;
      const ny = cur.y + d.y;
      if (!walkable(nx, ny) || visited.has(key(nx, ny))) continue;
      visited.add(key(nx, ny));
      prev.set(key(nx, ny), key(cur.x, cur.y));
      if (nx === to.x && ny === to.y) {
        const path: { x: number; y: number }[] = [];
        let k = key(nx, ny);
        while (k !== key(from.x, from.y)) {
          path.unshift({ x: k % COLS, y: Math.floor(k / COLS) });
          k = prev.get(k)!;
        }
        return path;
      }
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}
