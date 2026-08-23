// The class roster: six student characters, one office each.
//
// A slot is a CHARACTER, not a person. Until a real student's address is
// assigned to it the character is played by an AI stand-in; assign the
// address and the same character becomes that student's avatar — same
// office, same name. That is why the five names are placeholders rather
// than decoration: a real student takes one over, they do not arrive
// alongside it. See plan/app-changes.md, 2026-08-22.
//
// Addresses live in the environment, never in this file. This file is
// tracked in git and student addresses are not ours to publish.
//
// Env:
//   STUDENTS="alice@example.com=s1,bob@example.com=s2"
//   ROSTER="alice@example.com:Alice Chen"   (display name; overrides the
//                                            character's placeholder name)

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
  // The instructor's own test-student account. No stand-in: an AI "Jade"
  // next to an instructor called Jade would be a needless confusion, and
  // this slot is never vacant in practice.
  { id: "jade", office: "office-jade", name: "Jade", color: "#4da3ff" },
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

const BY_EMAIL = new Map<string, Slot>();
for (const [email, id] of ASSIGNED) BY_EMAIL.set(email, SLOTS.find((s) => s.id === id)!);

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
  const held = SLOTS.filter((s) => emailOf(s.id));
  const ai = standInSlots();
  return (
    `${SLOTS.length} student slots — ${held.length} assigned (${held.map((s) => s.name).join(", ") || "none"}), ` +
    `${ai.length} played by stand-ins (${ai.map((s) => s.name).join(", ") || "none"})`
  );
}

// Fail loudly at boot if a slot names a room that does not exist.
for (const s of SLOTS) {
  if (!roomById(s.office)) throw new Error(`Student slot "${s.id}" names unknown room "${s.office}"`);
}
