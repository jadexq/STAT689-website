// Entry point: express serves the client, Colyseus runs the world.
// Everything lives on localhost (MVP requirement M1).

import "./env"; // MUST be first — see env.ts
import path from "path";
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

const PORT = Number(process.env.PORT || 2567);

const app = express();
// gzip before static: the Phaser bundle is ~1.2 MB minified and ~0.34 MB
// gzipped, and Cloud Run's free tier allows only 1 GiB of egress a month.
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "client", "static")));

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
    who = await identify(req);
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
  warmIapKeys(); // fetch IAP's signing keys now, not on the first student
  console.log(`LLM provider: ${process.env.LLM_PROVIDER || "ollama"} (${process.env.OLLAMA_MODEL || "gpt-oss:120b"})`);
});
