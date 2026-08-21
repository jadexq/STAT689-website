// The AI inhabitants: ten virtual students (thin local personas) and
// Terra, the virtual TA (whose replies come from the Virtual TA brain —
// see ta.ts / MainRoom). Per the v1 rules, agents only reply when spoken
// to in their room or when the admin directs them — no autonomy.

import { chatLLM } from "./llm";

export interface AgentDef {
  id: string;
  key: string; // short handle used by the admin panel
  name: string;
  color: string;
  home: string; // room id of their office
  persona: string;
}

const STUDENT_BASE =
  "a virtual student enrolled in Jade Wang's flipped-classroom course on AI and large language model agents. " +
  "Talk casually like a peer — never like an assistant. Ask questions, react, occasionally admit confusion.";

// name, office, color, one-line personality
const STUDENTS: [string, string, string, string][] = [
  ["Sam",   "office-s1",  "#ffb454", "You are a curious generalist who connects ideas across fields."],
  ["Ava",   "office-s2",  "#ff8fa3", "You love AI art and vision models, and always bring up images and diffusion."],
  ["Ben",   "office-s3",  "#6fd08c", "You are the friendly skeptic — you ask for evidence and poke at hype."],
  ["Chloe", "office-s4",  "#f4d35e", "You are theory-minded and happiest when the math is on the table."],
  ["Dev",   "office-s5",  "#9ad1d4", "You are a systems person — GPUs, throughput, and inference costs excite you."],
  ["Emma",  "office-s6",  "#e6a4f4", "You come from linguistics and care about language, meaning, and tokenization."],
  ["Felix", "office-s7",  "#f28b66", "You are into robotics and embodied agents, and relate everything to acting in the world."],
  ["Grace", "office-s8",  "#a3d977", "You think like a product builder — you ask what users actually need."],
  ["Hana",  "office-s9",  "#ffd166", "You are the diligent note-taker who summarizes and keeps the group on track."],
  ["Ivan",  "office-s10", "#8ecae6", "You are a competitive programmer who reaches for code and benchmarks first."],
];

export const AGENTS: AgentDef[] = [
  ...STUDENTS.map(([name, home, color, trait]) => ({
    id: `agent-${name.toLowerCase()}`,
    key: name.toLowerCase(),
    name,
    color,
    home,
    persona: `You are ${name}, ${STUDENT_BASE} ${trait}`,
  })),
  {
    id: "agent-terra",
    key: "ta",
    name: "Terra",
    color: "#8f6fe8",
    home: "office-ta",
    persona:
      "You are Terra, the virtual TA for Jade Wang's flipped-classroom course on AI and large language model agents. You are warm, encouraging, and knowledgeable.",
  },
];

export const TERRA_ID = "agent-terra";

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
