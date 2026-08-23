// Validate a handout source folder and emit one bundle file.
//
//   npm run bundle:handout ~/STAT689-handouts/nanogpt-attention
//
// Input (plan/handout-authoring.md):
//
//   nanogpt-attention/
//   ├── handout.json
//   ├── prompts.md                 ← not bundled; it is yours to keep
//   └── sections/<section_id>.<version_id>.md
//
// Output: <folder>.handout.json, next to the folder. Upload that.
//
// This is the validator as much as the bundler, and it REFUSES rather than
// warns on anything that would produce a clean-looking dataset labelled
// wrong. The one thing it only warns about is a length spread between
// versions, because that is a judgement call — a code-first version is
// legitimately shorter — where a drifting learning objective never is.
//
// It imports handout-format.ts and nothing else from the server: no roster,
// no data directory, no .env. Running it must not depend on the app being
// configured.

import fs from "fs/promises";
import path from "path";
import { parse as parseYaml } from "yaml";
import { contentSha, validateBundle, type Body, type Bundle, type Section } from "../server/handout-format";

const LENGTH_SPREAD_WARN = 0.2;

interface Meta {
  handout_id: string;
  title: string;
  chapter: string;
  term: string;
  versions: string[];
  sections: string[];
}

const problems: string[] = [];
const warnings: string[] = [];
const bad = (m: string) => problems.push(m);

