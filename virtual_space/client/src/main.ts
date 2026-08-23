// Browser client: Phaser renders the world, colyseus.js talks to the
// server. The right-hand panel (boards + chat + admin) is plain DOM,
// wired to the same Colyseus room. The server is authoritative — this
// file only sends intents (step/goto/chat/admin/mic) and renders what
// the server broadcasts.
//
// Identity comes from the SERVER (Google sign-in via IAP in the cloud, a
// dev identity locally) — this file never says who you are, and since
// 2026-08-22 it does not ask for a role either. The server derives both
// from the ADMIN_EMAILS allowlist, so the answer to "am I admin" is
// whatever came back in `init`, never the URL.
//
// Roles: "student" (you have an avatar) or "admin" (no avatar;
// keyboard/mouse drive the TA; chat is 🔒 private-to-TA or 🗣 speak-as-TA).
// An instructor is ALWAYS the admin; there is no switch to a student view.
//
// Rendering: the entire static world (checkered floors, shaded walls,
// furniture, door thresholds) is drawn once into a single baked texture —
// zero per-frame cost; only the dozen avatar containers ever update. The
// camera follows your avatar (or the TA for the admin) across the campus.

import Phaser from "phaser";
import { Client, Room } from "colyseus.js";

type Entity = { id: string; name: string; kind: "human" | "agent"; color: string; x: number; y: number };
type RoomInfo = {
  id: string;
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tint: string;
  kind: "office" | "special" | "commons";
  hasBoard?: boolean;
  closed?: boolean;
  soloOccupancy?: boolean;
};
type InitMsg = {
  tile: number;
  map: string[];
  doors: { x: number; y: number }[];
  rooms: RoomInfo[];
  you: string | null;
  role: "student" | "admin";
  isAdmin: boolean; // always equals (role === "admin") now; see MainRoom
  email: string;
  name: string;
  agents: { key: string; name: string }[];
  // Boards the instructor may pin to. Deliberately not the same set as the
  // rooms that display one — see MainRoom.
  postTargets: { id: string; label: string }[];
  shut: string[]; // solo-occupancy rooms currently taken
  home: string | null; // your own room; null for the admin, who has no avatar
};

const params = new URLSearchParams(location.search);
// Local multi-user testing: ?as=ben@local. Ignored by the server behind IAP.
const DEV_AS = params.get("as") || "";
// Every HTTP call that depends on WHO is asking has to carry ?as= too. The
// websocket gets it through devUser; fetch does not, and the Library shelf and
// repo cards never needed it because they are the same list for everyone.
// Handouts are not: without this, opening one while pretending to be a student
// identifies as the dev user — who is the admin — and silently shows the
// instructor's preview instead of that student's version. Empty behind IAP,
// where identify() ignores it anyway.
const AS_Q = DEV_AS ? `?as=${encodeURIComponent(DEV_AS)}` : "";
// What we actually ARE — filled in from init, so it cannot be faked here.
let role: "student" | "admin" = "student";

let room: Room;
let init: InitMsg;
let scene: WorldScene | null = null;
let latestWorld: Entity[] = [];
// Rooms that admit one person at a time and currently have someone inside.
let shutRooms = new Set<string>();

// The single door tile of a room — the one punched through its top wall.
function doorOfRoom(r: RoomInfo): { x: number; y: number } | undefined {
  return init?.doors.find((d) => d.x >= r.x1 && d.x <= r.x2 && Math.abs(d.y - r.y1) === 1);
}

// Am I (or, for the admin, the TA) inside this room? The occupant must not
// be told their own door is shut, and must be able to walk back out.
function insideRoom(r: RoomInfo): boolean {
  const me = latestWorld.find((e) => e.id === followId());
  return !!me && me.x >= r.x1 && me.x <= r.x2 && me.y >= r.y1 && me.y <= r.y2;
}

const TA_ID = "agent-ta";
const followId = () => (role === "admin" ? TA_ID : init?.you);

// ---------- color helpers ----------

function hex(color: string): number {
  return parseInt(color.replace("#", ""), 16);
}
function shade(c: number, f: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((c & 0xff) * f));
  return (r << 16) | (g << 8) | b;
}

// ---------- Phaser scene ----------

function roomInfoAt(x: number, y: number): RoomInfo | undefined {
  const named = init?.rooms.find((r) => r.kind !== "commons" && x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2);
  return named ?? init?.rooms.find((r) => r.kind === "commons");
}

// "the Library" but "Jade's Office" — see MainRoom.roomPhrase.
function roomPhrase(roomId: string | null): string {
  const label = init?.rooms.find((r) => r.id === roomId)?.label;
  if (!label) return "the world";
  return /^\S+'s\s/.test(label) ? label : `the ${label}`;
}

function labelFor(e: Entity): string {
  // The TA used to carry a mode label here, set by whichever room they were
  // standing in. They no longer leave their office and no longer have modes.
  return e.kind === "agent" ? `${e.name} 🤖` : e.name;
}

const MINI_W = 180; // minimap width in px

class WorldScene extends Phaser.Scene {
  private avatars = new Map<string, { c: Phaser.GameObjects.Container; label: Phaser.GameObjects.Text }>();
  private lastStep = 0;
  private following = false;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>;
  private roomLabels: Phaser.GameObjects.Text[] = [];
  private doorMarks = new Map<string, Phaser.GameObjects.Text>();
  private miniCam!: Phaser.Cameras.Scene2D.Camera;
  private miniMarkers!: Phaser.GameObjects.Graphics;
  private miniZoom = 1;
  private miniH = 0;
  private miniDrag = false;
  private freeLook = false; // user panned away; re-follow on next move
  private focusContainer: Phaser.GameObjects.Container | null = null;

