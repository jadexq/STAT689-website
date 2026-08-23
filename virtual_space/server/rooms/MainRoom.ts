// The single Colyseus room hosting the whole world. The server is
// authoritative: it owns every position, validates every move, routes
// same-room chat, runs agent replies, and logs everything. AI agents are
// server-side "players" — same entity shape as a human, driven by an LLM.
//
// Identity is established server-side in onAuth (identity.ts) — from the
// IAP header in the cloud, from a dev identity locally. Clients no longer
// name themselves, and one email is one human.
//
// Roles:
//   student — has an avatar; normal chat & movement.
//   admin   — NO avatar; chat is either 🔒 private to the TA brain or
//             🗣 spoken aloud as the TA, in the TA office. Admin-only:
//             direct agents, pin board posts, mic.
//             Determined by the ADMIN_EMAILS allowlist ALONE: an instructor
//             IS the TA, with no student view to switch to. The client has
//             no say — a student asking for admin just gets an avatar.
//
// THE TA DOES NOT MOVE. Not for students, not for the instructor. Every
// conversation with the TA therefore happens in the TA office, which a
// student has to walk into. The instructor drove the TA around until now,
// so this also pins the instructor in place — accepted deliberately: a
// rule that holds only when nobody is looking is not a rule, and the two
// features that depend on it (walk-in access, one student at a time) both
// collapse without it. See plan/app-changes.md, 2026-08-22.
//
// The TA office is a 1:1 room: one student, the TA, nobody else. The
// solo-occupancy count deliberately ignores agents (the TA lives there and
// must not block themself), so keeping the virtual students out is a
// separate rule — enforced on the way in, and again on who may reply.
//
// ONE STUDENT AT A TIME. The TA office admits a single human; the door
// shuts behind them and the next student has to wait. The TA already served
// one caller at a time (AgentRuntime.busy) — the queue existed, it was just
// invisible, and a second student's message vanished into it (open-issues
// E2). This moves the wait to the threshold, where it can be explained.
//
// The TA's replies come from the Virtual TA brain (ta.ts), one session per
// student. Board posts are written by the instructor and pinned to a
// room's board — students see the board when they walk in.

import type { IncomingMessage } from "http";
import { Room, Client } from "colyseus";
import { MAP, TILE, DOORS, ROOMS, walkable, roomAt, roomById, doorOf, findPath } from "../map";
import { AGENTS, TA_ID, AgentDef, agentReply, agentCompose, HistoryEntry } from "../agents";
import { taChat, taListen, type TaWho } from "../ta";
import { getBoard, postToBoard } from "../boards";
import { logEvent } from "../logger";
import { identify, type Identity } from "../identity";

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

// Who an agent is replying to. sessionKey is the TA brain's conversation
// key — absent when the "sender" is another agent (nobody's conversation).
interface Sender {
  name: string;
  text: string;
  who?: TaWho;
}

const HISTORY_LIMIT = 30;
const MAX_STUDENT_REPLIES = 2; // per human message — the TA is exempt
// Cloud Run cuts every connection at 60 minutes and laptops sleep, so a
// dropped socket is routine, not a departure. Hold the seat — and the
// avatar, exactly where it was standing — for this long before cleaning up.
const RECONNECT_WINDOW_S = 120;
// A student who stops talking is sent back to their office, freeing the TA
// for whoever is waiting. Without this the door above is a lockout bug: a
// closed laptop lid holds the only way in indefinitely. Warn first, so
// nobody is teleported mid-thought — typing anything resets the clock.
//
// Distinct from the CLIENT's 15-minute idle park (main.ts IDLE_MS), which
// closes the socket to stop burning a Cloud Run connection. This one is
// about fairness inside one room, so it is much shorter.
const SOLO_WARN_MS = Number(process.env.SOLO_WARN_S || 4 * 60) * 1000;
const SOLO_IDLE_MS = Number(process.env.SOLO_IDLE_S || 5 * 60) * 1000;
const SOLO_SWEEP_MS = 5_000;
const TA_OFFLINE_MSG =
  "(my TA brain isn't reachable — is the Virtual TA server running? `npm run dev` in virtual_ta)";

