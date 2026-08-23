// Entry point: express serves the client, Colyseus runs the world.
// Everything lives on localhost (MVP requirement M1).

import "./env"; // MUST be first — see env.ts
import path from "path";
import fs from "fs/promises";
import { createServer } from "http";
import express from "express";
import compression from "compression";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { MainRoom } from "./rooms/MainRoom";
import { logEvent, logFilePath } from "./logger";
import { identify, identityMode, warmIapKeys } from "./identity";
import { rosterSummary } from "./roster";
import { taAgenda, taMaterialFile, taMaterials, taUpload } from "./ta";
import { renderMarkdownPage } from "./render";
import {
  listBundles,
  loadBundle,
  loadStudentFile,
  resolveAssignment,
  safeId,
  saltState,
  saveBundle,
  studentHash,
  studentIndex,
  validateBundle,
  type Bundle,
} from "./handouts";
import { renderHandoutPage } from "./handout-render";

const PORT = Number(process.env.PORT || 2567);

const app = express();
// gzip before static: the Phaser bundle is ~1.2 MB minified and ~0.34 MB
// gzipped, and Cloud Run's free tier allows only 1 GiB of egress a month.
app.use(compression());
// Handout bundles are the one large JSON body this server takes: six versions
// of five sections is a couple of hundred kilobytes, well past body-parser's
// 100 kB default. It has to be registered BEFORE the global parser — the first
// parser to run sets req._body and every later one returns early, so a bigger
// limit declared on the route itself would never be reached.
app.use("/api/handouts", express.json({ limit: "8mb" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "client", "static")));
// KaTeX's stylesheet and ~1 MB of woff2, served straight from the installed
// package. Copying them into client/static/ would put a megabyte of binaries
// in git for no gain: katex is a runtime dependency, so `npm prune --omit=dev`
// in the Dockerfile leaves it in place. Handout pages are the only pages that
// link it, and the browser caches it after the first one.
app.use(
  "/katex",
  express.static(path.join(path.dirname(require.resolve("katex/package.json")), "dist"), {
    maxAge: "7d",
    immutable: true,
  })
);

// ---------- the course corpus, proxied ----------
// The readings live with the TA and only the TA indexes them, but the TA's
// port binds to 127.0.0.1 and Cloud Run exposes exactly one port — this one.
// So everything a student clicks is served from here. Express 4 does not
// forward async rejections, hence the explicit try/catch on both routes.

app.get("/api/materials", async (_req, res) => {
  try {
    res.json({ readings: await taMaterials() });
  } catch (err) {
    // The Library degrades to "shelf unavailable" rather than to a broken
    // page: the TA brain being down must not take the campus with it.
    console.error(`[space] materials list: ${(err as Error).message}`);
    res.status(502).json({ readings: [], error: "The reading list is unavailable right now." });
  }
});

// ---------- the project repositories ----------
// Config, not a board post: a pinned link would die with the next
// boards.json wipe (open-issues D7 wipes state before the first class),
// and a repo list is the sort of thing that should survive that. Read from
// disk per request rather than at boot, so editing repos.json is an edit,
// not a restart — the same reasoning as the readings manifest.

interface RepoCard {
  name: string;
  description: string;
  url: string;
}

app.get("/api/repos", async (_req, res) => {
  try {
    const raw = await fs.readFile(path.join(__dirname, "repos.json"), "utf8");
    const parsed = JSON.parse(raw) as { repos?: RepoCard[] };
    const repos = (parsed.repos ?? []).filter((r) => r?.name && r?.url);
    res.json({ repos });
  } catch (err) {
    // A missing or malformed repos.json is an empty Computer Lab card, not a
    // 500: the room still works, it just has nothing to show.
    console.error(`[space] repos: ${(err as Error).message}`);
    res.json({ repos: [] });
  }
});

app.get("/api/agenda", async (_req, res) => {
  try {
    res.json(await taAgenda());
  } catch (err) {
    console.error(`[space] agenda: ${(err as Error).message}`);
    res.status(502).json({ rows: [], problems: [] });
  }
});

