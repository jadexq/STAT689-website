// Who is on the other end of a connection.
//
// In the cloud, Google IAP authenticates the visitor before the request
// ever reaches us and stamps their address on it. Locally there is no IAP,
// so a development identity stands in.
//
// The header is trusted ONLY when TRUST_IAP_HEADER=1. That is deliberate:
// a header any client can set is not a login, and during development this
// server is reachable directly. Getting this backwards would mean anyone
// could claim to be the instructor by setting one HTTP header.
//
// Env:
//   TRUST_IAP_HEADER=1   we are behind IAP; the header is authoritative
//   ADMIN_EMAILS         comma-separated instructor allowlist
//   ROSTER               "a@x.com:Sam,b@y.com:Ben" — avatar display names
//   DEV_USER             identity to assume when not behind IAP

import type { IncomingMessage } from "http";

export interface Identity {
  email: string;
  name: string; // display name on the avatar
  isAdmin: boolean;
}

const IAP_HEADER = "x-goog-authenticated-user-email";
const TRUST_IAP = process.env.TRUST_IAP_HEADER === "1";
const DEV_USER = (process.env.DEV_USER || "jade@local").trim().toLowerCase();

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

// IAP sends "accounts.google.com:someone@gmail.com".
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

function build(email: string): Identity {
  return { email, name: ROSTER.get(email) || nameFromEmail(email), isAdmin: ADMINS.has(email) };
}

/**
 * Resolve the identity behind a connection.
 *
 * Behind IAP a missing header is a hard failure, not a fallback: it means
 * IAP is misconfigured, and letting an unauthenticated visitor through as
 * a default user is exactly the wrong way to fail.
 *
 * `devUser` lets a local client claim an identity (?as=ben@local) so two
 * browser windows can be two students. It is ignored behind IAP.
 */
export function identify(req?: IncomingMessage, devUser?: unknown): Identity {
  if (TRUST_IAP) {
    const email = parseIapEmail(req?.headers?.[IAP_HEADER]);
    if (!email) throw new Error("not authenticated — no IAP identity on this request");
    return build(email);
  }
  const claimed = typeof devUser === "string" ? devUser.trim().toLowerCase() : "";
  return build(claimed && claimed.includes("@") ? claimed : DEV_USER);
}

// One line at startup, so it is never a mystery which mode we are in.
export function identityMode(): string {
  return TRUST_IAP
    ? `IAP (admins: ${[...ADMINS].join(", ") || "none — set ADMIN_EMAILS!"})`
    : `DEV, no auth — everyone is ${DEV_USER} unless ?as=… (admins: ${[...ADMINS].join(", ")})`;
}