export class MainRoom extends Room {
  maxClients = 20;
  private players = new Map<string, Entity>();
  private admins = new Set<string>(); // sessionIds granted the admin role
  private identities = new Map<string, Identity>(); // sessionId -> who they are
  private agents: AgentRuntime[] = [];
  private history = new Map<string, HistoryEntry[]>(); // per map-room chat log
  private walkers = new Map<string, { clear: () => void }>(); // entity id -> active walk
  private lastRoom = new Map<string, string | null>(); // client -> room of their focus entity
  private soloRooms = ROOMS.filter((r) => r.soloOccupancy);
  private lastShut = ""; // last broadcast door state, to avoid re-sending it
  private soloIdle = new Map<string, { last: number; warned: boolean }>();

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

    this.clock.setInterval(() => this.sweepSoloRooms(), SOLO_SWEEP_MS);

    logEvent("server_start", { agents: this.agents.map((a) => a.name) });
  }

  // Establishes WHO is connecting. Throwing here refuses the connection,
  // which is the correct outcome when we are behind IAP and no verified
  // identity arrived. `request` carries the IAP header on the WebSocket
  // upgrade; `options.devUser` is honoured only outside IAP.
  async onAuth(_client: Client, options: any, request?: IncomingMessage): Promise<Identity> {
    return identify(request, options?.devUser);
  }

  onJoin(client: Client, _options: any, auth?: Identity) {
    const id = auth ?? (client.auth as Identity);
    this.identities.set(client.sessionId, id);

    // The role follows from the allowlist, not from anything the client
    // asked for. Being unconditional is the point: the old default was
    // "student", so the *instructor* experience was the one you had to
    // remember to request, and board posting looked broken when you had
    // not. A mode you can enter by accident will be entered by accident.
    const isAdmin = id.isAdmin;
    if (isAdmin) {
      this.admins.add(client.sessionId);
      logEvent("join", { who: id.email, id: client.sessionId, role: "admin" });
    } else {
      // A page reload can re-join before the old socket's close is
      // processed, leaving a ghost avatar. One avatar per email: a rejoin
      // replaces the stale entity, while a DIFFERENT person is left alone.
      for (const [sid, old] of this.players) {
        if (sid !== client.sessionId && this.identities.get(sid)?.email === id.email) {
          this.stopWalk(old.id);
          this.players.delete(sid);
          this.lastRoom.delete(sid);
        }
      }
      const home = roomById("office-jade")!;
      const p: Entity = {
        id: client.sessionId,
        name: id.name,
        kind: "human",
        color: "#4da3ff",
        x: home.spawn.x,
        y: home.spawn.y,
      };
      this.players.set(client.sessionId, p);
      logEvent("join", { who: id.email, name: id.name, id: client.sessionId, x: p.x, y: p.y, role: "student" });
    }
    client.send("init", {
      tile: TILE,
      map: MAP,
      doors: DOORS,
      rooms: ROOMS,
      you: isAdmin ? null : client.sessionId,
      role: isAdmin ? "admin" : "student",
      // Redundant with `role` now that the two always agree, but kept as
      // the client-facing proof that asking for admin got an impostor
      // nothing — scripts/multiuser.ts asserts this is false for them.
      isAdmin: id.isAdmin,
      email: id.email,
      name: id.name,
      agents: AGENTS.map((a) => ({ key: a.key, name: a.name })),
      // Current state, because `doors` is only broadcast on change.
      shut: this.soloRooms.filter((r) => !!this.occupantOf(r.id)).map((r) => r.id),
    });
    this.broadcastWorld();
  }

  async onLeave(client: Client, consented?: boolean) {
    const p = this.players.get(client.sessionId);
    // Vacate a solo room IMMEDIATELY, before the reconnect hold. The seat is
    // worth keeping for RECONNECT_WINDOW_S; the door is not — holding it for
    // two minutes on every dropped laptop lid locks everyone else out for a
    // person who is not there.
    if (p && this.soloRooms.some((r) => roomAt(p.x, p.y) === r.id)) {
      this.stopWalk(p.id);
      const home = roomById("office-jade")!;
      p.x = home.spawn.x;
      p.y = home.spawn.y;
      logEvent("solo_vacated", { who: p.name, reason: "disconnect" });
      this.broadcastWorld();
    }
    if (!consented) {
      try {
        await this.allowReconnection(client, RECONNECT_WINDOW_S);
        logEvent("rejoin", { who: p?.name ?? "admin", id: client.sessionId });
        return; // seat resumed — nothing was ever cleaned up
      } catch {
        // window expired; fall through and tidy up
      }
    }
    if (p) logEvent("leave", { who: p.name, id: p.id });
    this.stopWalk(client.sessionId);
    this.players.delete(client.sessionId);
    this.admins.delete(client.sessionId);
    this.identities.delete(client.sessionId);
    this.lastRoom.delete(client.sessionId);
    this.broadcastWorld();
  }

  // The entity a client's input drives / camera watches: their own avatar,
  // or the TA for the admin.
  private focusEntity(client: Client): Entity | undefined {
    return this.players.get(client.sessionId) ?? (this.admins.has(client.sessionId) ? this.ta() : undefined);
  }

  private ta(): AgentRuntime {
    return this.agents.find((a) => a.id === TA_ID)!;
  }

  // The TA brain keys conversations by this string, so it must be stable
  // across reconnects, restarts and cold starts — hence the email, not the
  // Colyseus sessionId. The instructor's private line to the TA is a
  // separate conversation from the same person's student-side chat.
  private taWho(client: Client, kind: "student" | "admin" = "student"): TaWho {
    const id = this.identities.get(client.sessionId);
    const email = id?.email || "unknown";
    return {
      sessionId: kind === "admin" ? `space:admin:${email}` : `space:${email}`,
      email,
      name: id?.name || "unknown",
    };
  }

  // ---------- movement ----------

  private handleStep(client: Client, msg: any) {
    const e = this.focusEntity(client);
    if (!e) return;
    if (this.refuseTAMove(client, e)) return;
    const dx = Math.sign(Number(msg?.dx) || 0);
    const dy = Math.sign(Number(msg?.dy) || 0);
    if (Math.abs(dx) + Math.abs(dy) !== 1) return;
    this.stopWalk(e.id);
    const nx = e.x + dx;
    const ny = e.y + dy;
    if (!walkable(nx, ny)) return;
    if (this.blockedFor(e.id).has(`${nx},${ny}`)) {
      return this.notice(client, this.shutMsg(roomAt(nx, ny) || "office-ta"));
    }
    e.x = nx;
    e.y = ny;
    this.broadcastMove(e);
  }

  private handleGoto(client: Client, msg: any) {
    const e = this.focusEntity(client);
    if (!e) return;
    if (this.refuseTAMove(client, e)) return;
    const tx = Math.floor(Number(msg?.x));
    const ty = Math.floor(Number(msg?.y));
    if (!walkable(tx, ty)) return;
    const blocked = this.blockedFor(e.id);
    if (blocked.has(`${tx},${ty}`)) {
      return this.notice(client, this.shutMsg(roomAt(tx, ty) || "office-ta"));
    }
    const path = findPath({ x: e.x, y: e.y }, { x: tx, y: ty }, blocked);
    if (!path || !path.length) return;
    this.walk(e, path, 130);
  }

  // ---------- solo-occupancy doors ----------

  // Humans only. The TA lives in there, and a virtual student the instructor
  // sends in is not a visitor queueing for the TA's attention.
  private occupantOf(rid: string): Entity | undefined {
    for (const p of this.players.values()) if (roomAt(p.x, p.y) === rid) return p;
    return undefined;
  }

  // Tiles this player may not enter right now. The door alone would be
  // enough today (it is the only way in), but blocking the interior too
  // means the rule still holds if anything ever places an avatar directly.
  private blockedFor(playerId: string): Set<string> {
    const out = new Set<string>();
    for (const r of this.soloRooms) {
      const occ = this.occupantOf(r.id);
      if (!occ || occ.id === playerId) continue; // free, or it is their own
      const d = doorOf(r.id);
      if (d) out.add(`${d.x},${d.y}`);
      for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) out.add(`${x},${y}`);
    }
    return out;
  }

  private shutMsg(rid: string): string {
    const occ = this.occupantOf(rid);
    const label = roomById(rid)?.label ?? rid;
    return `The ${label} door is shut — ${occ ? occ.name : "someone"} is in with the TA. Try again in a few minutes.`;
  }

  // Broadcast only when the set of shut doors CHANGES. Movement is a delta
  // for a reason (see broadcastMove); a per-step door frame would undo that.
  private checkDoors() {
    const shut = this.soloRooms.filter((r) => !!this.occupantOf(r.id)).map((r) => r.id);
    const key = shut.join(",");
    if (key === this.lastShut) return;
    this.lastShut = key;
    this.broadcast("doors", { shut });
  }

  private clientOf(entityId: string): Client | undefined {
    return this.clients.find((c) => c.sessionId === entityId);
  }

  // Send an idle occupant home so the next student can get in.
  private sweepSoloRooms() {
    const now = Date.now();
    const occupants = new Set<string>();
    for (const r of this.soloRooms) {
      const occ = this.occupantOf(r.id);
      if (!occ) continue;
      occupants.add(occ.id);
      // First sight of them in here starts the clock — walking in counts as
      // activity, so nobody is warned the instant they arrive.
      const st = this.soloIdle.get(occ.id) ?? { last: now, warned: false };
      this.soloIdle.set(occ.id, st);
      const idle = now - st.last;
      const c = this.clientOf(occ.id);
      if (idle >= SOLO_IDLE_MS) {
        this.soloIdle.delete(occ.id);
        const home = roomById("office-jade")!;
        const path = findPath({ x: occ.x, y: occ.y }, home.spawn);
        if (c) this.notice(c, `You have been quiet for a while, so the ${r.label} is being freed for the next student. Walk back in any time.`);
        logEvent("solo_vacated", { who: occ.name, room: r.id, reason: "idle" });
        if (path && path.length) this.walk(occ, path, 130);
        else {
          occ.x = home.spawn.x;
          occ.y = home.spawn.y;
          this.broadcastWorld();
        }
      } else if (idle >= SOLO_WARN_MS && !st.warned) {
        st.warned = true;
        const left = Math.max(1, Math.round((SOLO_IDLE_MS - idle) / 1000));
        if (c) this.notice(c, `Still there? Say something in the next ${left}s or the ${r.label} will be freed for the next student.`);
      }
    }
    for (const id of [...this.soloIdle.keys()]) if (!occupants.has(id)) this.soloIdle.delete(id);
  }

  // The one place the "TA never moves" rule is enforced. Both movement
  // handlers and the admin's "walk there" go through here, so a future
  // caller that forgets is a compile-time miss, not a silent hole.
  private refuseTAMove(client: Client, e: Entity): boolean {
    if (e.id !== TA_ID) return false;
    this.notice(client, "The TA stays in the TA office — walk in to talk to them.");
    return true;
  }

  private notice(client: Client, text: string) {
    client.send("notice", { text });
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
      // Re-checked every step, not just at the start: the room can be
      // claimed by someone closer while this walk is still in progress.
      if (entity.kind === "human" && this.blockedFor(entity.id).has(`${step.x},${step.y}`)) {
        this.stopWalk(entity.id);
        const c = this.clientOf(entity.id);
        if (c) this.notice(c, this.shutMsg(roomAt(step.x, step.y) || "office-ta"));
        return;
      }
      entity.x = step.x;
      entity.y = step.y;
      this.broadcastMove(entity);
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

    // Admin chat: private line to the TA brain, or speak as the TA.
    if (this.admins.has(client.sessionId)) {
      const mode = msg?.mode === "speak" ? "speak" : "private";
      if (mode === "private") {
        void this.adminPrivateChat(client, text);
      } else {
        this.speakAsTA(client, text);
      }
      return;
    }

    const p = this.players.get(client.sessionId);
    if (!p) return;
    const rid = roomAt(p.x, p.y) || "commons";
    // Speaking is what counts as being present — not moving. Someone
    // reading a long answer is idle by the mouse's measure but not by the
    // one that matters, which is why the warning comes first.
    this.soloIdle.set(client.sessionId, { last: Date.now(), warned: false });
    this.pushHistory(rid, { name: p.name, text });
    this.deliverToRoom(rid, { from: p.name, id: p.id, kind: "human", text });
    logEvent("chat", { who: p.name, room: rid, text });
    this.scheduleReplies(rid, { name: p.name, text, who: this.taWho(client) });
  }

  // Agents in the room reply: the TA always (the brain), then at most
  // MAX_STUDENT_REPLIES virtual students — a room full of students must
  // not turn one "hello" into one LLM call per head.
  private scheduleReplies(rid: string, sender: Sender) {
    const present = this.agents.filter(
      (a) => roomAt(a.x, a.y) === rid && !a.busy && (a.id === TA_ID || !roomById(rid)?.soloOccupancy)
    );
    const ta = present.find((a) => a.id === TA_ID);
    const students = present.filter((a) => a.id !== TA_ID).slice(0, MAX_STUDENT_REPLIES);
    const queue = ta ? [ta, ...students] : students;
    queue.forEach((agent, i) => {
      this.clock.setTimeout(() => void this.agentRespond(agent, rid, sender), 300 + i * 1900);
    });
  }

  private async agentRespond(agent: AgentRuntime, rid: string, sender: Sender) {
    if (agent.busy) return;
    if (roomAt(agent.x, agent.y) !== rid) return; // moved away meanwhile
    agent.busy = true;
    this.sendToRoomClients(rid, "typing", { name: agent.name });
    try {
      let text: string;
      let skill: string | undefined;
      // Which course documents the answer was grounded in. Reported by the
      // brain rather than asked of the model in prose: a citation the model
      // has to remember to write is a citation it will sometimes skip.
      let sources: string[] | undefined;
      if (agent.id === TA_ID) {
        // The TA answers with the real Virtual TA brain, one persistent TA
        // session per student. No skill is forced from here any more — the
        // brain has one skill, so there is nothing to choose.
        const who = sender.who ?? { sessionId: `space:${sender.name}`, email: "", name: sender.name };
        const res = await taChat(who, sender.text);
        text = res.reply;
        skill = res.skill;
        const src = (res.data as any)?.sources;
        if (Array.isArray(src) && src.length) sources = src.map(String).slice(0, 3);
      } else {
        // Virtual students keep the thin local persona.
        const label = roomById(rid)!.label;
        text = await agentReply(agent.def, label, this.occupantNames(rid), this.history.get(rid) || []);
      }
      this.pushHistory(rid, { name: agent.name, text });
      this.deliverToRoom(rid, { from: agent.name, id: agent.id, kind: "agent", text, skill, sources });
      logEvent("chat", { who: agent.name, room: rid, text, agent: true, ...(skill ? { skill } : {}) });
    } catch (err: any) {
      logEvent("agent_error", { who: agent.name, error: String(err?.message || err) });
      this.deliverToRoom(rid, {
        from: agent.name,
        id: agent.id,
        kind: "agent",
        text: agent.id === TA_ID ? TA_OFFLINE_MSG : "(sorry — I couldn't reach my language model just now)",
      });
    } finally {
      agent.busy = false;
    }
  }

  // 🔒 Admin ↔ TA brain, visible only to the admin.
  private async adminPrivateChat(client: Client, text: string) {
    const ta = this.ta();
    client.send("chat", { from: "You → TA", id: "admin", kind: "human", text, room: "private" });
    logEvent("chat", { who: "admin", to: "TA", text, private: true });
    if (ta.busy) {
      client.send("chat", { from: ta.name, id: ta.id, kind: "agent", text: "(one moment — mid-conversation)", room: "private" });
      return;
    }
    ta.busy = true;
    client.send("typing", { name: ta.name });
    try {
      const res = await taChat(this.taWho(client, "admin"), text);
      const src = (res.data as any)?.sources;
      client.send("chat", {
        from: ta.name, id: ta.id, kind: "agent", text: res.reply, skill: res.skill, room: "private",
        ...(Array.isArray(src) && src.length ? { sources: src.map(String).slice(0, 3) } : {}),
      });
      logEvent("chat", { who: ta.name, to: "admin", text: res.reply, skill: res.skill, private: true, agent: true });
    } catch (err: any) {
      logEvent("agent_error", { who: ta.name, error: String(err?.message || err) });
      client.send("chat", { from: ta.name, id: ta.id, kind: "agent", text: TA_OFFLINE_MSG, room: "private" });
    } finally {
      ta.busy = false;
    }
  }

  // 🗣 The admin's words come out of the TA, verbatim, in the TA office —
  // which is where any student talking to the TA already is.
  private speakAsTA(client: Client, text: string) {
    const ta = this.ta();
    const rid = roomAt(ta.x, ta.y) || "commons";
    this.pushHistory(rid, { name: ta.name, text });
    this.deliverToRoom(rid, { from: ta.name, id: ta.id, kind: "agent", text });
    logEvent("chat", { who: ta.name, room: rid, text, agent: true, spokenByAdmin: true });
    const students = roomById(rid)?.soloOccupancy
      ? [] // a 1:1 room stays 1:1 even when the instructor is the one talking
      : this.agents
          .filter((a) => a.id !== TA_ID && roomAt(a.x, a.y) === rid && !a.busy)
          .slice(0, MAX_STUDENT_REPLIES);
    students.forEach((agent, i) => {
      this.clock.setTimeout(() => void this.agentRespond(agent, rid, { name: ta.name, text }), 400 + i * 1900);
    });
  }

  // ---------- admin actions ----------

  private async handleAdmin(client: Client, msg: any) {
    if (!this.admins.has(client.sessionId)) {
      return client.send("adminAck", { ok: false, note: "Admin only — this account is not on the instructor list." });
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

    // Pin the instructor's own text to a room's board. There is no compose
    // step: the announce skill used to draft this, which meant a board post
    // could not be made without an LLM round trip, and the wording was the
    // model's rather than the instructor's. Typing it is faster and exact.
    if (action === "post") {
      const boardRoom = roomById(String(msg?.board || ""));
      const text = String(msg?.text || "").trim().slice(0, 4000);
      if (!boardRoom?.hasBoard || !text) {
        return client.send("adminAck", { ok: false, note: "Pick a board room and keep some text." });
      }
      const item = postToBoard(boardRoom.id, this.ta().name, text);
      logEvent("board_post", { room: boardRoom.id, by: item.by, text: item.text });
      // Everyone currently in the room sees the board refresh + a notice.
      this.sendBoardToRoomOccupants(boardRoom.id);
      this.deliverToRoom(boardRoom.id, {
        from: this.ta().name,
        id: TA_ID,
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
      if (agent.id === TA_ID) {
        return client.send("adminAck", { ok: false, note: "The TA stays in the TA office. Send a virtual student instead." });
      }
      if (dest.soloOccupancy) {
        return client.send("adminAck", { ok: false, note: `The ${dest.label} is for one student and the TA — ${agent.name} can't go in.` });
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

  // One entity moved one tile. Sending the whole roster for this is what
  // made movement the dominant cost: 12 entities x 7 clients x ~7 steps a
  // second is ~1 KB per step per client, and Cloud Run's free tier allows
  // 1 GiB of egress a month. A delta is ~31 bytes. Joins, leaves and
  // teleports still send the full world.
  private broadcastMove(entity: { id: string; x: number; y: number }) {
    this.broadcast("moved", { id: entity.id, x: entity.x, y: entity.y });
    this.checkBoards();
    this.checkDoors();
  }

  private broadcastWorld() {
    const entities: Entity[] = [
      ...this.players.values(),
      ...this.agents.map((a) => ({ id: a.id, name: a.name, kind: a.kind, color: a.color, x: a.x, y: a.y })),
    ];
    this.broadcast("world", { entities });
    this.checkBoards();
    this.checkDoors();
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
  // (the admin "hears" whatever room the TA is in).
  private deliverToRoom(
    rid: string,
    payload: { from: string; id: string; kind: string; text: string; skill?: string; sources?: string[] }
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
