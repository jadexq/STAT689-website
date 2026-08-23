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
import { logFilePath } from "./logger";
import { identityMode, warmIapKeys } from "./identity";
import { rosterSummary } from "./roster";
import { taMaterialFile, taMaterials } from "./ta";

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

app.get("/api/materials/:id/file", async (req, res) => {
  try {
    const found = await taMaterialFile(String(req.params.id));
    if (!found) {
      res.status(404).type("text/plain").send("No such reading.");
      return;
    }
    res.setHeader("content-type", found.type);
    res.send(found.bytes);
  } catch (err) {
    console.error(`[space] material file: ${(err as Error).message}`);
    res.status(502).type("text/plain").send("That reading is unavailable right now.");
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
