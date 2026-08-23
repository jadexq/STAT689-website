// Hybrid intent router: deterministic short-circuits first, then sticky
// mode, then one cheap LLM classification returning strict JSON. On a
// genuinely ambiguous request it answers "clarify" and the TA asks the
// user which skill they want instead of guessing.

import { jsonLLM } from "./llm.ts";
import type { Session, SkillName } from "./session.ts";

export type RouteResult = SkillName | "clarify";

// The TA has exactly one job now: answer course questions grounded in the
// materials. With one skill there is nothing to route, so route() returns
// before the classification call — one fewer LLM round trip on EVERY student
// message, and its latency and tokens with it. Set to null to bring the
// router back; everything below still works.
export const SINGLE_SKILL: SkillName | null = "coach";

// TEMPORARY: the classroom skill is disabled while it is being reworked.
// Flip to true to reopen — every path below keys off this one flag, and the
// clarify menu / JSON enum / numeric picker all derive from SKILLS.
export const CLASSROOM_ENABLED = false;

// Order matters: the clarify menu is numbered off this list, and the LLM's
// answer is validated against it — so a disabled skill must be absent, not
// merely skipped.
const SKILLS: SkillName[] = CLASSROOM_ENABLED
  ? ["coach", "classroom", "author", "review", "announce"]
  : ["coach", "author", "review", "announce"];

const MENU: Record<SkillName, string> = {
  coach: "**Coach** you through an assigned reading (Socratic style)",
  classroom: "Answer questions about the **live lecture** (flip on classroom listening)",
  author: "**Draft notes or an HTML slide deck**",
  review: "**Review a pull request** in the shared project",
  announce: "Compose a **class-wide announcement** (share a news/paper link, or a reminder)",
};

const PR_PATTERN = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|\b[\w.-]+\/[\w.-]+#\d+\b/i;

const COMMANDS: Record<string, SkillName> = {
  "/coach": "coach",
  ...(CLASSROOM_ENABLED ? { "/class": "classroom" as SkillName } : {}),
  "/notes": "author",
  "/slides": "author",
  "/review": "review",
  "/announce": "announce",
};

export async function route(session: Session, message: string): Promise<RouteResult> {
  if (SINGLE_SKILL) return SINGLE_SKILL;

  const trimmed = message.trim();

  // 1 — short-circuits, no LLM
  const cmd = Object.keys(COMMANDS).find((c) => trimmed.toLowerCase().startsWith(c));
  if (cmd) return COMMANDS[cmd];
  if (PR_PATTERN.test(trimmed)) return "review";
  if (CLASSROOM_ENABLED && session.listening) return "classroom";

  // Answering the clarify menu by number ("1"–"5") picks that skill
  const lastAssistant = [...session.history].reverse().find((m) => m.role === "assistant");
  if (lastAssistant?.content === CLARIFY_REPLY) {
    const pick = trimmed.match(new RegExp(`^([1-${SKILLS.length}])\\b`))?.[1];
    if (pick) return SKILLS[Number(pick) - 1];
  }

  // 2 + 3 — LLM classification, told the sticky mode so it only switches
  // on a clear intent shift
  const system = `You route messages inside a Virtual TA app to exactly one skill.
Skills:
- coach: Socratic coaching on an assigned course reading; discussing or asking about a reading; homework-style conceptual questions; asking what course materials / readings are available.
${CLASSROOM_ENABLED ? "- classroom: questions about what is being said in a live lecture happening right now.\n" : ""}- author: drafting, restructuring or polishing lecture notes, or making an HTML slide deck.
- review: reviewing a pull request / code changes in the shared class project.
- announce: composing a class-wide announcement to all students — sharing an AI news item or paper (usually via a link), or a reminder for the whole class.
${session.mode ? `The conversation is currently in "${session.mode}" mode. Stay in it unless the new message clearly asks for a different skill.` : ""}
If the message is genuinely ambiguous between skills, answer clarify — do not guess.
Reply with ONLY a JSON object: {"skill": ${[...SKILLS, "clarify"].map((x) => `"${x}"`).join(" | ")}}`;

  const result = await jsonLLM(system, [{ role: "user", content: trimmed }]).catch(() => null);
  const skill = result?.skill;
  if (typeof skill === "string" && (SKILLS as string[]).includes(skill)) return skill as SkillName;
  if (skill === "clarify") return "clarify";

  // 4 — malformed output: fall back to the current mode, then coach
  return session.mode ?? "coach";
}

export const CLARIFY_REPLY = `Happy to help — I just want to point us at the right thing. I can:

${SKILLS.map((x, i) => `${i + 1}. ${MENU[x]}`).join("\n")}

Which one do you want? (You can also start a message with ${Object.keys(COMMANDS).join(", ")}.)`;
