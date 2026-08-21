// Review skill (M10): fetch a pull request's diff from the shared class
// project via the GitHub REST API (read-only; GITHUB_TOKEN only needed for
// private repos) and return constructive, line-referenced feedback in the
// chat. v1 never posts back to GitHub.

import { chatLLM } from "../llm.ts";
import { BASE_PERSONA } from "../persona.ts";
import type { Session } from "../session.ts";
import type { SkillResult } from "./types.ts";

const URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;
const SHORT_RE = /\b([\w.-]+)\/([\w.-]+)#(\d+)\b/;
const MAX_DIFF_CHARS = 40_000;

export async function review(session: Session, message: string): Promise<SkillResult> {
  const text = message.replace(/^\/review\s*/i, "").trim() || message.trim();

  const m = text.match(URL_RE) ?? text.match(SHORT_RE);
  if (!m) {
    return {
      reply: "Point me at the pull request — a GitHub URL (`https://github.com/owner/repo/pull/123`) or the short form (`owner/repo#123`) — and I'll review the diff.",
    };
  }
  const [, owner, repo, num] = m;

  const headers: Record<string, string> = {
    "user-agent": "virtual-ta",
    accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${num}`;

  const metaRes = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(30_000) });
  if (!metaRes.ok) {
    const hint =
      metaRes.status === 404
        ? "Double-check the owner/repo/number — and if the repo is private, add a read-only GITHUB_TOKEN to .env."
        : `GitHub answered HTTP ${metaRes.status}.`;
    return { reply: `I couldn't fetch that PR (${owner}/${repo}#${num}). ${hint}` };
  }
  const meta: any = await metaRes.json();

  const diffRes = await fetch(apiUrl, {
    headers: { ...headers, accept: "application/vnd.github.diff" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!diffRes.ok) return { reply: `Got the PR metadata but not its diff (HTTP ${diffRes.status}) — try again in a moment.` };
  let diff = await diffRes.text();
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }

  const system = `${BASE_PERSONA}

You are in REVIEW mode, reviewing a pull request on the shared class project before it merges. Be a constructive senior reviewer for students:
- Start with a 2–3 sentence summary of what the PR does, then what's done well.
- Then concrete issues, each citing the file (and the changed line or hunk) it refers to, ordered by importance: correctness first, then design, then style. Suggest the fix, don't just point.
- Ask a question rather than asserting when the intent is unclear from the diff alone.
- End with a clear verdict: ready to merge, needs changes (list the must-fixes), or needs discussion.
${truncated ? "- NOTE: the diff was truncated for length; say so and review what is visible." : ""}`;

  const prompt = `PR ${owner}/${repo}#${num}: "${meta.title}"
Author: ${meta.user?.login} · +${meta.additions}/−${meta.deletions} across ${meta.changed_files} file(s)
Description: ${(meta.body || "(none)").slice(0, 1500)}

DIFF:
${diff}`;

  const reply = await chatLLM(system, [{ role: "user", content: prompt }], {
    maxTokens: 1800,
    temperature: 0.4,
  });
  return { reply };
}
