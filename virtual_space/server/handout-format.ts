// The handout bundle format: types, the content hash, and the validator.
//
// Split out from handouts.ts so that scripts/bundle-handout.ts can import it
// without dragging in the roster, the map and the data directory. The bundler
// is a dev-time tool run against a folder of markdown; it has no business
// needing a valid STUDENTS line to tell you a learning objective drifted.
//
// Both the bundler and the upload route validate through here, so a bundle
// hand-edited after bundling cannot get in through the back door.

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// The bundle — what `npm run bundle:handout` emits and the server reads
// ---------------------------------------------------------------------------

export interface Generation {
  model: string;
  prompt_template: string;
  temperature?: number;
  generated?: string;
}

export interface Body {
  markdown: string;
  /** sha256 of the body only — front-matter excluded, so fixing a typo in an
   *  objective does not invalidate grades on prose that did not change. */
  content_sha: string;
  approach: string;
  generation: Generation;
}

export interface Section {
  section_id: string;
  title: string;
  learning_objective: string;
  /** version_id -> body. Every id in `versions` is present; the bundler refuses
   *  a section that is missing one. */
  bodies: Record<string, Body>;
}

export interface Bundle {
  schema_version: 1;
  handout_id: string;
  title: string;
  chapter: string;
  term: string;
  versions: string[];
  sections: Section[];
}

export function contentSha(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex").slice(0, 16);
}

/**
 * Validate a parsed bundle. Returns a list of problems; empty means good.
 *
 * Shared by the bundler (which refuses to emit) and the upload route (which
 * refuses to store), so a bundle hand-edited after bundling cannot get in
 * through the back door.
 */
export function validateBundle(b: unknown): string[] {
  const p: string[] = [];
  const o = b as Partial<Bundle>;
  if (!o || typeof o !== "object") return ["not an object"];
  if (o.schema_version !== 1) p.push(`schema_version must be 1, got ${JSON.stringify(o.schema_version)}`);
  for (const f of ["handout_id", "title", "chapter", "term"] as const) {
    if (typeof o[f] !== "string" || !o[f]!.trim()) p.push(`${f} is missing`);
  }
  if (o.handout_id && !/^[a-z0-9][a-z0-9-]*$/.test(o.handout_id)) {
    p.push(`handout_id "${o.handout_id}" must be lowercase letters, digits and hyphens`);
  }
  const versions = Array.isArray(o.versions) ? o.versions : [];
  if (!versions.length) p.push("versions is empty");
  if (new Set(versions).size !== versions.length) p.push("versions contains a duplicate");
  const sections = Array.isArray(o.sections) ? o.sections : [];
  if (!sections.length) p.push("sections is empty");

  const seen = new Set<string>();
  for (const s of sections) {
    const id = s?.section_id;
    if (typeof id !== "string" || !id.trim()) {
      p.push("a section has no section_id");
      continue;
    }
    if (seen.has(id)) p.push(`duplicate section_id "${id}"`);
    seen.add(id);
    if (!s.title?.trim()) p.push(`${id}: title is missing`);
    if (!s.learning_objective?.trim()) p.push(`${id}: learning_objective is missing`);
    const bodies = s.bodies && typeof s.bodies === "object" ? s.bodies : {};
    for (const v of versions) {
      const body = bodies[v];
      if (!body) {
        p.push(`${id}: no version "${v}"`);
        continue;
      }
      if (typeof body.markdown !== "string" || !body.markdown.trim()) p.push(`${id}.${v}: body is empty`);
      if (body.content_sha !== contentSha(body.markdown ?? "")) {
        p.push(`${id}.${v}: content_sha does not match the body`);
      }
      if (!body.approach?.trim()) p.push(`${id}.${v}: approach is missing`);
      const g = body.generation;
      if (!g?.model?.trim() || !g?.prompt_template?.trim()) {
        // Provenance is the whole point of the exercise: version_id will mean
        // nothing a term from now, prompt_template is what carries the result.
        p.push(`${id}.${v}: generation needs at least model and prompt_template`);
      }
    }
    for (const v of Object.keys(bodies)) {
      if (!versions.includes(v)) p.push(`${id}: version "${v}" is not declared in versions`);
    }
  }
  return p;
}
