// The single Colyseus room hosting the whole world. The server is
// authoritative: it owns every position, validates every move, routes
// same-room chat, runs agent replies, and logs everything. AI agents are
// server-side "players" — same entity shape as a human, driven by an LLM.
//
// Roles (Part 6 · Update 2, temporary testing setup — no auth yet):
//   student — has an avatar (Jade); normal chat & movement.
//   admin   — NO avatar; keyboard/mouse drive Terra; chat is either
//             🔒 private to the TA brain or 🗣 spoken aloud as Terra.
//             Admin-only: direct agents, compose/post board items, mic.
//
// Terra's replies come from the Virtual TA brain (ta.ts) with one session
// per student; the room she stands in can force a skill. Board posts are
// composed by the announce skill, previewed to the admin, and pinned to a
// room's board — students see the board when they walk in (no global
// fan-out anymore).

import { Room, Client } from "colyseus";
import { MAP, TILE, DOORS, ROOMS, walkable, roomAt, roomById, forcedSkillAt, findPath } from "../map";
import { AGENTS, TERRA_ID, AgentDef, agentReply, agentCompose, HistoryEntry } from "../agents";
import { taChat, taListen } from "../ta";
import { getBoard, postToBoard } from "../boards";
import { logEvent } from "../logger";

export interface Entity {
  id: string;
  name: string;
  kind: "human" | "agent";
  color: string;
  x: number;
  y: number;
}

interface AgentRuntime extends Entity {
  def: AgentDef;
  busy: boolean;
}

const HISTORY_LIMIT = 30;
const MAX_STUDENT_REPLIES = 2; // per human message — Terra is exempt
const TA_OFFLINE_MSG =
  "(my TA brain isn't reachable — is the Virtual TA server running? `npm run dev` in virtual_ta)";

export class MainRoom extends Room {
  maxClients = 20;
  private players = new Map<string, Entity>();
  private admins = new Set<string>(); // sessionIds of admin-role clients
  private agents: AgentRuntime[] = [];
  private history = new Map<string, HistoryEntry[]>(); // per map-room chat log
  private walkers = new Map<string, { clear: () => void }>(); // entity id -> active walk
  private lastRoom = new Map<string, string | null>(); // client -> room of their focus entity

  onCreate() {
    this.autoDispose = false;

    for (const def of AGENTS) {
      const home = roomById(def.home)!;
      this.agents.push({
        id: def.id,
        name: def.name,
        kind: "agent",
        color: def.color,
        x: home.spawn.x,
        y: home.spawn.y,
        def,
        busy: false,
      });
    }
    for (const r of ROOMS) this.history.set(r.id, []);

    this.onMessage("step", (client, msg) => this.handleStep(client, msg));
    this.onMessage("goto", (client, msg) => this.handleGoto(client, msg));
    this.onMessage("chat", (client, msg) => this.handleChat(client, msg));
    this.onMessage("admin", (client, msg) => this.handleAdmin(client, msg));
    this.onMessage("mic", (client, msg) => this.handleMic(client, msg));

    logEvent("server_start", { agents: this.agents.map((a) => a.name) });
  }

  onJoin(client: Client, options: any) {
    const isAdmin = options?.role === "admin";
    if (isAdmin) {
      this.admins.add(client.sessionId);
      logEvent("join", { who: "admin", id: client.sessionId, role: "admin" });
    } else {
      const name = String(options?.name || "Jade").slice(0, 24) || "Jade";
      // A page reload (e.g. the role switch) can re-join before the old
      // socket's close is processed, leaving a ghost avatar. One human
      // identity per name: a rejoin replaces any stale entity.
      for (const [sid, old] of this.players) {
        if (old.name === name) {
          this.stopWalk(old.id);
          this.players.delete(sid);
          this.lastRoom.delete(sid);
        }
      }
      const home = roomById("office-jade")!;
      const p: Entity = {
        id: client.sessionId,
        name,
        kind: "human",
        color: "#4da3ff",
        x: home.spawn.x,
        y: home.spawn.y,
      };
      this.players.set(client.sessionId, p);
      logEvent("join", { who: name, id: client.sessionId, x: p.x, y: p.y, role: "student" });
    }
    client.send("init", {
      tile: TILE,
      map: MAP,
      doors: DOORS,
      rooms: ROOMS,
      you: isAdmin ? null : client.sessionId,
      role: isAdmin ? "admin" : "student",
      agents: AGENTS.map((a) => ({ key: a.key, name: a.name })),
    });
    this.broadcastWorld();
  }

