// The whole "plugin API": every skill is (session, message) → SkillResult,
// importing the same shared core (llm, materials, persona, logger).

export interface Artifact {
  path: string; // absolute path on disk
  url?: string; // where the browser can open it, when served
}

export interface SkillResult {
  reply: string;
  artifacts?: Artifact[];
  // Structured payload for programmatic callers (e.g. the virtual space
  // dispatching an announcement) — the chat `reply` is for humans.
  data?: Record<string, unknown>;
}