app.get("/api/materials/:id/file", async (req, res) => {
  try {
    const found = await taMaterialFile(String(req.params.id));
    if (!found) {
      res.status(404).type("text/plain").send("No such reading.");
      return;
    }
    // .md is rendered here; .html and .pdf are passed through untouched,
    // because for those two the file already IS the presentation.
    if (found.type.startsWith("text/markdown")) {
      const list = await taMaterials().catch(() => []);
      const title = list.find((r) => r.id === req.params.id)?.title ?? "Course reading";
      res.type("html").send(renderMarkdownPage(title, found.bytes.toString("utf8")));
      return;
    }
    res.setHeader("content-type", found.type);
    res.send(found.bytes);
  } catch (err) {
    console.error(`[space] material file: ${(err as Error).message}`);
    res.status(502).type("text/plain").send("That reading is unavailable right now.");
  }
});

// Uploading a reading is the one write on this side of the proxy, so it is
// the one place the HTTP surface needs an identity check. Behind IAP that is
// a signed assertion; locally it is the dev user. Without this any student
// could put a document into the corpus and have the TA cite it as course
// material — the TA treats every reading as authoritative, which is the whole
// point of the corpus and exactly why writing to it is the instructor's alone.
app.post("/api/materials", express.raw({ type: "*/*", limit: "20mb" }), async (req, res) => {
  let who;
  try {
    // ?as=… is the same local-testing override the websocket side honours,
    // and identify() ignores it behind IAP. It is what makes "a student
    // cannot upload" a thing the suite can actually assert.
    who = await identify(req, req.query.as);
  } catch {
    res.status(401).json({ ok: false, note: "Could not verify who you are." });
    return;
  }
  if (!who.isAdmin) {
    logEvent("upload_denied", { email: who.email });
    res.status(403).json({ ok: false, note: "Only the instructor can add course material." });
    return;
  }
  try {
    const q = req.query as Record<string, string>;
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await taUpload(q, bytes);
    logEvent("material_upload", { by: who.email, id: q.id, bytes: bytes.length, ok: result.ok });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    console.error(`[space] upload: ${(err as Error).message}`);
    res.status(502).json({ ok: false, note: "The corpus is unavailable right now." });
  }
});

// ---------- feedback handouts ----------
// The instructor writes handouts outside the app and uploads one bundle each.
// This is the second write on the browser-reachable side after 2e's reading
// upload, and it carries the same guard for the same reason — except that a
// handout is also the thing students are graded against, so a forged one is
// worse than a forged reading.

app.post("/api/handouts", async (req, res) => {
  let who;
  try {
    who = await identify(req, req.query.as);
  } catch {
    res.status(401).json({ ok: false, note: "Could not verify who you are." });
    return;
  }
  if (!who.isAdmin) {
    logEvent("handout_upload_denied", { email: who.email });
    res.status(403).json({ ok: false, note: "Only the instructor can add a handout." });
    return;
  }
  const salt = saltState();
  if (!salt.ok) {
    res.status(503).json({ ok: false, note: salt.note });
    return;
  }
  try {
    const bundle = req.body as Bundle;
    // Validated here and not only in the bundler: a bundle hand-edited after
    // bundling must not get in through the back door.
    const problems = validateBundle(bundle);
    if (problems.length) {
      res.status(400).json({ ok: false, note: "That bundle is not valid.", problems });
      return;
    }
    await saveBundle(bundle);
    logEvent("handout_upload", {
      by: who.email,
      id: bundle.handout_id,
      sections: bundle.sections.length,
      versions: bundle.versions.length,
    });
    // Re-uploading the same handout_id replaces the content and leaves the
    // responses in place. That is deliberate — it is how a typo gets fixed —
    // and it is exactly why every record carries a content hash.
    res.json({
      ok: true,
      handout_id: bundle.handout_id,
      sections: bundle.sections.length,
      versions: bundle.versions.length,
    });
  } catch (err) {
    console.error(`[space] handout upload: ${(err as Error).message}`);
    res.status(500).json({ ok: false, note: "Could not store that handout." });
  }
});

