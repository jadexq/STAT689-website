#!/usr/bin/env node
// Durable storage for a container with an ephemeral filesystem.
//
// The apps keep appending JSONL to local disk exactly as they always have —
// logger.ts, session.ts and boards.ts are untouched. This process is the
// only thing that talks to Cloud Storage, and it does so rarely:
//
//   restore : download <prefix>/current.tar.gz once, before the servers start
//   watch   : upload the whole tree when it changes, at most every FLUSH_MS,
//             plus one dated archive a day, plus one final flush on SIGTERM
//
// Why not mount the bucket with GCS FUSE: every fs.appendFile becomes a full
// object rewrite, GCS allows ~1 update/second/object, and the free tier
// allows 5,000 writes a month. A probe run drew 358 HTTP 429s and did not
// finish 2,000 appends in 9 minutes. See the deployment plan, §14a/§14f.
//
// Why no @google-cloud/storage: two operations do not justify ~10 MB of
// image. The metadata server hands out a token and the JSON API takes it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR?.trim();
const URI = process.env.SNAPSHOT_URI?.trim();
const FLUSH_MS = Number(process.env.SNAPSHOT_FLUSH_MS || 120_000); // §14j: 2 minutes
const CHECK_MS = Number(process.env.SNAPSHOT_CHECK_MS || 30_000);
const WARN_BYTES = 200 * 1024 * 1024; // the container filesystem is RAM

const log = (m) => console.log(`[sync] ${m}`);
const warn = (m) => console.warn(`[sync] ${m}`);

// ---------------------------------------------------------------- backends

// file:///abs/path — used by the tests, and by anyone who wants durability
// without a cloud account.
function fileBackend(root) {
  const at = (name) => path.join(root, name);
  return {
    describe: `file://${root}`,
    async get(name) {
      try {
        return await fsp.readFile(at(name));
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    async put(name, buf) {
      await fsp.mkdir(path.dirname(at(name)), { recursive: true });
      await fsp.writeFile(at(name), buf);
    },
  };
}

// gs://bucket/prefix — the JSON API, authenticated by the instance's own
// service account. Works on Cloud Run with no key material anywhere.
function gcsBackend(bucket, prefix) {
  let cached = { token: null, expires: 0 };

  async function token() {
    if (cached.token && Date.now() < cached.expires - 60_000) return cached.token;
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`metadata server ${res.status}`);
    const j = await res.json();
    cached = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    return cached.token;
  }

  const key = (name) => encodeURIComponent(prefix ? `${prefix}/${name}` : name);

  return {
    describe: `gs://${bucket}/${prefix}`,
    async get(name) {
      const res = await fetch(
        `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${key(name)}?alt=media`,
        { headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(120_000) },
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GCS GET ${name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async put(name, buf) {
      const res = await fetch(
        `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o` +
          `?uploadType=media&name=${key(name)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${await token()}`,
            "content-type": "application/gzip",
          },
          body: buf,
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!res.ok) throw new Error(`GCS PUT ${name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
  };
}

function backendFor(uri) {
  if (uri.startsWith("gs://")) {
    const rest = uri.slice(5).replace(/\/+$/, "");
    const i = rest.indexOf("/");
    return i === -1 ? gcsBackend(rest, "") : gcsBackend(rest.slice(0, i), rest.slice(i + 1));
  }
  if (uri.startsWith("file://")) return fileBackend(uri.slice(7));
  throw new Error(`SNAPSHOT_URI must start with gs:// or file:// (got ${uri})`);
}

// ------------------------------------------------------------------- tar

function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`)),
    );
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

const pack = () => run("tar", ["-czf", "-", "-C", DATA_DIR, "."]);
const unpack = (buf) => run("tar", ["-xzf", "-", "-C", DATA_DIR], { input: buf });

// --------------------------------------------------------------- tree scan

// Newest mtime and total size across the tree. A few hundred small files —
// cheap enough to walk every 30 seconds.
async function scan(dir) {
  let newest = 0;
  let bytes = 0;
  let files = 0;
  async function walk(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        newest = Math.max(newest, st.mtimeMs);
        bytes += st.size;
        files++;
      }
    }
  }
  await walk(dir);
  return { newest, bytes, files };
}

// ------------------------------------------------------------------ modes

async function restore(be) {
  const { files } = await scan(DATA_DIR);
  if (files > 0) {
    log(`${DATA_DIR} already holds ${files} files — leaving it alone, not restoring`);
    return;
  }
  const buf = await be.get("current.tar.gz");
  if (!buf) {
    log(`no snapshot at ${be.describe} yet — starting fresh`);
    return;
  }
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await unpack(buf);
  const after = await scan(DATA_DIR);
  log(`restored ${after.files} files (${(after.bytes / 1024).toFixed(0)} KB) from ${be.describe}`);
}

async function watch(be) {
  let lastSeen = (await scan(DATA_DIR)).newest;
  let lastFlush = 0;
  let lastDaily = null;
  log(`watching ${DATA_DIR} -> ${be.describe}, flushing at most every ${FLUSH_MS / 1000}s`);

  async function flush(reason) {
    const { newest, bytes, files } = await scan(DATA_DIR);
    const started = Date.now();
    const buf = await pack();
    await be.put("current.tar.gz", buf);
    lastSeen = newest;
    lastFlush = Date.now();

    // One dated archive a day, so a bad snapshot cannot silently erase the
    // semester. Object versioning would cost a version per flush.
    const day = new Date().toISOString().slice(0, 10);
    if (lastDaily !== day) {
      await be.put(`daily/${day}.tar.gz`, buf);
      lastDaily = day;
      log(`daily archive written for ${day}`);
    }
    if (bytes > WARN_BYTES) {
      warn(`${DATA_DIR} is ${(bytes / 1048576).toFixed(0)} MB — the container filesystem is RAM`);
    }
    log(
      `flushed (${reason}): ${files} files, ${(bytes / 1024).toFixed(0)} KB -> ` +
        `${(buf.length / 1024).toFixed(0)} KB gz in ${Date.now() - started}ms`,
    );
  }

  const timer = setInterval(async () => {
    try {
      const { newest } = await scan(DATA_DIR);
      if (newest <= lastSeen) return; // nothing changed: an idle room costs nothing
      if (Date.now() - lastFlush < FLUSH_MS) return; // debounce
      await flush("changed");
    } catch (e) {
      warn(`flush failed, will retry: ${e.message}`);
    }
  }, CHECK_MS);

  let closing = false;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      log(`${sig} — final flush`);
      try {
        await flush(sig.toLowerCase());
      } catch (e) {
        warn(`final flush failed: ${e.message}`);
      }
      process.exit(0);
    });
  }
}

// ------------------------------------------------------------------- main

const mode = process.argv[2];
if (!["restore", "watch"].includes(mode)) {
  console.error("usage: sync.mjs restore|watch   (env: DATA_DIR, SNAPSHOT_URI)");
  process.exit(2);
}
if (!DATA_DIR) {
  console.error("[sync] DATA_DIR is not set — refusing to guess");
  process.exit(2);
}
if (!URI) {
  log("SNAPSHOT_URI not set — durable sync disabled (fine for local development)");
  process.exit(0);
}

const be = backendFor(URI);
try {
  if (mode === "restore") await restore(be);
  else await watch(be);
} catch (e) {
  console.error(`[sync] ${mode} failed: ${e.message}`);
  // A restore failure must not strand the class behind a boot loop; a watch
  // failure is fatal, because silently not backing up is worse than a restart.
  process.exit(mode === "restore" ? 0 : 1);
}
