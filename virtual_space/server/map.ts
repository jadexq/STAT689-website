// The campus map, generated programmatically from room definitions
// (hand-authoring the walls got error-prone at this size).
//
// Layout (43 x 21 tiles):
//   rows  1-6   ten student offices (S1-S10)
//   rows  8-12  commons — the hall
//   rows 14-19  Classroom | Prep Room | Library | Computer Lab | TA Office
//
// The bottom rooms USED TO BE mode selectors for the TA's brain: standing
// the TA in one forced a skill. That mechanism is gone — the TA never
// leaves the TA office now, so no room but their own could ever select
// anything. What survives is the bulletin BOARDS in the Library and the
// Computer Lab, which students read by walking in.

export const TILE = 32;

// A board feed is not always a room. The class-wide announcements feed has no
// room of its own: it is displayed by all ten student offices, which is where
// students spawn, so an announcement is the first thing they see at sign-in.
export const ANNOUNCEMENTS = "announcements";

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
  hasBoard?: boolean; // room has a bulletin board the instructor can pin posts to
  // Which feed this room's board displays. Absent means the room's own feed.
  // Every student office points at ANNOUNCEMENTS, so one pinned item shows up
  // in ten rooms, and unpinning it later stays one action rather than ten.
  boardFeed?: string;
  closed?: boolean; // room is sealed off (under construction); no way in
  // At most one human inside at a time; the door shuts behind them.
  soloOccupancy?: boolean;
}

// Two rooms are sealed. While the flag is false the room has no door, so it
// is unreachable both by BFS and on foot, and it is labelled 🚧. Flip to
// true to reopen — nothing else here needs to change.
//
// Classroom: TEMPORARY, waiting on the classroom skill being reworked.
// Prep Room: it existed only to put the TA in "notes and slides" mode. With
// the TA fixed in their office and down to a single skill there is nothing
// left for the room to do, so it is shut rather than left as a puzzle.
export const CLASSROOM_OPEN = false;
export const PREP_ROOM_OPEN = false;

// Light "Gather" palette. Two rules hold the whole thing together:
//   * every floor sits in a narrow lightness band (~84-90%), so no room reads
//     as brighter than another, only as a different hue;
//   * furniture and walls carry a dark warm outline, so the shapes read
//     against any of them.
// Offices get ten distinct tints rather than an A/B alternation: a student
// should recognise their own door from across the hall by colour alone.
const OFFICE_TINTS = [
  "#f4dbcf", // s1   clay
  "#eee5c8", // s2   wheat
  "#d9e9da", // s3   sage
  "#d5e4f0", // s4   sky
  "#e4dbef", // s5   lilac
  "#f2dee8", // s6   rose
  "#dfe7d0", // s7   olive
  "#cfe6e6", // s8   teal
  "#f3e2cd", // s9   apricot
  "#dfdcea", // s10  slate violet
];

// Ten student offices, three tiles wide on a pitch of four. They span x=2..40,
// which leaves a symmetric two-tile wall at each end of the 43-wide map.
//
// They used to be six tiles wide on a pitch of seven, which fitted six. Making
// them narrower was the cheap way to reach ten: no other room moves, the hall
// keeps its shape, and every door below y=7 is untouched. The cost is that an
// office label no longer fits inside the room, so the client draws the
// occupant's name alone rather than the full "Sam's Office".
const OFFICE_W = 3;
const OFFICE_PITCH = 4;
const OFFICE_X0 = 2;
const OFFICE_Y1 = 1;
const OFFICE_Y2 = 6;

// Placeholders only. roster.ts overwrites `label` at boot for every slot a
// real address holds, so these show only while a slot is vacant.
const OFFICE_NAMES = [
  "Sam", "Ben", "Chloe", "Dev", "Grace",
  "Student 6", "Student 7", "Student 8", "Student 9", "Student 10",
];

const officeX1 = (i: number) => OFFICE_X0 + i * OFFICE_PITCH;
// The door of office i, on the wall between the offices and the hall.
const officeDoorX = (i: number) => officeX1(i) + 1;

const OFFICES: RoomDef[] = OFFICE_NAMES.map((name, i): RoomDef => ({
  id: `office-s${i + 1}`,
  label: `${name}'s Office`,
  x1: officeX1(i),
  y1: OFFICE_Y1,
  x2: officeX1(i) + OFFICE_W - 1,
  y2: OFFICE_Y2,
  spawn: { x: officeX1(i) + 1, y: 3 },
  tint: OFFICE_TINTS[i],
  kind: "office",
  hasBoard: true,
  boardFeed: ANNOUNCEMENTS,
}));

