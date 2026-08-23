// Who is on the other end of a connection.
//
// In the cloud, Google IAP authenticates the visitor before the request ever
// reaches us. It stamps two things on the request: a plain email header, and
// a signed JWT assertion. We trust the JWT and only the JWT.
//
// The email header is convenient and unsigned — anything that can reach this
// container directly can set it. Behind IAP that is a narrow window, but it
// is not closed, and "anyone who reaches the port is the instructor" is not a
// failure we want to be one misconfiguration away from. The assertion is
// signed by Google over a payload that names *this* service, so replaying one
// from somewhere else does not work either.
//
// Locally there is no IAP, so a development identity stands in.
//
// Env:
//   TRUST_IAP_HEADER=1   we are behind IAP; require and verify the assertion
//   IAP_JWT_AUDIENCE     "/projects/<num>/locations/<region>/services/<svc>"
//                        REQUIRED when TRUST_IAP_HEADER=1 — see the note below
//   IAP_JWKS_URL         override Google's key endpoint (tests only)
//   ADMIN_EMAILS         comma-separated instructor allowlist
//   ROSTER               "a@x.com:Sam,b@y.com:Ben" — avatar display names
//   STUDENTS             "a@x.com=s1" — which student character each address
//                        controls; see roster.ts
//   DEV_USER             identity to assume when not behind IAP

import type { IncomingMessage } from "http";
import { createPublicKey, verify as cryptoVerify, type KeyObject } from "crypto";
import { slotFor } from "./roster";

export interface Identity {
  email: string;
  name: string; // display name on the avatar
  isAdmin: boolean;
}

const IAP_HEADER = "x-goog-authenticated-user-email";
const IAP_JWT_HEADER = "x-goog-iap-jwt-assertion";
const IAP_ISSUER = "https://cloud.google.com/iap";
const JWKS_URL = process.env.IAP_JWKS_URL || "https://www.gstatic.com/iap/verify/public_key-jwk";

const TRUST_IAP = process.env.TRUST_IAP_HEADER === "1";
const AUDIENCE = (process.env.IAP_JWT_AUDIENCE || "").trim();
const DEV_USER = (process.env.DEV_USER || "jade@local").trim().toLowerCase();

// Refuse to start rather than refuse every student at class time. A wrong or
// missing audience makes every login fail, and the symptom (nobody can get in)
// looks nothing like the cause. Crash here, where the deploy log shows it.
if (TRUST_IAP && !AUDIENCE) {
  throw new Error(
    "TRUST_IAP_HEADER=1 but IAP_JWT_AUDIENCE is unset. It must be the Cloud Run " +
      "resource path, e.g. /projects/123456789/locations/us-central1/services/stat689 — " +
      "NOT the OAuth client ID."
  );
}