/** Split `---\n…\n---\n` front-matter from the body. */
function splitFrontMatter(raw: string): { front: unknown; body: string } | null {
  // Tolerate a BOM and CRLF, both of which arrive from editors rather than
  // from anything the author did wrong.
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const front = text.slice(4, end + 1);
  const rest = text.slice(end + 4).replace(/^[ \t]*\n/, "");
  try {
    return { front: parseYaml(front), body: rest };
  } catch (e) {
    // A hand-rolled parser would silently truncate a folded scalar here.
    // A real one says which line.
    throw new Error(`front-matter is not valid YAML: ${(e as Error).message}`);
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: npm run bundle:handout -- <folder>");
    process.exit(2);
  }
  const root = path.resolve(dir);

  let meta: Meta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(root, "handout.json"), "utf8")) as Meta;
  } catch (e) {
    console.error(`✗ cannot read ${path.join(root, "handout.json")}: ${(e as Error).message}`);
    process.exit(1);
  }

  const versions = Array.isArray(meta.versions) ? meta.versions.map(String) : [];
  const declared = Array.isArray(meta.sections) ? meta.sections.map(String) : [];
  if (new Set(declared).size !== declared.length) bad("handout.json lists a section_id twice");

  const sectionsDir = path.join(root, "sections");
  let files: string[];
  try {
    files = (await fs.readdir(sectionsDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    console.error(`✗ no sections/ folder in ${root}`);
    process.exit(1);
  }

  // section_id -> version_id -> parsed file
  const parsed = new Map<string, Map<string, { front: any; body: string; file: string }>>();

  for (const file of files) {
    const stem = file.slice(0, -3);
    const dot = stem.lastIndexOf(".");
    if (dot <= 0) {
      bad(`${file}: name must be <section_id>.<version_id>.md`);
      continue;
    }
    const fileSection = stem.slice(0, dot);
    const fileVersion = stem.slice(dot + 1);
    const raw = await fs.readFile(path.join(sectionsDir, file), "utf8");
    let split;
    try {
      split = splitFrontMatter(raw);
    } catch (e) {
      bad(`${file}: ${(e as Error).message}`);
      continue;
    }
    if (!split) {
      bad(`${file}: no --- front-matter block at the top of the file`);
      continue;
    }
    const front = (split.front ?? {}) as Record<string, unknown>;

    // A filename that disagrees with the front-matter is the mistake that
    // produces a clean-looking dataset labelled wrong — the file is stored
    // under one id and read under another. Refuse, do not guess which is right.
    if (str(front.section_id) !== fileSection) {
      bad(`${file}: front-matter section_id "${str(front.section_id)}" does not match the filename`);
      continue;
    }
    if (str(front.version_id) !== fileVersion) {
      bad(`${file}: front-matter version_id "${str(front.version_id)}" does not match the filename`);
      continue;
    }
    if (!declared.includes(fileSection)) {
      bad(`${file}: section "${fileSection}" is not listed in handout.json`);
      continue;
    }
    if (!versions.includes(fileVersion)) {
      bad(`${file}: version "${fileVersion}" is not listed in handout.json`);
      continue;
    }
    if (!split.body.trim()) {
      bad(`${file}: the body is empty`);
      continue;
    }
    let byVersion = parsed.get(fileSection);
    if (!byVersion) parsed.set(fileSection, (byVersion = new Map()));
    byVersion.set(fileVersion, { front, body: split.body, file });
  }

  const sections: Section[] = [];

  for (const [sectionIndex, sectionId] of declared.entries()) {
    const byVersion = parsed.get(sectionId);
    if (!byVersion) {
      bad(`${sectionId}: declared in handout.json but no files found`);
      continue;
    }
    const missing = versions.filter((v) => !byVersion.has(v));
    if (missing.length) bad(`${sectionId}: missing version(s) ${missing.join(", ")}`);

    // Title and objective must be byte-identical across versions. The title
    // because a student must not be able to tell which version they got; the
    // objective because it is the prompt half of every derived preference
    // pair, and a pair whose two sides carry different objectives is not a pair.
    const titles = new Set<string>();
    const objectives = new Set<string>();
    const bodies: Record<string, Body> = {};
    const lengths: number[] = [];

    for (const v of versions) {
      const p = byVersion.get(v);
      if (!p) continue;
      const title = str(p.front.title);
      const objective = str(p.front.learning_objective);
      const approach = str(p.front.approach);
      if (!title) bad(`${p.file}: title is missing`);
      if (!objective) bad(`${p.file}: learning_objective is missing`);
      if (!approach) bad(`${p.file}: approach is missing — it is what you are actually testing`);
      titles.add(title);
      objectives.add(objective);

      const g = (p.front.generation ?? {}) as Record<string, unknown>;
      const model = str(g.model);
      const template = str(g.prompt_template);
      if (!model || !template) {
        // version_id will mean nothing a term from now; prompt_template is the
        // only field that carries which generation strategy produced this.
        bad(`${p.file}: generation needs model and prompt_template`);
      }

      const markdown = p.body.trim() + "\n";
      lengths.push(markdown.length);
      bodies[v] = {
        markdown,
        content_sha: contentSha(markdown),
        approach,
        generation: {
          model,
          prompt_template: template,
          ...(g.temperature !== undefined ? { temperature: Number(g.temperature) } : {}),
          ...(g.generated !== undefined ? { generated: String(g.generated) } : {}),
        },
      };
    }

    if (titles.size > 1) {
      bad(`${sectionId}: title differs between versions (${[...titles].map((t) => JSON.stringify(t)).join(" vs ")})`);
    }
    if (objectives.size > 1) {
      bad(`${sectionId}: learning_objective differs between versions — copy it, do not let a model rewrite it`);
    }
    if (lengths.length > 1) {
      const lo = Math.min(...lengths);
      const hi = Math.max(...lengths);
      if (lo > 0 && (hi - lo) / hi > LENGTH_SPREAD_WARN) {
        warnings.push(
          `${sectionId}: ${Math.round(((hi - lo) / hi) * 100)}% length spread (${lo}–${hi} chars). ` +
            `Length is a confound: longer reads as more thorough.`
        );
      }
    }

    sections.push({
      section_id: sectionId,
      title: [...titles][0] ?? "",
      learning_objective: [...objectives][0] ?? "",
      bodies,
    });
    void sectionIndex;
  }

  const bundle: Bundle = {
    schema_version: 1,
    handout_id: str(meta.handout_id),
    title: str(meta.title),
    chapter: str(meta.chapter),
    term: str(meta.term),
    versions,
    sections,
  };

  // Everything above is about the FOLDER; this is about the bundle. Only run
  // it when the folder checks passed, or it reports the same faults twice.
  if (!problems.length) problems.push(...validateBundle(bundle));

  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s) — nothing was written:\n`);
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }

  const out = `${root}.handout.json`;
  await fs.writeFile(out, JSON.stringify(bundle, null, 2), "utf8");
  const cells = sections.length * versions.length;
  console.log(
    `✓ ${bundle.handout_id}: ${sections.length} section(s) × ${versions.length} version(s) = ${cells} cells` +
      `${warnings.length ? `, ${warnings.length} warning(s)` : ""}`
  );
  console.log(`  ${out}`);
}

main().catch((err) => {
  console.error(`✗ ${err.message || err}`);
  process.exit(1);
});