// The list a reader may open, for the 📝 Handouts panel. Every handout goes to
// every student — the versions differ, the reading list does not — so this is
// "what exists", plus how far this reader has got with each.
app.get("/api/handouts", async (req, res) => {
  try {
    const who = await identify(req, req.query.as).catch(() => null);
    if (!who) {
      res.status(401).json({ handouts: [] });
      return;
    }
    const salt = saltState();
    if (!salt.ok) {
      res.status(503).json({ handouts: [], note: salt.note });
      return;
    }
    const bundles = await listBundles();
    const offRoster = !who.isAdmin && studentIndex(who.email) === undefined;
    const hash = offRoster || who.isAdmin ? null : studentHash(who.email);
    const handouts = [];
    for (const b of bundles) {
      const file = hash ? await loadStudentFile(b.handout_id, hash) : null;
      handouts.push({
        id: b.handout_id,
        title: b.title,
        chapter: b.chapter,
        term: b.term,
        sections: b.sections.length,
        graded: file ? Object.keys(file.records).length : 0,
      });
    }
    res.json({
      handouts,
      // The panel shows in the reader's home room, which for anyone unassigned
      // is the Common Area — so this is the one place they find out why the
      // links will not open, rather than discovering it on a 403.
      ...(offRoster
        ? { note: "You are not on the class roster yet, so no version has been assigned to you. Tell the instructor." }
        : {}),
    });
  } catch (err) {
    console.error(`[space] handout list: ${(err as Error).message}`);
    res.status(500).json({ handouts: [] });
  }
});

// The handout itself. Identity decides the version, and the version is written
// down at first render rather than recomputed — see resolveAssignment().
app.get("/handout/:id", async (req, res) => {
  const page = (status: number, msg: string) =>
    res.status(status).type("html").send(renderMarkdownPage("Handout", msg));
  let who;
  try {
    who = await identify(req, req.query.as);
  } catch {
    page(401, "# Not signed in\n\nCould not verify who you are.");
    return;
  }
  try {
    const salt = saltState();
    if (!salt.ok) {
      page(503, `# Handouts are unavailable\n\n${salt.note}`);
      return;
    }
    const id = safeId(req.params.id);
    const bundle = id ? await loadBundle(id) : null;
    if (!bundle) {
      page(404, "# No such handout\n\nThat handout does not exist, or has not been uploaded yet.");
      return;
    }
    const a = await resolveAssignment(bundle, who.email, who.isAdmin, req.query.version);
    if (a.kind === "off-roster") {
      // Loudly, and not by quietly handing over slot 0's rotation: two people
      // on one rotation destroys the balance the whole design rests on.
      logEvent("handout_off_roster", { email: who.email, id: bundle.handout_id });
      page(
        403,
        `# You are not on the class roster\n\n**${who.email}** has no student slot, so no version of ` +
          `this handout has been assigned to you.\n\nThis is a one-line fix on the instructor's side ` +
          `(the \`STUDENTS\` setting) — tell them which address you signed in with.`
      );
      return;
    }
    logEvent("handout_open", {
      email: who.email,
      id: bundle.handout_id,
      mode: a.kind,
      ...(a.kind === "preview" ? { version: a.version } : {}),
    });
    res.type("html").send(
      renderHandoutPage({
        bundle,
        assigned: a.kind === "student" ? a.assigned : {},
        preview: a.kind === "preview" ? a.version : undefined,
      })
    );
  } catch (err) {
    console.error(`[space] handout page: ${(err as Error).message}`);
    page(500, "# That handout could not be opened\n\nTry again in a moment.");
  }
});

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});
gameServer.define("main", MainRoom);

httpServer.listen(PORT, () => {
  console.log(`Virtual Space running at http://localhost:${PORT}`);
  console.log(`Session log: ${logFilePath()}`);
  console.log(`Auth: ${identityMode()}`);
  console.log(`Roster: ${rosterSummary()}`);
  console.log(`Handouts: ${saltState().note}`);
  warmIapKeys(); // fetch IAP's signing keys now, not on the first student
  console.log(`LLM provider: ${process.env.LLM_PROVIDER || "ollama"} (${process.env.OLLAMA_MODEL || "gpt-oss:120b"})`);
});