  create() {
    const T = init.tile;
    const W = init.map[0].length * T;
    const H = init.map.length * T;

    this.drawWorld(T, W, H);

    // Room labels (static texts).
    for (const r of init.rooms) {
      const cx = ((r.x1 + r.x2 + 1) / 2) * T;
      const cy = (r.y1 + 0.7) * T;
      const label = this.add
        .text(cx, cy, (r.hasBoard ? "📌 " : "") + r.label.toUpperCase(), {
          fontFamily: "sans-serif",
          fontSize: r.kind === "office" ? "10px" : "11px",
          color: "#9fb0d0",
          fontStyle: "bold",
        })
        .setOrigin(0.5)
        .setAlpha(0.85)
        .setDepth(5);
      this.roomLabels.push(label);
    }

    // A 🔒 over the door of each solo-occupancy room, shown while taken.
    // Drawn as its own object rather than baked into the world texture,
    // which is rendered once and cannot be re-tinted.
    for (const r of init.rooms.filter((x) => x.soloOccupancy)) {
      const d = doorOfRoom(r);
      if (!d) continue;
      const mark = this.add
        .text((d.x + 0.5) * T, (d.y + 0.5) * T, "🔒", { fontSize: "16px" })
        .setOrigin(0.5)
        .setDepth(6)
        .setVisible(false);
      this.doorMarks.set(r.id, mark);
    }
    this.refreshDoors();

    // Camera roams the whole campus, following the focus avatar, zoomed in
    // to a room-scale view (the campus is much bigger than the viewport).
    this.cameras.main.setBounds(0, 0, W, H);
    this.cameras.main.setZoom(1.5);

    // Minimap: a second camera zoomed out over the whole campus, pinned to
    // the top-right. Avatars are hidden in it (their containers are ignored)
    // and drawn as crisp dots instead, plus the main camera's view rectangle.
    this.miniZoom = MINI_W / W;
    this.miniH = Math.round(H * this.miniZoom);
    this.miniCam = this.cameras.add(this.scale.width - MINI_W - 10, 10, MINI_W, this.miniH);
    this.miniCam.setZoom(this.miniZoom).centerOn(W / 2, H / 2);
    this.miniCam.setBackgroundColor(0x0b0e18);
    this.miniCam.ignore(this.roomLabels);
    this.miniMarkers = this.add.graphics().setDepth(20);
    this.cameras.main.ignore(this.miniMarkers);
    this.scale.on("resize", (size: Phaser.Structs.Size) => {
      this.miniCam.setPosition(size.width - MINI_W - 10, 10);
    });

    // A contrasting DOM frame around the minimap (crisp at any zoom).
    const frame = document.createElement("div");
    frame.id = "minimap-frame";
    frame.style.width = `${MINI_W + 4}px`;
    frame.style.height = `${this.miniH + 4}px`;
    document.getElementById("game")!.appendChild(frame);

    // Input: arrows / WASD step, click walks (server drives the TA for
    // admin). Clicking or dragging ON the minimap pans the main view
    // instead; two-finger trackpad scroll pans too. Any own movement
    // snaps the camera back to following you.
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys("W,A,S,D") as Record<string, Phaser.Input.Keyboard.Key>;
    this.input.on("pointerdown", (ptr: Phaser.Input.Pointer) => {
      if (this.inMinimap(ptr)) {
        this.miniDrag = true;
        this.panToMinimapPoint(ptr);
        return;
      }
      this.refollow();
      const tx = Math.floor(ptr.worldX / T);
      const ty = Math.floor(ptr.worldY / T);
      // A closed room is sealed (no door), so `goto` would find no path and
      // silently do nothing. Say why, rather than looking broken.
      const target = roomInfoAt(tx, ty);
      if (target?.closed) {
        addMsg({ who: "system", text: `${target.label} is under construction — you can't go in yet.`, cls: "sys" });
        return;
      }
      // The server refuses this too; saying so here saves the round trip
      // and, more usefully, explains a click that would otherwise do nothing.
      if (target && shutRooms.has(target.id) && !insideRoom(target)) {
        addMsg({ who: "system", text: `${roomPhrase(target.id).replace(/^the /, "The ")} is occupied — one student at a time. Try again shortly.`, cls: "sys" });
        return;
      }
      if (idleParked) return;
      room.send("goto", { x: tx, y: ty });
    });
    this.input.on("pointermove", (ptr: Phaser.Input.Pointer) => {
      if (this.miniDrag && ptr.isDown) this.panToMinimapPoint(ptr);
    });
    this.input.on("pointerup", () => (this.miniDrag = false));
    this.input.on("wheel", (_p: unknown, _o: unknown, dx: number, dy: number) => {
      const cam = this.cameras.main;
      cam.stopFollow();
      this.freeLook = true;
      cam.setScroll(cam.scrollX + dx / cam.zoom, cam.scrollY + dy / cam.zoom);
    });
    this.input.keyboard!.disableGlobalCapture();

    scene = this;
    this.updateEntities(latestWorld);
  }

  // Draw floors, walls, doors, and furniture ONCE into a baked texture.
  // Called on every change to the shut set, and once at scene creation.
  refreshDoors() {
    for (const [rid, mark] of this.doorMarks) mark.setVisible(shutRooms.has(rid));
    init.rooms.forEach((r, i) => {
      if (!r.soloOccupancy) return;
      this.roomLabels[i]?.setText((shutRooms.has(r.id) ? "🔒 " : "") + r.label.toUpperCase());
    });
  }

  private drawWorld(T: number, W: number, H: number) {
    const g = this.add.graphics();
    const doorSet = new Set(init.doors.map((d) => `${d.x},${d.y}`));

    // Floors: per-room tint with a subtle checker; doors highlighted.
    for (let y = 0; y < init.map.length; y++) {
      for (let x = 0; x < init.map[y].length; x++) {
        if (init.map[y][x] !== ".") continue;
        const base = hex(roomInfoAt(x, y)?.tint || "#2b3247");
        let col = (x + y) % 2 === 0 ? base : shade(base, 0.93);
        if (doorSet.has(`${x},${y}`)) col = shade(base, 1.35);
        g.fillStyle(col, 1);
        g.fillRect(x * T, y * T, T, T);
      }
    }
    // Walls: a lighter "face" where a wall meets floor below, darker cap otherwise.
    for (let y = 0; y < init.map.length; y++) {
      for (let x = 0; x < init.map[y].length; x++) {
        if (init.map[y][x] === ".") continue;
        const floorBelow = init.map[y + 1]?.[x] === ".";
        if (floorBelow) {
          g.fillStyle(0x353e6b, 1);
          g.fillRect(x * T, y * T, T, T * 0.55);
          g.fillStyle(0x232946, 1);
          g.fillRect(x * T, y * T + T * 0.55, T, T * 0.45);
        } else {
          g.fillStyle(0x262c4a, 1);
          g.fillRect(x * T, y * T, T, T);
        }
      }
    }
    this.drawFurniture(g, T);

    g.generateTexture("worldbg", W, H);
    g.destroy();
    this.add.image(0, 0, "worldbg").setOrigin(0, 0).setDepth(0);
  }

