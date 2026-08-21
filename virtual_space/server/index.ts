// Entry point: express serves the client, Colyseus runs the world.
// Everything lives on localhost (MVP requirement M1).

import path from "path";
import dotenv from "dotenv";
// Load .env from the project folder regardless of where the process is launched.
dotenv.config({ path: path.join(__dirname, "..", ".env") });
import { createServer } from "http";
import express from "express";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { MainRoom } from "./rooms/MainRoom";
import { logFilePath } from "./logger";

const PORT = Number(process.env.PORT || 2567);

const app = express();
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
  console.log(`LLM provider: ${process.env.LLM_PROVIDER || "ollama"} (${process.env.OLLAMA_MODEL || "gpt-oss:120b"})`);
});