  onLeave(client: Client) {
    const p = this.players.get(client.sessionId);
    if (p) logEvent("leave", { who: p.name, id: p.id });
    this.stopWalk(client.sessionId);
    this.players.delete(client.sessionId);
    this.admins.delete(client.sessionId);
    this.lastRoom.delete(client.sessionId);
    this.broadcastWorld();
  }

  // The entity a client's input drives / camera watches: their own avatar,
  // or Terra for the admin.
  private focusEntity(client: Client): Entity | undefined {
    return this.players.get(client.sessionId) ?? (this.admins.has(client.sessionId) ? this.terra() : undefined);
  }

  private terra(): AgentRuntime {
    return this.agents.find((a) => a.id === TERRA_ID)!;
  }

  // ---------- movement ----------

  private handleStep(client: Client, msg: any) {
    const e = this.focusEntity(client);
    if (!e) return;
    const dx = Math.sign(Number(msg?.dx) || 0);
    const dy = Math.sign(Number(msg?.dy) || 0);
    if (Math.abs(dx) + Math.abs(dy) !== 1) return;
    this.stopWalk(e.id);
    const nx = e.x + dx;
    const ny = e.y + dy;
    if (!walkable(nx, ny)) return;
    e.x = nx;
    e.y = ny;
    logEvent("move", { who: e.name, id: e.id, x: nx, y: ny, room: roomAt(nx, ny) });
    this.broadcastWorld();
  }

  private handleGoto(client: Client, msg: any) {
    const e = this.focusEntity(client);
    if (!e) return;
    const tx = Math.floor(Number(msg?.x));
    const ty = Math.floor(Number(msg?.y));
    if (!walkable(tx, ty)) return;
    const path = findPath({ x: e.x, y: e.y }, { x: tx, y: ty });
    if (!path || !path.length) return;
    this.walk(e, path, 130);
  }

  private walk(entity: Entity, path: { x: number; y: number }[], stepMs: number) {
    this.stopWalk(entity.id);
    let i = 0;
    const handle = this.clock.setInterval(() => {
      if (i >= path.length) {
        this.stopWalk(entity.id);
        return;
      }
      const step = path[i++];
      entity.x = step.x;
      entity.y = step.y;
      logEvent("move", { who: entity.name, id: entity.id, x: step.x, y: step.y, room: roomAt(step.x, step.y) });
      this.broadcastWorld();
    }, stepMs);
    this.walkers.set(entity.id, handle);
  }

  private stopWalk(entityId: string) {
    this.walkers.get(entityId)?.clear();
    this.walkers.delete(entityId);
  }

  // ---------- chat ----------

  private handleChat(client: Client, msg: any) {
    const text = String(msg?.text || "").trim().slice(0, 500);
    if (!text) return;

    // Admin chat: private line to the TA brain, or speak as Terra.
    if (this.admins.has(client.sessionId)) {
      const mode = msg?.mode === "speak" ? "speak" : "private";
      if (mode === "private") {
        void this.adminPrivateChat(client, text);
      } else {
        this.speakAsTerra(client, text);
      }
      return;
    }

    const p = this.players.get(client.sessionId);
    if (!p) return;
    const rid = roomAt(p.x, p.y) || "commons";
    this.pushHistory(rid, { name: p.name, text });
    this.deliverToRoom(rid, { from: p.name, id: p.id, kind: "human", text });
    logEvent("chat", { who: p.name, room: rid, text });
    this.scheduleReplies(rid, { name: p.name, text });
  }