  private drawFurniture(g: Phaser.GameObjects.Graphics, T: number) {
    const desk = (tx: number, ty: number, w = 1.6, h = 0.9) => {
      g.fillStyle(0x2a2119, 1);
      g.fillRoundedRect(tx * T, ty * T + 3, w * T, h * T, 4);
      g.fillStyle(0x4a3c2e, 1);
      g.fillRoundedRect(tx * T, ty * T, w * T, h * T - 3, 4);
    };
    const chair = (tx: number, ty: number) => {
      g.fillStyle(0x1b2136, 1);
      g.fillCircle(tx * T, ty * T, T * 0.28);
    };
    const plant = (tx: number, ty: number) => {
      g.fillStyle(0x3a2f26, 1);
      g.fillCircle(tx * T, ty * T + 4, T * 0.22);
      g.fillStyle(0x3f7d4e, 1);
      g.fillCircle(tx * T, ty * T - 3, T * 0.3);
      g.fillStyle(0x55a468, 1);
      g.fillCircle(tx * T - 4, ty * T - 6, T * 0.16);
    };
    const table = (tx: number, ty: number, r = 0.7) => {
      g.fillStyle(0x33291f, 1);
      g.fillCircle(tx * T, ty * T + 3, r * T);
      g.fillStyle(0x51422f, 1);
      g.fillCircle(tx * T, ty * T, r * T);
    };
    const monitor = (tx: number, ty: number) => {
      g.fillStyle(0x11141f, 1);
      g.fillRect(tx * T, ty * T, T * 0.7, T * 0.5);
      g.fillStyle(0x39c2d7, 0.9);
      g.fillRect(tx * T + 2, ty * T + 2, T * 0.7 - 4, T * 0.5 - 4);
    };
    const bookshelf = (tx: number, ty: number) => {
      g.fillStyle(0x2a2119, 1);
      g.fillRect(tx * T, ty * T, T * 1.8, T * 0.55);
      const cols = [0xc94f4f, 0x4f7dc9, 0xc9a24f, 0x5aa46a, 0x9a6ac9];
      for (let i = 0; i < 5; i++) {
        g.fillStyle(cols[i], 1);
        g.fillRect(tx * T + 3 + i * (T * 0.33), ty * T + 3, T * 0.24, T * 0.42);
      }
    };
    const pinboard = (tx: number, ty: number) => {
      g.fillStyle(0x5a4a22, 1);
      g.fillRect(tx * T, ty * T, T * 1.4, T * 0.5);
      g.fillStyle(0xf3e9c9, 1);
      g.fillRect(tx * T + 4, ty * T + 4, T * 0.4, T * 0.34);
      g.fillRect(tx * T + T * 0.6, ty * T + 5, T * 0.4, T * 0.3);
    };

    for (const r of init.rooms) {
      if (r.kind === "office") {
        desk(r.x1 + 0.6, r.y1 + 0.6);
        chair(r.x1 + 1.4, r.y1 + 2.1);
        plant(r.x2 + 0.5, r.y1 + 0.6);
        pinboard(r.x1 + 3.4, r.y1 + 3.6); // the announcements board
      } else if (r.id === "classroom") {
        g.fillStyle(0xdfe6f5, 0.85); // whiteboard along the top wall
        g.fillRect((r.x1 + 0.7) * T, r.y1 * T + 4, (r.x2 - r.x1 - 1.4) * T, T * 0.35);
        for (let row = 0; row < 2; row++)
          for (let col = 0; col < 3; col++) desk(r.x1 + 0.8 + col * 2.3, r.y1 + 2 + row * 1.8, 1.4, 0.7);
      } else if (r.id === "prep-room") {
        desk(r.x1 + 1.5, r.y1 + 2, 3.2, 1.3);
        g.fillStyle(0xf3f3f3, 0.9);
        g.fillRect((r.x1 + 2) * T, (r.y1 + 2.2) * T, T * 0.5, T * 0.35);
        g.fillRect((r.x1 + 3) * T, (r.y1 + 2.4) * T, T * 0.5, T * 0.35);
        plant(r.x2 + 0.5, r.y2 + 0.5);
      } else if (r.id === "library") {
        bookshelf(r.x1 + 0.6, r.y1 + 0.8);
        bookshelf(r.x1 + 3.2, r.y1 + 0.8);
        bookshelf(r.x1 + 5.8, r.y1 + 0.8);
        pinboard(r.x1 + 2.8, r.y1 + 3.4);
        table(r.x1 + 1.6, r.y1 + 4.4, 0.6);
      } else if (r.id === "computer-lab") {
        for (let row = 0; row < 2; row++)
          for (let col = 0; col < 2; col++) {
            desk(r.x1 + 0.9 + col * 3, r.y1 + 1.4 + row * 2.2, 2, 0.8);
            monitor(r.x1 + 1.4 + col * 3, r.y1 + 1.45 + row * 2.2);
          }
        pinboard(r.x1 + 2.6, r.y1 + 4.6);
      } else if (r.id === "office-ta") {
        desk(r.x1 + 0.8, r.y1 + 0.8, 2, 1);
        chair(r.x1 + 1.8, r.y1 + 2.4);
        plant(r.x1 + 0.7, r.y2 + 0.4);
        plant(r.x2 + 0.4, r.y1 + 0.7);
      } else if (r.kind === "commons") {
        table(6, 10.5);
        table(21, 10.5);
        table(36, 10.5);
        table(11, 23.5);
        table(31, 23.5);
        plant(1.7, 8.7);
        plant(41.3, 8.7);
        plant(1.7, 25.3);
        plant(41.3, 25.3);
      }
    }
  }

  update(time: number) {
    this.drawMiniMarkers();
    if (idleParked) return;
    if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (time - this.lastStep < 140) return;
    let dx = 0;
    let dy = 0;
    if (this.cursors.left.isDown || this.wasd.A.isDown) dx = -1;
    else if (this.cursors.right.isDown || this.wasd.D.isDown) dx = 1;
    else if (this.cursors.up.isDown || this.wasd.W.isDown) dy = -1;
    else if (this.cursors.down.isDown || this.wasd.S.isDown) dy = 1;
    if (dx || dy) {
      this.refollow();
      room.send("step", { dx, dy });
      this.lastStep = time;
    }
  }