function csv(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Behind IAP the instructor is whoever is on the allowlist. Locally the
// default dev user is the instructor, so the admin panel keeps working
// out of the box — but any *other* dev identity is an ordinary student,
// which is what makes local multi-user testing meaningful.
//
// This list does more than grant powers: an admin IS the TA and has no
// avatar of their own (MainRoom.onJoin). Adding an address here therefore
// REMOVES that person from the world as a student. Locally that means the
// default dev user has no avatar — use ?as=ana@local to be a student.
const ADMINS = new Set(
  (process.env.ADMIN_EMAILS ? csv(process.env.ADMIN_EMAILS) : TRUST_IAP ? [] : [DEV_USER]).map((e) =>
    e.toLowerCase()
  )
);

// "a@x.com:Sam,b@y.com:Ben" — only the email half is case-folded.
const ROSTER = new Map<string, string>(
  csv(process.env.ROSTER).flatMap((entry) => {
    const i = entry.lastIndexOf(":");
    if (i <= 0) return [];
    const email = entry.slice(0, i).trim().toLowerCase();
    const name = entry.slice(i + 1).trim();
    return email && name ? [[email, name] as [string, string]] : [];
  })
);

// ---------------------------------------------------------------------------
// IAP assertion verification
// ---------------------------------------------------------------------------

const KEY_TTL_MS = 60 * 60 * 1000; // Google rotates slowly; an hour is plenty
// An unknown key id means either a rotation we have not seen yet or a bogus
// token. Both want throttling, but for opposite reasons, and the throttle has
// to be short: it is also the length of the outage when Google really does
// rotate. Five seconds costs a student one reconnect and costs an attacker
// most of their amplification.
const REFETCH_COOLDOWN_MS = 5 * 1000;
const CLOCK_SKEW_S = 30;

let keyCache = new Map<string, KeyObject>();
let keysFetchedAt = 0; // last SUCCESSFUL fetch — drives the TTL
let lastAttemptAt = 0; // last attempt, success or not — drives the throttle
let inFlight: Promise<void> | null = null;
let warnedAudience = false; // the audience diagnostic is logged once, not per student

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function loadKeys(): Promise<void> {
  // Collapse concurrent misses — a burst of joins after a key rotation should
  // fetch once, not once per student.
  if (inFlight) return inFlight;
  lastAttemptAt = Date.now();
  inFlight = (async () => {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error(`IAP key fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: any[] };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys || []) {
      if (!jwk?.kid) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        // A key we cannot parse is not fatal; the others still work.
      }
    }
    if (!next.size) throw new Error("IAP key fetch returned no usable keys");
    keyCache = next;
    keysFetchedAt = Date.now();
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function keyFor(kid: string): Promise<KeyObject> {
  const now = Date.now();
  const stale = now - keysFetchedAt > KEY_TTL_MS; // huge before the first fetch
  const unknown = !keyCache.has(kid);

  // Refetch when the cache has aged out, or when we are asked for a key we
  // have never seen — but throttle on the last ATTEMPT, not the last success,
  // so a stream of bogus kids cannot become a stream of outbound requests.
  if (stale || (unknown && now - lastAttemptAt > REFETCH_COOLDOWN_MS)) await loadKeys();

  const key = keyCache.get(kid);
  if (!key) throw new Error(`IAP assertion signed by unknown key ${kid}`);
  return key;
}

interface IapClaims {
  email: string;
  sub: string;
}

/**
 * Verify an IAP JWT assertion and return its claims.
 *
 * Throws on anything suspicious. Every throw here means "refuse the
 * connection" — there is no partial trust.
 */
export async function verifyIapJwt(token: string): Promise<IapClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("IAP assertion is not a JWT");
  const [rawHeader, rawPayload, rawSig] = parts;

  const header = JSON.parse(b64urlToBuf(rawHeader).toString("utf8"));
  if (header.alg !== "ES256") throw new Error(`unexpected assertion alg ${header.alg}`);
  if (!header.kid) throw new Error("assertion has no key id");

  const key = await keyFor(header.kid);

  // JOSE signatures are raw r||s; Node defaults to DER. Without
  // ieee-p1363 every genuine token fails to verify, which is a very
  // confusing way to lock a class out.
  const ok = cryptoVerify(
    "sha256",
    Buffer.from(`${rawHeader}.${rawPayload}`),
    { key, dsaEncoding: "ieee-p1363" },
    b64urlToBuf(rawSig)
  );
  if (!ok) throw new Error("IAP assertion signature does not verify");

  const claims = JSON.parse(b64urlToBuf(rawPayload).toString("utf8"));
  if (claims.iss !== IAP_ISSUER) throw new Error(`unexpected assertion issuer ${claims.iss}`);

  if (claims.aud !== AUDIENCE) {
    // By far the likeliest misconfiguration, and the least self-evident: the
    // symptom is every student being refused, which looks like IAP is broken
    // rather than like one env var holding the wrong string. Say what was
    // expected and what arrived, so the fix is a copy-paste. Once per process
    // — a whole class failing to log in should not also flood the log.
    if (!warnedAudience) {
      warnedAudience = true;
      console.error(
        "[identity] IAP_JWT_AUDIENCE does not match the assertion.\n" +
          `             expected: ${AUDIENCE || "(unset)"}\n` +
          `             received: ${claims.aud}\n` +
          "             Set IAP_JWT_AUDIENCE to the received value — it is the Cloud Run\n" +
          "             resource path, not the OAuth client ID."
      );
    }
    // Deliberately vague to the caller; the detail is in the server log.
    throw new Error("assertion is for a different service");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) {
    throw new Error("IAP assertion has expired");
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > now) {
    throw new Error("IAP assertion is not valid yet");
  }

  const email = String(claims.email || "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("IAP assertion carries no email");

  return { email, sub: String(claims.sub || "") };
}

// ---------------------------------------------------------------------------

// IAP sends "accounts.google.com:someone@gmail.com". Used only to cross-check
// the verified claim, never as the source of truth.
function parseIapEmail(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  const email = (v.includes(":") ? v.slice(v.lastIndexOf(":") + 1) : v).trim().toLowerCase();
  return email.includes("@") ? email : null;
}

// "sam.chen1998@gmail.com" -> "Sam Chen". A fallback only: ROSTER wins.
function nameFromEmail(email: string): string {
  const local = email.split("@")[0].replace(/[0-9]+/g, "");
  const words = local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return (words.join(" ") || email).slice(0, 24);
}

// Display name, most specific first: an explicit ROSTER entry, then the
// character this student took over (a real student controls "Sam" until we
// know their actual name), then a guess from the address.
function build(email: string): Identity {
  const name = ROSTER.get(email) || slotFor(email)?.name || nameFromEmail(email);
  return { email, name, isAdmin: ADMINS.has(email) };
}

function header(req: IncomingMessage | undefined, name: string): string | undefined {
  const v = req?.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Resolve the identity behind a connection.
 *
 * Behind IAP a missing or unverifiable assertion is a hard failure, not a
 * fallback: it means IAP is misconfigured or someone reached us directly, and
 * letting that through as a default user is exactly the wrong way to fail.
 *
 * `devUser` lets a local client claim an identity (?as=ben@local) so two
 * browser windows can be two students. It is ignored behind IAP.
 */
export async function identify(req?: IncomingMessage, devUser?: unknown): Promise<Identity> {
  if (TRUST_IAP) {
    const token = header(req, IAP_JWT_HEADER);
    if (!token) throw new Error("not authenticated — no IAP assertion on this request");

    const { email } = await verifyIapJwt(token);

    // The unsigned header should agree with the signed claim. A mismatch is
    // not something IAP produces, so it means someone is playing games.
    const claimed = parseIapEmail(header(req, IAP_HEADER));
    if (claimed && claimed !== email) {
      throw new Error("IAP email header disagrees with the signed assertion");
    }
    return build(email);
  }
  const claimed = typeof devUser === "string" ? devUser.trim().toLowerCase() : "";
  return build(claimed && claimed.includes("@") ? claimed : DEV_USER);
}

// One line at startup, so it is never a mystery which mode we are in.
export function identityMode(): string {
  return TRUST_IAP
    ? `IAP, JWT-verified (aud: ${AUDIENCE}; admins: ${[...ADMINS].join(", ") || "none — set ADMIN_EMAILS!"})`
    : `DEV, no auth — everyone is ${DEV_USER} unless ?as=… (admins: ${[...ADMINS].join(", ")})`;
}

// Warm the key cache at boot so the first student does not pay for the fetch,
// and so a broken key endpoint shows up in the startup log rather than as a
// failed login. Best-effort: a failure here is retried on first use.
export function warmIapKeys(): void {
  if (!TRUST_IAP) return;
  void loadKeys().catch((e) => console.warn(`[identity] IAP key preload failed: ${e.message}`));
}