  // Agents in the room reply: Terra always (the brain), then at most
  // MAX_STUDENT_REPLIES virtual students — a room full of students must
  // not turn one "hello" into one LLM call per head.
  private scheduleReplies(rid: string, sender: { name: string; text: string }) {
    const present = this.agents.filter((a) => roomAt(a.x, a.y) === rid && !a.busy);
    const terra = present.find((a) => a.id === TERRA_ID);
    const students = present.filter((a) => a.id !== TERRA_ID).slice(0, MAX_STUDENT_REPLIES);
    const queue = terra ? [terra, ...students] : students;
    queue.forEach((agent, i) => {
      this.clock.setTimeout(() => void this.agentRespond(agent, rid, sender), 300 + i * 1900);
    });
  }

  private async agentRespond(agent: AgentRuntime, rid: string, sender: { name: string; text: string }) {
    if (agent.busy) return;
    if (roomAt(agent.x, agent.y) !== rid) return; // moved away meanwhile
    agent.busy = true;
    this.sendToRoomClients(rid, "typing", { name: agent.name });
    try {
      let text: string;
      let skill: string | undefined;
      if (agent.id === TERRA_ID) {
        // Terra answers with the real Virtual TA brain, one persistent TA
        // session per student. The room she stands in may force a skill.
        const forced = forcedSkillAt(agent.x, agent.y);
        const res = await taChat(`space:${sender.name}`, sender.text, forced);
        text = res.reply;
        skill = res.skill;
      } else {
        // Virtual students keep the thin local persona.
        const label = roomById(rid)!.label;
        text = await agentReply(agent.def, label, this.occupantNames(rid), this.history.get(rid) || []);
      }
      this.pushHistory(rid, { name: agent.name, text });
      this.deliverToRoom(rid, { from: agent.name, id: agent.id, kind: "agent", text, skill });
      logEvent("chat", { who: agent.name, room: rid, text, agent: true, ...(skill ? { skill } : {}) });
    } catch (err: any) {
      logEvent("agent_error", { who: agent.name, error: String(err?.message || err) });
      this.deliverToRoom(rid, {
        from: agent.name,
        id: agent.id,
        kind: "agent",
        text: agent.id === TERRA_ID ? TA_OFFLINE_MSG : "(sorry — I couldn't reach my language model just now)",
      });
    } finally {
      agent.busy = false;
    }
  }

  // 🔒 Admin ↔ TA brain, visible only to the admin. Terra's room still
  // forces the skill (e.g. stand her in the Prep Room and ask for notes).
  private async adminPrivateChat(client: Client, text: string) {
    const terra = this.terra();
    client.send("chat", { from: "You → Terra", id: "admin", kind: "human", text, room: "private" });
    logEvent("chat", { who: "admin", to: "Terra", text, private: true });
    if (terra.busy) {
      client.send("chat", { from: terra.name, id: terra.id, kind: "agent", text: "(one moment — mid-conversation)", room: "private" });
      return;
    }
    terra.busy = true;
    client.send("typing", { name: terra.name });
    try {
      const forced = forcedSkillAt(terra.x, terra.y);
      const res = await taChat("space:admin", text, forced);
      client.send("chat", { from: terra.name, id: terra.id, kind: "agent", text: res.reply, skill: res.skill, room: "private" });
      logEvent("chat", { who: terra.name, to: "admin", text: res.reply, skill: res.skill, private: true, agent: true });
    } catch (err: any) {
      logEvent("agent_error", { who: terra.name, error: String(err?.message || err) });
      client.send("chat", { from: terra.name, id: terra.id, kind: "agent", text: TA_OFFLINE_MSG, room: "private" });
    } finally {
      terra.busy = false;
    }
  }

  // 🗣 The admin's words come out of Terra, verbatim, in her current room.
  // Virtual students there may respond (it's a human-driven message).
  private speakAsTerra(client: Client, text: string) {
    const terra = this.terra();
    const rid = roomAt(terra.x, terra.y) || "commons";
    this.pushHistory(rid, { name: terra.name, text });
    this.deliverToRoom(rid, { from: terra.name, id: terra.id, kind: "agent", text });
    logEvent("chat", { who: terra.name, room: rid, text, agent: true, spokenByAdmin: true });
    const students = this.agents
      .filter((a) => a.id !== TERRA_ID && roomAt(a.x, a.y) === rid && !a.busy)
      .slice(0, MAX_STUDENT_REPLIES);
    students.forEach((agent, i) => {
      this.clock.setTimeout(() => void this.agentRespond(agent, rid, { name: terra.name, text }), 400 + i * 1900);
    });
  }