  private inMinimap(ptr: Phaser.Input.Pointer): boolean {
    return (
      ptr.x >= this.miniCam.x &&
      ptr.x <= this.miniCam.x + MINI_W &&
      ptr.y >= this.miniCam.y &&
      ptr.y <= this.miniCam.y + this.miniH
    );
  }

  // Center the main view on the world point under the minimap cursor.
  private panToMinimapPoint(ptr: Phaser.Input.Pointer) {
    const wx = (ptr.x - this.miniCam.x) / this.miniZoom;
    const wy = (ptr.y - this.miniCam.y) / this.miniZoom;
    this.cameras.main.stopFollow();
    this.freeLook = true;
    this.cameras.main.centerOn(wx, wy);
  }

  // Snap the camera back to following the focus avatar after free-look.
  private refollow() {
    if (!this.freeLook || !this.focusContainer) return;
    this.freeLook = false;
    this.cameras.main.startFollow(this.focusContainer, true, 0.12, 0.12);
  }

  // Entity dots + the main camera's view rectangle, world-sized so the
  // minimap camera scales them down; ignored by the main camera.
  private drawMiniMarkers() {
    if (!this.miniMarkers || !init) return;
    const T = init.tile;
    const g = this.miniMarkers;
    g.clear();
    for (const e of latestWorld) {
      const px = (e.x + 0.5) * T;
      const py = (e.y + 0.5) * T;
      const isFocus = e.id === followId();
      g.fillStyle(hex(e.color), 1);
      g.fillCircle(px, py, isFocus ? 30 : 22);
      if (isFocus) {
        g.lineStyle(10, 0xffffff, 1);
        g.strokeCircle(px, py, 30);
      }
    }
    const view = this.cameras.main.worldView;
    g.lineStyle(14, 0xffb454, 0.95); // draggable view rectangle — match the frame
    g.strokeRect(view.x, view.y, view.width, view.height);
  }

  updateEntities(list: Entity[]) {
    const T = init.tile;
    const seen = new Set<string>();
    for (const e of list) {
      seen.add(e.id);
      const px = (e.x + 0.5) * T;
      const py = (e.y + 0.5) * T;
      let a = this.avatars.get(e.id);
      if (!a) {
        const isFocus = e.id === followId();
        const shadow = this.add.ellipse(0, 10, 22, 9, 0x000000, 0.28);
        const circle = this.add.circle(0, 0, 12, hex(e.color));
        circle.setStrokeStyle(2.5, isFocus ? 0xffffff : 0x11141f, 1);
        const label = this.add
          .text(0, -22, labelFor(e), {
            fontFamily: "sans-serif",
            fontSize: "11px",
            color: "#ffffff",
            fontStyle: "bold",
            backgroundColor: "#11141fb0",
            padding: { x: 5, y: 2 } as any,
          })
          .setOrigin(0.5);
        const c = this.add.container(px, py, [shadow, circle, label]);
        c.setDepth(10);
        this.miniCam?.ignore(c); // minimap shows dots, not full avatars
        a = { c, label };
        this.avatars.set(e.id, a);
        if (isFocus) {
          this.focusContainer = c;
          if (!this.following) {
            this.following = true;
            this.cameras.main.startFollow(c, true, 0.12, 0.12);
          }
        }
      } else {
        if (a.c.x !== px || a.c.y !== py) {
          this.tweens.killTweensOf(a.c);
          this.tweens.add({ targets: a.c, x: px, y: py, duration: 110, ease: "Linear" });
        }
        const want = labelFor(e);
        if (a.label.text !== want) a.label.setText(want);
      }
    }
    for (const [id, a] of this.avatars) {
      if (!seen.has(id)) {
        a.c.destroy();
        this.avatars.delete(id);
      }
    }
  }
}

// ---------- DOM panel ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function addMsg(opts: { who: string; text: string; room?: string; cls?: string; skill?: string; sources?: string[] }) {
  const log = $<HTMLDivElement>("chat-log");
  const div = document.createElement("div");
  div.className = "msg " + (opts.cls || "");
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = opts.who;
  div.appendChild(who);
  if (opts.room) {
    const tag = document.createElement("span");
    tag.className = "room-tag";
    tag.textContent = opts.room;
    div.appendChild(tag);
  }
  if (opts.skill) {
    const tag = document.createElement("span");
    tag.className = "room-tag";
    tag.textContent = "via " + opts.skill;
    div.appendChild(tag);
  }
  // Where the answer came from. The server reports this, so it is there
  // whether or not the model remembered to say so in the text.
  for (const src of opts.sources ?? []) {
    const tag = document.createElement("span");
    tag.className = "room-tag src-tag";
    tag.textContent = "📄 " + src;
    div.appendChild(tag);
  }
  const body = document.createElement("span");
  body.className = "body";
  // The TA brain writes light markdown, and it used to arrive here as literal
  // ** and ` characters — which nobody noticed while the TA was a side show
  // and everybody notices now that talking to them is the whole app.
  body.innerHTML = renderRich(opts.text);
  div.appendChild(body);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

const typingFrom = new Set<string>();
function renderTyping() {
  $<HTMLDivElement>("typing").textContent = typingFrom.size
    ? [...typingFrom].join(", ") + (typingFrom.size > 1 ? " are" : " is") + " typing…"
    : "";
}

function setAdminStatus(note: string, ok: boolean) {
  const el = $<HTMLDivElement>("admin-status");
  el.textContent = note;
  el.className = ok ? "ok" : "err";
}

