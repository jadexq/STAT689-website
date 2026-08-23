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

const PORT = Number(process.env.PORT || 2567);

const app = express();
// gzip before static: the Phaser bundle is ~1.2 MB minified and ~0.34 MB
// gzipped, and Cloud Run's free tier allows only 1 GiB of egress a month.
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "client", "static")));

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