  // ---------- admin actions ----------

  private async handleAdmin(client: Client, msg: any) {
    if (!this.admins.has(client.sessionId)) {
      return client.send("adminAck", { ok: false, note: "Admin only — switch role to Admin first." });
    }
    const action = msg?.action;

    // LLM-composed utterance in the agent's current room (any agent).
    if (action === "direct") {
      const agent = this.agents.find((a) => a.def.key === msg?.agent);
      const instruction = String(msg?.instruction || "").trim().slice(0, 1000);
      if (!agent || !instruction) {
        return client.send("adminAck", { ok: false, note: "Pick an agent and write an instruction first." });
      }
      if (agent.busy) {
        return client.send("adminAck", { ok: false, note: `${agent.name} is busy — try again in a moment.` });
      }
      agent.busy = true;
      client.send("adminAck", { ok: true, note: `${agent.name} is composing…` });
      logEvent("admin_direct", { agent: agent.name, instruction });
      try {
        const text = await agentCompose(agent.def, instruction);
        const rid = roomAt(agent.x, agent.y) || agent.def.home;
        this.pushHistory(rid, { name: agent.name, text });
        this.deliverToRoom(rid, { from: agent.name, id: agent.id, kind: "agent", text });
        logEvent("chat", { who: agent.name, room: rid, text, agent: true, directed: true });
        client.send("adminAck", { ok: true, note: `${agent.name} delivered the message.` });
      } catch (err: any) {
        logEvent("agent_error", { who: agent.name, error: String(err?.message || err) });
        client.send("adminAck", { ok: false, note: `${agent.name} couldn't compose: ${String(err?.message || err).slice(0, 120)}` });
      } finally {
        agent.busy = false;
      }
      return;
    }

    // Compose a board post via the announce skill; PREVIEW to the admin.
    if (action === "compose") {
      const terra = this.terra();
      const instruction = String(msg?.instruction || "").trim().slice(0, 1000);
      if (!instruction) return client.send("adminAck", { ok: false, note: "Write an instruction first." });
      if (terra.busy) return client.send("adminAck", { ok: false, note: "Terra is busy — try again in a moment." });
      terra.busy = true;
      client.send("adminAck", { ok: true, note: "Terra is composing the post…" });
      logEvent("admin_compose", { instruction });
      try {
        const res = await taChat("space:admin", instruction, "announce");
        const text = String(res.data?.announcement || res.reply);
        const boardsAvail = ROOMS.filter((r) => r.hasBoard).map((r) => ({ id: r.id, label: r.label }));
        const terraRoom = roomAt(terra.x, terra.y);
        const suggested = terraRoom && roomById(terraRoom)?.hasBoard ? terraRoom : "library";
        client.send("postPreview", { from: terra.name, text, boards: boardsAvail, suggested });
        client.send("adminAck", { ok: true, note: "Preview ready — edit if you like, pick a board, then post." });
      } catch (err: any) {
        logEvent("agent_error", { who: terra.name, error: String(err?.message || err) });
        client.send("adminAck", { ok: false, note: "Terra's brain is unreachable — is the Virtual TA server running on port 3000?" });
      } finally {
        terra.busy = false;
      }
      return;
    }

    // Admin approved the preview: pin it to the chosen room's board.
    if (action === "post") {
      const boardRoom = roomById(String(msg?.board || ""));
      const text = String(msg?.text || "").trim().slice(0, 4000);
      if (!boardRoom?.hasBoard || !text) {
        return client.send("adminAck", { ok: false, note: "Pick a board room and keep some text." });
      }
      const item = postToBoard(boardRoom.id, this.terra().name, text);
      logEvent("board_post", { room: boardRoom.id, by: item.by, text: item.text });
      // Everyone currently in the room sees the board refresh + a notice.
      this.sendBoardToRoomOccupants(boardRoom.id);
      this.deliverToRoom(boardRoom.id, {
        from: this.terra().name,
        id: TERRA_ID,
        kind: "agent",
        text: `(pins a note to the ${boardRoom.label} board)`,
      });
      client.send("adminAck", { ok: true, note: `Posted to the ${boardRoom.label} board.` });
      return;
    }

    if (action === "send") {
      const agent = this.agents.find((a) => a.def.key === msg?.agent);
      const dest = roomById(String(msg?.dest || ""));
      if (!agent || !dest) {
        return client.send("adminAck", { ok: false, note: "Pick an agent and a destination room." });
      }
      const path = findPath({ x: agent.x, y: agent.y }, dest.spawn);
      if (!path) {
        return client.send("adminAck", { ok: false, note: "No path there." });
      }
      logEvent("admin_send", { agent: agent.name, dest: dest.id });
      this.walk(agent, path, 220);
      client.send("adminAck", { ok: true, note: `${agent.name} is walking to the ${dest.label}.` });
    }
  }