// Escape FIRST, then re-introduce the handful of markers the TA brain uses.
// Order matters: everything below operates on already-escaped text, so no
// model output can inject markup, and the link pattern only ever matches
// http(s), never javascript:.
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderRich(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/https?:\/\/[^\s)<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

// The Library shelf. The list is the TA's own manifest, proxied by the space
// (the TA's port is not reachable from a browser), so adding a reading to
// manifest.json puts it on the shelf AND in the TA's answers in one step.
// Fetched on each entry rather than cached for the session, so a reading the
// instructor adds mid-class appears on the next visit rather than the next
// reload.
type ShelfItem = { id: string; title: string; link?: string; format: string };
type AgendaRow = { iso: string; content: string; homework: string; topic: string; planned: boolean };

// The next couple of sessions, in the panel. The whole agenda is one click
// away on the shelf; this is the part a student wants on the way past — what
// is next and whether anything is due. A session with nothing written against
// it shows as scheduled-but-unplanned rather than being hidden: the date is
// real even when the content has not been decided yet.
async function renderUpNext() {
  const box = $<HTMLDivElement>("upnext");
  let rows: AgendaRow[];
  try {
    rows = ((await (await fetch("/api/agenda")).json()) as { rows?: AgendaRow[] }).rows ?? [];
  } catch {
    box.innerHTML = "";
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const next = rows.filter((r) => r.iso >= today).slice(0, 2);
  box.innerHTML = "";
  for (const r of next) {
    const d = document.createElement("div");
    d.className = "upnext-row" + (r.planned ? "" : " unplanned");
    const when = new Date(`${r.iso}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const what = r.planned ? r.content || r.topic : "not planned yet";
    d.innerHTML =
      `<span class="when">${escapeHtml(when)}</span><b>${escapeHtml(what)}</b>` +
      (r.planned && r.homework && r.homework !== "-" ? ` — due: ${escapeHtml(r.homework)}` : "");
    box.appendChild(d);
  }
}

async function renderShelf(show: boolean) {
  const wrap = $<HTMLDivElement>("shelf-wrap");
  wrap.style.display = show ? "block" : "none";
  if (!show) return;
  void renderUpNext();
  const list = $<HTMLDivElement>("shelf");
  const note = (text: string) => {
    list.innerHTML = "";
    const d = document.createElement("div");
    d.className = "shelf-note";
    d.textContent = text;
    list.appendChild(d);
  };
  if (!list.children.length) note("Fetching the reading list…");

  let readings: ShelfItem[];
  try {
    const res = await fetch("/api/materials");
    readings = ((await res.json()) as { readings?: ShelfItem[] }).readings ?? [];
  } catch {
    readings = [];
    note("The reading list is unavailable right now.");
    return;
  }
  if (!readings.length) {
    note("No readings posted yet.");
    return;
  }
  list.innerHTML = "";
  for (const r of readings) {
    const d = document.createElement("div");
    d.className = "shelf-item";
    const a = document.createElement("a");
    // Served by the space, which renders .md to HTML on the way out — a
    // browser handed raw markdown shows source or offers a download.
    a.href = `/api/materials/${encodeURIComponent(r.id)}/file`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = r.title;
    d.appendChild(a);
    const tag = document.createElement("span");
    tag.className = "fmt";
    tag.textContent = r.format || "file";
    d.appendChild(tag);
    list.appendChild(d);
  }
}

// The Computer Lab's repo cards. Config on the server, not a pinned post,
// so the list outlives a boards.json wipe. Same fetch-on-entry shape as the
// shelf, and the same .shelf-item styling — two boards, one card idiom.
type RepoCard = { name: string; description: string; url: string };

async function renderRepos(show: boolean) {
  const wrap = $<HTMLDivElement>("repos-wrap");
  wrap.style.display = show ? "block" : "none";
  if (!show) return;
  const list = $<HTMLDivElement>("repos");
  let repos: RepoCard[];
  try {
    repos = ((await (await fetch("/api/repos")).json()) as { repos?: RepoCard[] }).repos ?? [];
  } catch {
    repos = [];
  }
  list.innerHTML = "";
  if (!repos.length) {
    const d = document.createElement("div");
    d.className = "shelf-note";
    d.textContent = "No project repositories posted yet.";
    list.appendChild(d);
    return;
  }
  for (const r of repos) {
    const d = document.createElement("div");
    d.className = "shelf-item";
    const a = document.createElement("a");
    a.href = r.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = r.name;
    d.appendChild(a);
    if (r.description) {
      const p = document.createElement("span");
      p.className = "desc";
      p.textContent = r.description;
      d.appendChild(p);
    }
    list.appendChild(d);
  }
}

// The student's own handouts, shown in their home room. Third use of the
// fetch-on-entry idiom, after the Library shelf (2b) and the repo cards (3a):
// no websocket message, no room state, no MainRoom involvement.
//
// Home room rather than "their office" on purpose. init.home is the Common
// Area for anyone not yet on the roster, and that is exactly the person who
// needs to be told why their links will not open — a panel that only appears
// in an office they do not have would leave them with no signal at all.
type HandoutCard = { id: string; title: string; chapter: string; term: string; sections: number; graded: number };

async function renderHandouts(show: boolean) {
  const wrap = $<HTMLDivElement>("handouts-wrap");
  wrap.style.display = show ? "block" : "none";
  if (!show) return;
  const list = $<HTMLDivElement>("handouts");
  let data: { handouts?: HandoutCard[]; note?: string };
  try {
    data = (await (await fetch(`/api/handouts${AS_Q}`)).json()) as { handouts?: HandoutCard[]; note?: string };
  } catch {
    data = {};
  }
  const handouts = data.handouts ?? [];
  list.innerHTML = "";
  if (data.note) {
    const d = document.createElement("div");
    d.className = "shelf-note";
    d.textContent = data.note;
    list.appendChild(d);
  }
  if (!handouts.length) {
    const d = document.createElement("div");
    d.className = "shelf-note";
    d.textContent = "No handouts yet.";
    list.appendChild(d);
    return;
  }
  for (const h of handouts) {
    const d = document.createElement("div");
    d.className = "handout-item";
    const a = document.createElement("a");
    a.href = `/handout/${encodeURIComponent(h.id)}${AS_Q}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = h.title;
    d.appendChild(a);
    const p = document.createElement("span");
    const done = h.graded >= h.sections;
    p.className = "prog" + (done ? " done" : "");
    p.textContent = done
      ? `${h.chapter} · all ${h.sections} sections graded — thank you`
      : `${h.chapter} · ${h.graded} of ${h.sections} sections graded`;
    d.appendChild(p);
    list.appendChild(d);
  }
}

function renderBoard(msg: { roomId: string | null; room?: string; items?: { by: string; text: string; ts: string }[] }) {
  const card = $<HTMLDivElement>("board-card");
  if (!msg.roomId) {
    card.style.display = "none";
    void renderShelf(false);
    void renderRepos(false);
    void renderHandouts(false);
    return;
  }
  card.style.display = "block";
  void renderShelf(msg.roomId === "library");
  void renderRepos(msg.roomId === "computer-lab");
  void renderHandouts(!!init?.home && msg.roomId === init.home);
  $<HTMLDivElement>("board-title").textContent = `📌 ${msg.room} board`;
  const list = $<HTMLDivElement>("board-list");
  list.innerHTML = "";
  if (!msg.items?.length) {
    const d = document.createElement("div");
    d.className = "board-empty";
    d.textContent = "Nothing pinned yet.";
    list.appendChild(d);
    return;
  }
  for (const item of msg.items) {
    const d = document.createElement("div");
    d.className = "board-item";
    d.innerHTML = renderRich(item.text) + `<span class="meta">— ${item.by}, ${new Date(item.ts).toLocaleString()}</span>`;
    list.appendChild(d);
  }
}

// Board posting: the instructor's own text, pinned exactly as typed.
type FeedItem = { id: string; by: string; text: string; ts: string };
let adminFeeds: Record<string, FeedItem[]> = {};
let onAdminFeeds: (() => void) | null = null;

function chatMode(): "private" | "speak" {
  const el = document.querySelector<HTMLInputElement>('input[name="cmode"]:checked');
  return el?.value === "speak" ? "speak" : "private";
}

function wirePanel() {
  $<HTMLDivElement>("role-sub").innerHTML =
    `You are <b>${escapeHtml(init.name)}</b> (${escapeHtml(init.email)}), a student.`;
  if (role === "admin") {
    $<HTMLDivElement>("role-sub").innerHTML =
      "You are the <b>admin</b> — no avatar. You <b>are</b> the TA, and the TA stays in the TA office. Chat below is private to the TA brain, or spoken aloud in the office.";
    $<HTMLDivElement>("admin").style.display = "block";
    $<HTMLDivElement>("chat-mode").style.display = "block";
    $<HTMLInputElement>("chat-input").placeholder = "Ask the TA brain privately, or speak aloud in the office (pick above)…";
  }

  const agentSel = $<HTMLSelectElement>("agent-sel");
  for (const a of init.agents) {
    const o = document.createElement("option");
    o.value = a.key;
    o.textContent = a.key === "ta" ? `${a.name} (virtual TA)` : `${a.name} (virtual student)`;
    agentSel.appendChild(o);
  }
  agentSel.value = "ta";
  // Post targets come from the server, not from `rooms.hasBoard`: all six
  // offices display a board, and none of them is a place to post — they show
  // the one class-wide feed.
  const boardSel = $<HTMLSelectElement>("board-sel");
  for (const t of init.postTargets) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.label;
    boardSel.appendChild(o);
  }

  // What is on each board the instructor can post to, so they can read back
  // and unpin. Kept here rather than on the world map because the instructor
  // has no avatar to walk to a board with.
  const renderFeed = () => {
    const box = $<HTMLDivElement>("post-feed");
    box.innerHTML = "";
    const items = adminFeeds[boardSel.value] || [];
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "feed-empty";
      d.textContent = "Nothing pinned here yet.";
      box.appendChild(d);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "feed-item";
      const t = document.createElement("span");
      t.textContent = item.text;
      const x = document.createElement("button");
      x.textContent = "✕";
      x.title = "Unpin";
      x.onclick = () => room.send("admin", { action: "unpin", board: boardSel.value, id: item.id });
      row.append(t, x);
      box.appendChild(row);
    }
  };
  boardSel.onchange = renderFeed;
  onAdminFeeds = renderFeed;
  renderFeed();

  const send = () => {
    const input = $<HTMLInputElement>("chat-input");
    const text = input.value.trim();
    if (!text) return;
    room.send("chat", role === "admin" ? { text, mode: chatMode() } : { text });
    input.value = "";
  };
  $<HTMLButtonElement>("chat-send").onclick = send;
  $<HTMLInputElement>("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });

  $<HTMLButtonElement>("direct-send").onclick = () => {
    room.send("admin", { action: "direct", agent: agentSel.value, instruction: $<HTMLTextAreaElement>("instruction").value.trim() });
  };
  // Board posts are the instructor's own words — typed here, pinned as-is.
  $<HTMLButtonElement>("post-send").onclick = () => {
    const box = $<HTMLTextAreaElement>("post-text");
    const text = box.value.trim();
    if (!text) return;
    room.send("admin", { action: "post", board: boardSel.value, text });
    box.value = "";
  };

  // Adding a reading, without a redeploy. The file goes to the space, which
  // checks the uploader is the instructor and forwards it to the corpus; the
  // TA picks it up on the next question and the Library shelf on the next
  // visit. Sent as a raw body with the metadata in the query string — no
  // multipart parser, no base64 round-trip.
  $<HTMLButtonElement>("up-send").onclick = async () => {
    const picker = $<HTMLInputElement>("up-file");
    const file = picker.files?.[0];
    if (!file) return setAdminStatus("Pick a file first.", false);
    const titleBox = $<HTMLInputElement>("up-title");
    const base = file.name.replace(/\.[^.]+$/, "");
    const title = titleBox.value.trim() || base;
    // The id is derived, not asked for: it is a URL and a manifest key, not
    // something the instructor should have to invent a convention for.
    const id = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
    const agenda = $<HTMLInputElement>("up-agenda").checked;
    const qs = new URLSearchParams({ id, title, filename: file.name });
    if (agenda) qs.set("agenda", "1");
    setAdminStatus(`Uploading ${file.name}…`, true);
    try {
      const res = await fetch(`/api/materials?${qs}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      });
      const body = (await res.json()) as { ok: boolean; note: string };
      setAdminStatus(body.note, body.ok);
      if (body.ok) {
        picker.value = "";
        titleBox.value = "";
        $<HTMLInputElement>("up-agenda").checked = false;
      }
    } catch {
      setAdminStatus("The upload did not go through.", false);
    }
  };

  // Handouts. Uploaded as one bundle rather than file by file: at six versions
  // a handout is two dozen markdown files, and `npm run bundle:handout` has
  // already validated them into a single JSON. The server validates again.
  async function refreshHandoutAdmin() {
    const box = $<HTMLDivElement>("hadmin-list");
    let handouts: HandoutCard[] = [];
    try {
      handouts = ((await (await fetch(`/api/handouts${AS_Q}`)).json()) as { handouts?: HandoutCard[] }).handouts ?? [];
    } catch {
      /* leave the list as it was rather than blanking it on one bad fetch */
      return;
    }
    box.innerHTML = "";
    if (!handouts.length) {
      const d = document.createElement("div");
      d.className = "hadmin-row";
      d.textContent = "Nothing uploaded yet.";
      box.appendChild(d);
      return;
    }
    for (const h of handouts) {
      const d = document.createElement("div");
      d.className = "hadmin-row";
      const id = encodeURIComponent(h.id);
      d.innerHTML =
        `<b>${escapeHtml(h.title)}</b>` +
        `<a href="/handout/${id}${AS_Q}" target="_blank" rel="noopener">preview</a>` +
        `<a href="/admin/handouts/${id}${AS_Q}" target="_blank" rel="noopener">feedback</a>` +
        `<span>${escapeHtml(h.chapter)} · ${h.sections} sections</span>`;
      box.appendChild(d);
    }
  }
  void refreshHandoutAdmin();

  $<HTMLButtonElement>("ho-send").onclick = async () => {
    const picker = $<HTMLInputElement>("ho-file");
    const file = picker.files?.[0];
    if (!file) return setAdminStatus("Pick a .handout.json bundle first.", false);
    setAdminStatus(`Uploading ${file.name}…`, true);
    try {
      const res = await fetch(`/api/handouts${AS_Q}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await file.text(),
      });
      const body = (await res.json()) as { ok: boolean; note?: string; handout_id?: string; sections?: number; versions?: number; problems?: string[] };
      if (body.ok) {
        setAdminStatus(`${body.handout_id}: ${body.sections} sections × ${body.versions} versions.`, true);
        picker.value = "";
        void refreshHandoutAdmin();
      } else {
        // The bundler's own messages, passed through — they name the file and
        // the fault, which is the whole reason it refuses rather than warns.
        setAdminStatus([body.note, ...(body.problems ?? [])].filter(Boolean).join(" "), false);
      }
    } catch {
      setAdminStatus("The bundle did not go through.", false);
    }
  };

  // Lecturer mic → class transcript in the TA brain (Chrome Web Speech).
  const micBtn = $<HTMLButtonElement>("mic-toggle");
  const micState = $<HTMLSpanElement>("mic-state");
  const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  let rec: any = null;
  let micOn = false;
  micBtn.onclick = () => {
    if (!SR) {
      micState.textContent = "needs Chrome (Web Speech API)";
      return;
    }
    if (micOn) {
      micOn = false;
      rec?.stop();
      micBtn.textContent = "🎤 Mic: off";
      micBtn.classList.remove("on");
      micState.textContent = "";
      return;
    }
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const t = String(e.results[i][0].transcript || "").trim();
          if (t) {
            markActive(); // talking through the mic counts, even hands-off
            room.send("mic", { text: t });
          }
        }
      }
    };
    rec.onerror = (e: any) => {
      micState.textContent = `mic error: ${e.error || "unknown"}`;
    };
    rec.onend = () => {
      if (micOn) rec.start(); // keep listening through pauses
    };
    rec.start();
    micOn = true;
    micBtn.textContent = "🎤 Mic: LIVE";
    micBtn.classList.add("on");
    micState.textContent = "lecture is being transcribed to the TA brain";
  };
}

