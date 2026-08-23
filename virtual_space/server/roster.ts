// The class roster: six student characters, one office each.
//
// A slot is a CHARACTER, not a person. Until a real student's address is
// assigned to it the character is played by an AI stand-in; assign the
// address and the same character becomes that student's avatar — same
// office, same name. That is why the placeholder names exist rather than
// being decoration: a real student takes one over, they do not arrive
// alongside it. See plan/app-changes.md, 2026-08-22.
//
// Addresses live in the environment, never in this file. This file is
// tracked in git and student addresses are not ours to publish. Neither are
// their names — which is why ROSTER is parsed HERE rather than in
// identity.ts, and why it drives every surface a name appears on rather than
// only the avatar. See plan/app-changes.md, 2026-08-23.
//
// Slot ids are opaque handles (s1..s6). They deliberately do not look like
// names: STUDENTS="alice@example.com=s6" means "give Alice that office", not
// "call Alice s6", and an id that reads like a name invites the second
// reading.
//
// Env:
//   STUDENTS="alice@example.com=s1,bob@example.com=s2"
//   ROSTER="alice@example.com:Alice"   (display name — required behind IAP
//                                       for every address STUDENTS assigns)

import { roomById } from "./map";

export interface Slot {
  id: string;
  office: string; // room id — their spawn point and where idling returns them
  name: string;
  color: string;
  // Absent means the slot has no AI stand-in: the character exists only when
  // a human signs in for it.
  persona?: string;
}

const TRUST_IAP = process.env.TRUST_IAP_HEADER === "1";

const STUDENT_BASE =
  "a virtual student enrolled in Jade Wang's flipped-classroom course on AI and large language model agents. " +
  "Talk casually like a peer — never like an assistant. Ask questions, react, occasionally admit confusion.";

const trait = (name: string, t: string) => `You are ${name}, ${STUDENT_BASE} ${t}`;

export const SLOTS: Slot[] = [
  { id: "s1", office: "office-s1", name: "Sam",   color: "#ffb454", persona: trait("Sam",   "You are a curious generalist who connects ideas across fields.") },
  { id: "s2", office: "office-s2", name: "Ben",   color: "#6fd08c", persona: trait("Ben",   "You are the friendly skeptic — you ask for evidence and poke at hype.") },
  { id: "s3", office: "office-s3", name: "Chloe", color: "#f4d35e", persona: trait("Chloe", "You are theory-minded and happiest when the math is on the table.") },
  { id: "s4", office: "office-s4", name: "Dev",   color: "#9ad1d4", persona: trait("Dev",   "You are a systems person — GPUs, throughput, and inference costs excite you.") },
  { id: "s5", office: "office-s5", name: "Grace", color: "#ff8fa3", persona: trait("Grace", "You think like a product builder — you ask what users actually need.") },
  // No stand-in, and a placeholder rather than a character name. This slot
  // is held by a real account in every deployment so far, so an AI persona
  // here would only ever be in the way. The placeholder shows on the office
  // door in the one case where the slot is vacant.
  { id: "s6", office: "office-s6", name: "Student 6", color: "#4da3ff" },
];