  // ---------- lecturer mic → class transcript in the TA brain ----------

  private handleMic(client: Client, msg: any) {
    if (!this.admins.has(client.sessionId)) return;
    const text = String(msg?.text || "").trim().slice(0, 2000);
    if (!text) return;
    // Transcript content is persisted by the TA brain (data/class/);
    // the space log records that lecture audio was flowing, not the words.
    logEvent("mic", { who: "admin", chars: text.length });
    taListen(text).catch((err) => {
      logEvent("mic_error", { error: String(err?.message || err) });
      client.send("adminAck", { ok: false, note: "Mic chunk didn't reach the TA brain — is it running?" });
    });
  }

  // ---------- boards ----------

  // Whenever the world changes, tell any client whose focus entity entered
  // or left a board room what's pinned there.
  private checkBoards() {
    for (const c of this.clients) {
      const e = this.focusEntity(c);
      if (!e) continue;
      const rid = roomAt(e.x, e.y);
      if (this.lastRoom.get(c.sessionId) === rid) continue;
      this.lastRoom.set(c.sessionId, rid);
      const def = rid ? roomById(rid) : undefined;
      if (def?.hasBoard) {
        c.send("board", { roomId: def.id, room: def.label, items: getBoard(def.id) });
      } else {
        c.send("board", { roomId: null });
      }
    }
  }

  private sendBoardToRoomOccupants(rid: string) {
    const def = roomById(rid);
    if (!def?.hasBoard) return;
    for (const c of this.clients) {
      const e = this.focusEntity(c);
      if (e && roomAt(e.x, e.y) === rid) {
        c.send("board", { roomId: def.id, room: def.label, items: getBoard(def.id) });
      }
    }
  }

  // ---------- helpers ----------

  private broadcastWorld() {
    const entities: Entity[] = [
      ...this.players.values(),
      ...this.agents.map((a) => ({ id: a.id, name: a.name, kind: a.kind, color: a.color, x: a.x, y: a.y })),
    ];
    this.broadcast("world", { entities });
    this.checkBoards();
  }

  private occupantNames(rid: string): string[] {
    const names: string[] = [];
    for (const p of this.players.values()) if (roomAt(p.x, p.y) === rid) names.push(p.name);
    for (const a of this.agents) if (roomAt(a.x, a.y) === rid) names.push(a.name);
    return names;
  }

  private pushHistory(rid: string, entry: HistoryEntry) {
    const list = this.history.get(rid);
    if (!list) return;
    list.push(entry);
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  }

  // Send a chat payload to every client whose focus entity is in the room
  // (the admin "hears" whatever room Terra is in).
  private deliverToRoom(
    rid: string,
    payload: { from: string; id: string; kind: string; text: string; skill?: string }
  ) {
    const label = roomById(rid)?.label || rid;
    this.sendToRoomClients(rid, "chat", { ...payload, room: label });
  }

  private sendToRoomClients(rid: string, type: string, payload: any) {
    for (const c of this.clients) {
      const e = this.focusEntity(c);
      if (e && roomAt(e.x, e.y) === rid) c.send(type, payload);
    }
  }
}