// ---------- boot ----------

const JOIN_OPTS = () => ({
  // No role is sent — it is derived server-side from the allowlist.
  // Local multi-user testing only — ignored behind IAP.
  ...(DEV_AS ? { devUser: DEV_AS } : {}),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let booted = false; // the Phaser game is created once, never on reconnect
let leaving = false; // set when WE are closing the connection on purpose

// ---------- idle disconnect ----------
// Cloud Run bills an instance for as long as ANY WebSocket is open, idle or
// not. A laptop left open over a weekend is ~48 hours of billed time against
// a free-tier budget of roughly 50 hours a month, and the reconnect logic
// below would otherwise keep such a tab alive indefinitely. So after
// IDLE_MS without deliberate activity we close the socket on purpose and
// wait for an explicit click. Mouse movement does not count as activity;
// keys, clicks, scrolling and mic chunks do.
const IDLE_MS = 15 * 60 * 1000;
let lastActivity = Date.now();
let idleParked = false;

function markActive() {
  lastActivity = Date.now();
}
for (const ev of ["keydown", "mousedown", "wheel", "touchstart"]) {
  window.addEventListener(ev, markActive, { passive: true });
}

function showIdleOverlay(onRejoin: () => void) {
  const wrap = document.createElement("div");
  wrap.id = "idle-overlay";
  wrap.setAttribute(
    "style",
    "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;" +
      "justify-content:center;background:#11141fd8;backdrop-filter:blur(2px)",
  );
  const card = document.createElement("div");
  card.setAttribute(
    "style",
    "background:#232946;color:#fff;padding:1.5rem 1.75rem;border-radius:10px;" +
      "font-family:sans-serif;text-align:center;max-width:22rem;box-shadow:0 8px 30px #0008",
  );
  const p1 = document.createElement("p");
  p1.setAttribute("style", "margin:0 0 .35rem;font-weight:700");
  p1.textContent = "Disconnected after 15 minutes of inactivity";
  const p2 = document.createElement("p");
  p2.setAttribute("style", "margin:0 0 1rem;font-size:.85rem;opacity:.8");
  p2.textContent = "The campus stops running when nobody is using it. Your conversation is saved.";
  const btn = document.createElement("button");
  btn.textContent = "Rejoin";
  btn.setAttribute(
    "style",
    "background:#6b7cff;color:#fff;border:0;border-radius:6px;padding:.5rem 1.25rem;" +
      "font-size:1rem;cursor:pointer",
  );
  btn.addEventListener("click", onRejoin);
  card.append(p1, p2, btn);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  btn.focus();
}

function startIdleWatch(client: Client) {
  setInterval(() => {
    if (idleParked || !room) return;
    if (Date.now() - lastActivity < IDLE_MS) return;
    idleParked = true;
    leaving = true;
    void Promise.resolve(room.leave(true)).catch(() => {});
    showIdleOverlay(() => void rejoinFromIdle(client));
  }, 30_000);
}

async function rejoinFromIdle(client: Client) {
  document.getElementById("idle-overlay")?.remove();
  markActive();
  try {
    room = await client.joinOrCreate("main", JOIN_OPTS());
    idleParked = false;
    leaving = false;
    wireRoom(client);
    addMsg({ who: "system", text: "Rejoined.", cls: "sys" });
  } catch (err) {
    showIdleOverlay(() => void rejoinFromIdle(client));
    addMsg({ who: "system", text: "Could not rejoin: " + err, cls: "sys" });
  }
}

async function main() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const client = new Client(`${proto}://${location.host}`);
  room = await client.joinOrCreate("main", JOIN_OPTS());
  wireRoom(client);
  startIdleWatch(client);

  // Small debug hook (useful for scripted testing; harmless to keep).
  (window as any).vs = {
    step: (dx: number, dy: number) => room.send("step", { dx, dy }),
    goto: (x: number, y: number) => room.send("goto", { x, y }),
    chat: (text: string) => room.send("chat", { text }),
    world: () => latestWorld,
  };
}

// Every handler lives here because a reconnect hands us a NEW Room object
// and they all have to be attached again.
function wireRoom(client: Client) {
  room.onMessage("world", (msg: { entities: Entity[] }) => {
    latestWorld = msg.entities;
    scene?.updateEntities(latestWorld);
  });

  // A single entity stepped one tile. The full roster only arrives on
  // joins, leaves and teleports; everything in between is a delta.
  // An id we have never seen is ignored — the next full world fixes it.
  room.onMessage("moved", (msg: { id: string; x: number; y: number }) => {
    const e = latestWorld.find((x) => x.id === msg.id);
    if (!e) return;
    e.x = msg.x;
    e.y = msg.y;
    scene?.updateEntities(latestWorld);
  });

  room.onMessage("chat", (msg: { from: string; id: string; kind: string; text: string; room: string; skill?: string; sources?: string[] }) => {
    typingFrom.delete(msg.from);
    renderTyping();
    const mine = msg.id === init?.you || msg.id === "admin";
    addMsg({
      who: msg.from,
      text: msg.text,
      room: msg.room,
      skill: msg.skill,
      sources: msg.sources,
      cls: (msg.room === "private" ? "private " : "") + (mine ? "me" : msg.kind === "agent" ? "agent" : ""),
    });
  });

  room.onMessage("board", renderBoard);
  room.onMessage("adminFeeds", (msg: { feeds: Record<string, FeedItem[]> }) => {
    adminFeeds = msg.feeds || {};
    onAdminFeeds?.();
  });

  room.onMessage("notice", (msg: { text: string }) => {
    addMsg({ who: "system", text: msg.text, cls: "sys" });
  });

  room.onMessage("doors", (msg: { shut: string[] }) => {
    shutRooms = new Set(msg.shut);
    scene?.refreshDoors();
  });

  room.onMessage("typing", (msg: { name: string }) => {
    typingFrom.add(msg.name);
    renderTyping();
    setTimeout(() => {
      typingFrom.delete(msg.name);
      renderTyping();
    }, 45000);
  });

  room.onMessage("adminAck", (msg: { ok: boolean; note: string }) => setAdminStatus(msg.note, msg.ok));


  room.onMessage("init", (msg: InitMsg) => {
    init = msg;
    role = msg.role;
    // `doors` only fires on change, so the current state has to arrive here.
    shutRooms = new Set(msg.shut ?? []);
    scene?.refreshDoors();
    // A reconnect that had to fall back to a fresh join sends init again;
    // the panel and the game are already up, only `init` needed refreshing.
    if (booted) return;
    booted = true;
    wirePanel();
    addMsg({
      who: "system",
      text:
        role === "admin"
          ? "Connected as admin. The TA waits in the TA office for students to walk in."
          : `Connected. You're in ${roomPhrase(init.home)} — walk out through the door to the halls.`,
      cls: "sys",
    });
    new Phaser.Game({
      type: Phaser.AUTO,
      parent: "game",
      backgroundColor: "#0f1320",
      // Fill the container and follow window resizes — no fixed viewport.
      scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
      scene: WorldScene,
    });
  });

  // Cloud Run cuts every connection at the service's request timeout — a
  // wall-clock limit, not an idle one, so heartbeats do not extend it and a
  // long class WILL be interrupted. Laptops sleep too. The server holds the
  // seat open briefly (allowReconnection), so resume it if we can and take a
  // fresh one if not.
  const token = room.reconnectionToken;
  room.onLeave((code) => {
    if (leaving || code === 1000) return; // we closed it on purpose
    addMsg({ who: "system", text: "Connection lost — reconnecting…", cls: "sys" });
    void reconnect(client, token);
  });
}

async function reconnect(client: Client, token: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(Math.min(1000 * 2 ** attempt, 15_000));
    try {
      // Resuming keeps the avatar exactly where it was standing. If the
      // seat is gone (server restarted, window expired), take a new one.
      let next: Room;
      try {
        next = await client.reconnect(token);
      } catch {
        next = await client.joinOrCreate("main", JOIN_OPTS());
      }
      room = next;
      wireRoom(client);
      addMsg({ who: "system", text: "Reconnected.", cls: "sys" });
      return;
    } catch {
      // still down — back off and try again
    }
  }
  // Out of retries. The likeliest cause is not a dead server but an expired
  // IAP session: a browser cannot follow a 302 on a WebSocket upgrade, so
  // IAP's redirect to the login page is invisible here and every attempt just
  // fails. Only a full page load runs the sign-in round trip, and the socket
  // closes with 1006 either way — indistinguishable from a real network drop.
  // So reload rather than printing advice a student has to read and act on.
  //
  // Guarded, because if the server is genuinely down this would otherwise
  // become a reload every ~75 seconds forever.
  if (canAutoReload()) {
    addMsg({ who: "system", text: "Session expired — reloading to sign in again…", cls: "sys" });
    setTimeout(() => location.reload(), 1200); // let the message render
    return;
  }
  addMsg({ who: "system", text: "Couldn't reconnect. Reload the page to rejoin.", cls: "sys" });
}

// At most one automatic reload per RELOAD_COOLDOWN_MS, remembered for the tab
// rather than the page, since the reload itself wipes everything else.
const RELOAD_KEY = "vs.lastAutoReload";
const RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

function canAutoReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    return false; // private mode, storage disabled — never loop
  }
}

main().catch((err) => {
  addMsg({ who: "system", text: "Failed to connect: " + err, cls: "sys" });
  console.error(err);
});
