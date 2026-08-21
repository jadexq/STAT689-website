// Hybrid intent router: deterministic short-circuits first, then sticky
// mode, then one cheap LLM classification returning strict JSON. On a
// genuinely ambiguous request it answers "clarify" and the TA asks the
// user which skill they want instead of guessing.

import { jsonLLM } from "./llm.ts";
import type { Session, SkillName } from "./session.ts";

export type RouteResult = SkillName | "clarify";

const SKILLS: SkillName[] = ["coach", "classroom", "author", "review", "announce"];

const PR_PATTERN = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|\b[\w.-]+\/[\w.-]+#\d+\b/i;

const COMMANDS: Record<string, SkillName> = {
  "/coach": "coach",
  "/class": "classroom",
  "/notes": "author",
  "/slides": "author",
  "/review": "review",
  "/announce": "announce",
};

export async function route(session: Session, message: string): Promise<RouteResult> {
  const trimmed = message.trim();

  // 1 — short-circuits, no LLM
  const cmd = Object.keys(COMMANDS).find((c) => trimmed.toLowerCase().startsWith(c));
  if (cmd) return COMMANDS[cmd];
  if (PR_PATTERN.test(trimmed)) return "review";
  if (session.listening) return "classroom";

  // Answering the clarify menu by number ("1"–"5") picks that skill
  const lastAssistant = [...session.history].reverse().find((m) => m.role === "assistant");
  if (lastAssistant?.content === CLARIFY_REPLY) {
    const pick = trimmed.match(/^([1-5])\b/)?.[1];
    if (pick) return SKILLS[Number(pick) - 1];
  }

  // 2 + 3 — LLM classification, told the sticky mode so it only switches
  // on a clear intent shift
  const system = `You route messages inside a Virtual TA app to exactly one skill.
Skills:
- coach: Socratic coaching on an assigned course reading; discussing or asking about a reading; homework-style conceptual questions; asking what course materials / readings are available.
- classroom: questions about what is being said in a live lecture happening right now.
- author: drafting, restructuring or polishing lecture notes, or making an HTML slide deck.
- review: reviewing a pull request / code changes in the shared class project.
- announce: composing a class-wide announcement to all students — sharing an AI news item or paper (usually via a link), or a reminder for the whole class.
${session.mode ? `The conversation is currently in "${session.mode}" mode. Stay in it unless the new message clearly asks for a different skill.` : ""}
If the message is genuinely ambiguous between skills, answer clarify — do not guess.
Reply with ONLY a JSON object: {"skill": "coach" | "classroom" | "author" | "review" | "clarify"}`;

  const result = await jsonLLM(system, [{ role: "user", content: trimmed }]).catch(() => null);
  const skill = result?.skill;
  if (typeof skill === "string" && (SKILLS as string[]).includes(skill)) return skill as SkillName;
  if (skill === "clarify") return "clarify";

  // 4 — malformed output: fall back to the current mode, then coach
  return session.mode ?? "coach";
}

export const CLARIFY_REPLY = `Happy to help — I just want to point us at the right thing. I can:

1. **Coach** you through an assigned reading (Socratic style)
2. Answer questions about the **live lecture** (flip on classroom listening)
3. **Draft notes or an HTML slide deck**
4. **Review a pull request** in the shared project
5. Compose a **class-wide announcement** (share a news/paper link, or a reminder)

Which one do you want? (You can also start a message with /coach, /notes, /slides, /review, or /announce.)`;