export const ROOMS: RoomDef[] = [
  ...OFFICES,
  // --- bottom band: special rooms + TA office (rows 14-19) ---
  { id: "classroom",    label: CLASSROOM_OPEN ? "Classroom" : "Classroom 🚧", x1: 1,  y1: 14, x2: 8,  y2: 19, spawn: { x: 4,  y: 16 }, tint: "#dbe9de", kind: "special",
    ...(CLASSROOM_OPEN ? {} : { closed: true }) },
  { id: "prep-room",    label: PREP_ROOM_OPEN ? "Prep Room" : "Prep Room 🚧", x1: 10, y1: 14, x2: 16, y2: 19, spawn: { x: 13, y: 16 }, tint: "#e9e1d4", kind: "special",
    ...(PREP_ROOM_OPEN ? {} : { closed: true }) },
  { id: "library",      label: "Library",      x1: 18, y1: 14, x2: 25, y2: 19, spawn: { x: 21, y: 16 }, tint: "#edd9b4", kind: "special", hasBoard: true },
  { id: "computer-lab", label: "Computer Lab", x1: 27, y1: 14, x2: 33, y2: 19, spawn: { x: 30, y: 16 }, tint: "#d8e5ed", kind: "special", hasBoard: true },
  { id: "office-ta",    label: "TA Office",    x1: 35, y1: 14, x2: 41, y2: 19, spawn: { x: 38, y: 16 }, tint: "#e6def2", kind: "special", soloOccupancy: true },
  // --- commons: catch-all for all remaining floor; rect = the hall (label/spawn) ---
  { id: "commons", label: "Common Area", x1: 1, y1: 8, x2: 41, y2: 12, spawn: { x: 21, y: 10 }, tint: "#ece5d7", kind: "commons" },
];

// Which feed a room's board shows.
export function boardFeedOf(room: RoomDef): string {
  return room.boardFeed ?? room.id;
}

// Where the instructor can pin. Not the same set as the rooms that *display* a
// board: the ten offices all show the announcements feed, and posting "to an
// office" is a thing the class-wide design deliberately does not offer.
export const POST_TARGETS: { id: string; label: string }[] = [
  { id: ANNOUNCEMENTS, label: "📣 Announcements — all students" },
  ...ROOMS.filter((r) => r.hasBoard && !r.boardFeed).map((r) => ({ id: r.id, label: r.label })),
];

// Extra floor rects that are part of the commons (the single hall).
const COMMONS_RECTS = [
  { x1: 1, y1: 8, x2: 41, y2: 12 }, // the hall
];

// Door tiles punched through walls (also exported so the client can
// render thresholds).
export const DOORS: { x: number; y: number }[] = [
  // offices → the hall, one each, derived from the office geometry above so
  // a door cannot end up in a wall if the spacing ever changes again
  ...OFFICES.map((_, i) => ({ x: officeDoorX(i), y: 7 })),
  // the hall → bottom rooms (a sealed room's door does not exist)
  ...(CLASSROOM_OPEN ? [{ x: 4, y: 13 }] : []),
  ...(PREP_ROOM_OPEN ? [{ x: 13, y: 13 }] : []),
  { x: 21, y: 13 }, { x: 30, y: 13 }, { x: 38, y: 13 },
];

export const COLS = 43;
export const ROWS = 21;

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

// The door tile of a solo-occupancy room, so callers can block it while the
// room is taken. One door per room by construction — every bottom room is
// entered from the hall directly above it.
export function doorOf(roomId: string): { x: number; y: number } | undefined {
  const r = roomById(roomId);
  if (!r) return undefined;
  return DOORS.find((d) => d.x >= r.x1 && d.x <= r.x2 && Math.abs(d.y - r.y1) === 1);
}

// Breadth-first search over the tile grid. Returns the path as a list of
// tiles to step through (excluding the start tile), or null if unreachable.
export function findPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  blocked?: Set<string> // "x,y" tiles to route around (e.g. a shut door)
): { x: number; y: number }[] | null {
  const open = (x: number, y: number) => walkable(x, y) && !blocked?.has(`${x},${y}`);
  if (!open(to.x, to.y)) return null;
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
      if (!open(nx, ny) || visited.has(key(nx, ny))) continue;
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
