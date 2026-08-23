// Room bulletin boards (Part 6 · Update 2): persistent, room-scoped
// posts the TA pins on the admin's behalf — the Library gets news,
// course material, and homework; the Computer Lab gets project/repo
// links. Students see a room's board when they walk in. Replaces the
// old global broadcast fan-out. Persisted to data/boards.json.

import fs from "fs";
import path from "path";
import { DATA_DIR } from "./paths";

export interface BoardItem {
  id: string;
  by: string;
  text: string;
  ts: string;
}

const FILE = path.join(DATA_DIR, "boards.json");
const MAX_ITEMS = 50;

const boards = new Map<string, BoardItem[]>();

// Ids were `post-<ms>-<list length + 1>`, which was unique only while lists
// grew. Unpinning shrinks one, so the next post could reuse a live id and an
// unpin would then remove the wrong item. A counter cannot repeat.
let seq = 0;

// Load persisted boards at startup (best effort).
try {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  for (const [roomId, items] of Object.entries(raw)) {
    if (Array.isArray(items)) boards.set(roomId, items as BoardItem[]);
  }
} catch {
  // no boards yet
}

function save(): void {
  const obj: Record<string, BoardItem[]> = {};
  for (const [k, v] of boards) obj[k] = v;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFile(FILE, JSON.stringify(obj, null, 2), () => {});
}

export function getBoard(roomId: string): BoardItem[] {
  return boards.get(roomId) || [];
}

// Unpin one item. The instructor has no avatar and cannot walk to a board to
// read it back, so without this a typo in a due date is permanent.
export function removeFromBoard(feed: string, id: string): boolean {
  const list = boards.get(feed);
  const i = list?.findIndex((x) => x.id === id) ?? -1;
  if (!list || i < 0) return false;
  list.splice(i, 1);
  boards.set(feed, list);
  save();
  return true;
}

export function postToBoard(roomId: string, by: string, text: string): BoardItem {
  const item: BoardItem = {
    id: `post-${Date.now().toString(36)}-${++seq}`,
    by,
    text,
    ts: new Date().toISOString(),
  };
  const list = boards.get(roomId) || [];
  list.unshift(item); // newest first
  if (list.length > MAX_ITEMS) list.length = MAX_ITEMS;
  boards.set(roomId, list);
  save();
  return item;
}