function csv(raw: string | undefined): string[] {
  return (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// email -> slot id
const ASSIGNED = new Map<string, string>(
  csv(process.env.STUDENTS).flatMap((entry) => {
    const i = entry.lastIndexOf("=");
    if (i <= 0) return [];
    const email = entry.slice(0, i).trim().toLowerCase();
    const slot = entry.slice(i + 1).trim();
    return email.includes("@") && slot ? [[email, slot] as [string, string]] : [];
  })
);

// Refuse to start rather than hand two students the same office and let them
// discover it in class. Same reasoning as the IAP audience check.
for (const [email, id] of ASSIGNED) {
  if (!SLOTS.some((s) => s.id === id)) {
    throw new Error(
      `STUDENTS assigns ${email} to unknown slot "${id}". Valid slots: ${SLOTS.map((s) => s.id).join(", ")}`
    );
  }
}
{
  const seen = new Map<string, string>();
  for (const [email, id] of ASSIGNED) {
    const prev = seen.get(id);
    if (prev) throw new Error(`STUDENTS assigns slot "${id}" to both ${prev} and ${email}`);
    seen.set(id, email);
  }
}

// "a@x.com:Sam,b@y.com:Ben" — only the email half is case-folded, because a
// display name is a name and "tester" is not "Tester".
const ROSTER = new Map<string, string>(
  csv(process.env.ROSTER).flatMap((entry) => {
    const i = entry.lastIndexOf(":");
    if (i <= 0) return [];
    const email = entry.slice(0, i).trim().toLowerCase();
    const name = entry.slice(i + 1).trim();
    return email && name ? [[email, name] as [string, string]] : [];
  })
);

const BY_EMAIL = new Map<string, Slot>();
for (const [email, id] of ASSIGNED) BY_EMAIL.set(email, SLOTS.find((s) => s.id === id)!);

// "sam.chen1998@gmail.com" -> "Sam Chen". A fallback only: ROSTER wins.
function nameFromEmail(email: string): string {
  const local = email.split("@")[0].replace(/[0-9]+/g, "");
  const words = local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return (words.join(" ") || email).slice(0, 24);
}

/**
 * What to call this person, everywhere: the avatar, their office door, the
 * `Roster:` line at startup, and the instructor's handout dashboard.
 *
 * Most specific first — an explicit ROSTER entry, then the character whose
 * slot they took over, then a guess from the address. The whole chain lives
 * here so the four surfaces cannot drift apart again; before 2026-08-23 only
 * the avatar consulted ROSTER and the other three read the character's
 * placeholder, which named nobody once a real person held the slot.
 *
 * Keep names short by convention: an office label is drawn inside a 6x6 room.
 * Nothing enforces it.
 */
export function displayNameFor(email: string): string {
  const e = email.trim().toLowerCase();
  return ROSTER.get(e) || BY_EMAIL.get(e)?.name || nameFromEmail(e);
}

// An assigned address with no ROSTER name would put a character's placeholder
// on a real person's office door and on the instructor's dashboard — silently,
// and looking exactly like it worked. That is the shape of D5b, which cost an
// afternoon. Behind IAP it is a boot failure; locally it is a warning, because
// every test suite assigns slots and none of them care what the avatars are
// called.
{
  const nameless = [...ASSIGNED.keys()].filter((e) => !ROSTER.has(e));
  if (nameless.length) {
    const msg =
      `STUDENTS assigns ${nameless.length} address(es) with no ROSTER name: ${nameless.join(", ")}. ` +
      `Each needs a "<email>:<Name>" pair in ROSTER — the name goes on their avatar, their office ` +
      `door and the handout dashboard.`;
    if (TRUST_IAP) throw new Error(msg);
    console.warn(`! ${msg} Falling back to the slot placeholder.`);
  }
}

// The slots that belong to a real person, in roster order. A slot with no
// address is a character played by an AI, not a student who has not answered —
// which is why this, and not SLOTS.length, is the denominator of a response
// rate.
export function assignedStudents(): { slot: Slot; email: string }[] {
  const out: { slot: Slot; email: string }[] = [];
  for (const slot of SLOTS) {
    const email = emailOf(slot.id);
    if (email) out.push({ slot, email });
  }
  return out;
}

export function slotFor(email: string): Slot | undefined {
  return BY_EMAIL.get(email.trim().toLowerCase());
}

// Slots still played by an AI. A slot with an address belongs to a person,
// whether or not they happen to be online — an office whose occupant is out
// is empty, not staffed by an impostor.
export function standInSlots(): Slot[] {
  return SLOTS.filter((s) => s.persona && !BY_EMAIL.has(emailOf(s.id) ?? ""));
}

function emailOf(slotId: string): string | undefined {
  for (const [email, id] of ASSIGNED) if (id === slotId) return email;
  return undefined;
}

// Where an unassigned human goes. Not into somebody's office: handing a
// stranger a student's room is worse than an unglamorous landing spot.
export const UNASSIGNED_ROOM = "commons";

export function homeRoomFor(email: string): string {
  return slotFor(email)?.office ?? UNASSIGNED_ROOM;
}

export function rosterSummary(): string {
  const held = assignedStudents();
  const ai = standInSlots();
  return (
    `${SLOTS.length} student slots — ${held.length} assigned ` +
    `(${held.map(({ email }) => displayNameFor(email)).join(", ") || "none"}), ` +
    `${ai.length} played by stand-ins (${ai.map((s) => s.name).join(", ") || "none"})`
  );
}

// Fail loudly at boot if a slot names a room that does not exist.
for (const s of SLOTS) {
  if (!roomById(s.office)) throw new Error(`Student slot "${s.id}" names unknown room "${s.office}"`);
}

// The office follows whoever holds the slot. ROOMS is handed to the client
// wholesale and roomById().label feeds every piece of prose about a room, so
// patching the one array covers all of them at once. Doing this in map.ts
// instead would mean map.ts importing this file, which is the cycle the
// import above already rules out.
//
// A vacant slot keeps the placeholder from map.ts — the character is still
// the one whose door it is.
for (const { slot, email } of assignedStudents()) {
  roomById(slot.office)!.label = `${displayNameFor(email)}'s Office`;
}
