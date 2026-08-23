// The AI inhabitants: a stand-in for each unclaimed student character
// (thin local personas, defined in roster.ts) and the TA, whose replies come
// from the Virtual TA brain — see ta.ts / MainRoom.
//
// Agents never move and never speak unprompted: they reply when spoken to in
// their own room, or when the instructor directs them.

import { chatLLM } from "./llm";
import { standInSlots } from "./roster";

export interface AgentDef {
  id: string;
  key: string; // short handle used by the admin panel
  name: string;
  color: string;
  home: string; // room id of their office
  persona: string;
}

export const AGENTS: AgentDef[] = [
  // One per student character still played by a stand-in. A slot with a real
  // address assigned has no agent: that office belongs to a person now.
  ...standInSlots().map((s) => ({
    id: `agent-${s.name.toLowerCase()}`,
    key: s.name.toLowerCase(),
    name: s.name,
    color: s.color,
    home: s.office,
    persona: s.persona!,
  })),
  {
    id: "agent-ta",
    key: "ta",
    name: "TA",
    color: "#8f6fe8",
    home: "office-ta",
    persona:
      "You are the TA for Jade Wang's flipped-classroom course on AI and large language model agents. Students address you simply as \"TA\". You are warm, encouraging, and knowledgeable.",
  },
];

export const TA_ID = "agent-ta";

const COMMON_RULES =
  "You are an avatar inside a small 2D virtual campus (student offices, a common area, a classroom, a prep room, a library, and a computer lab). " +
  "Speak in plain conversational text — no markdown, no bullet lists, no emojis, no stage directions. " +
  "Keep replies to 1-3 short sentences unless the situation clearly calls for more.";

export interface HistoryEntry {
  name: string;
  text: string;
}

// Reply to the ongoing conversation in the agent's current room.
export async function agentReply(
  def: AgentDef,
  roomLabel: string,
  occupants: string[],
  history: HistoryEntry[]
): Promise<string> {
  const others = occupants.filter((n) => n !== def.name);
  const system =
    `${def.persona}\n\n${COMMON_RULES}\n` +
    `You are currently in the ${roomLabel}. Also here: ${others.join(", ") || "no one"}.`;
  const transcript = history
    .slice(-16)
    .map((m) => `${m.name}: ${m.text}`)
    .join("\n");
  const user =
    `Recent conversation in the ${roomLabel}:\n${transcript}\n\n` +
    `Write ${def.name}'s next message. Output only the message text — no name prefix.`;
  return chatLLM(system, [{ role: "user", content: user }], 250);
}

// Compose an in-room utterance on the admin's instruction.
export async function agentCompose(def: AgentDef, instruction: string): Promise<string> {
  const system =
    `${def.persona}\n\n${COMMON_RULES}\n` +
    "The course instructor (admin) can direct you privately; others never see the instruction, only your message.";
  const user =
    `The instructor privately directs you: "${instruction}"\n\n` +
    `Compose the single message you will now say aloud in the room you are standing in. Output only the message text — no name prefix, no preamble.`;
  return chatLLM(system, [{ role: "user", content: user }], 400);
}
