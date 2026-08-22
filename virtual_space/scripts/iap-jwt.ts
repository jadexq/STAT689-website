// Verifies the IAP assertion check in server/identity.ts.
//
// The other suites run with TRUST_IAP_HEADER unset, so they exercise the dev
// identity path and never touch this code. Without this script the whole
// verification would ship untested and first meet a real token in class.
//
// Real IAP tokens cannot be minted locally, so this generates its own ES256
// key, serves it as a JWKS, and points identity.ts at that with IAP_JWKS_URL.
// That proves the verification logic — signature, issuer, audience, expiry,
// key rotation — but NOT that Google's tokens satisfy it. The claim shapes
// here were copied from a real assertion captured during the Phase B spike
// (see plan §14l.4); first contact with live IAP is still Phase C.
//
//   npx tsx scripts/iap-jwt.ts

import { createServer, type Server } from "http";
import { generateKeyPairSync, createSign, randomUUID, type KeyObject } from "crypto";
import { AddressInfo } from "net";

const AUDIENCE = "/projects/343454961473/locations/us-central1/services/stat689";
const ISSUER = "https://cloud.google.com/iap";
const EMAIL = "student@example.com";

let pass = 0;
let fail = 0;

function ok(name: string) {
  pass++;
  console.log(`  ok   ${name}`);
}
function bad(name: string, detail: string) {
  fail++;
  console.log(`  FAIL ${name}\n         ${detail}`);
}

// --- a local stand-in for Google's key endpoint ----------------------------

interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const kid = randomUUID().slice(0, 8);
  return { kid, privateKey, jwk: { ...jwk, kid, alg: "ES256", use: "sig" } };
}

// Which keys the JWKS endpoint currently advertises. Mutated to simulate
// Google rotating a key out from under us.
let published: TestKey[] = [];
let jwksHits = 0;

function startJwks(): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      jwksHits++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: published.map((k) => k.jwk) }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/`, server });
    });
  });
}

// --- token minting ---------------------------------------------------------

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface MintOpts {
  key: TestKey;
  aud?: string;
  iss?: string;
  email?: string;
  expDelta?: number; // seconds from now
  iatDelta?: number;
  alg?: string;
  omitEmail?: boolean;
}

function mint(o: MintOpts): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: o.alg ?? "ES256", typ: "JWT", kid: o.key.kid };
  const payload: Record<string, unknown> = {
    aud: o.aud ?? AUDIENCE,
    azp: o.aud ?? AUDIENCE,
    iss: o.iss ?? ISSUER,
    iat: now + (o.iatDelta ?? 0),
    exp: now + (o.expDelta ?? 600),
    identity_source: "GOOGLE",
    sub: "accounts.google.com:105874281318162647779",
  };
  if (!o.omitEmail) payload.email = o.email ?? EMAIL;

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign("sha256").update(signingInput).sign({
    key: o.key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(sig)}`;
}

// --- fake requests ---------------------------------------------------------

function req(headers: Record<string, string>) {
  return { headers } as any;
}

async function rejects(name: string, fn: () => Promise<unknown>, expect?: RegExp) {
  try {
    await fn();
    bad(name, "expected a rejection, got success");
  } catch (e: any) {
    if (expect && !expect.test(e.message)) {
      bad(name, `rejected, but for the wrong reason: ${e.message}`);
    } else {
      ok(name);
    }
  }
}

async function main() {
  const signing = makeKey();
  published = [signing];
  const { url, server } = await startJwks();

  // identity.ts reads its config at import time, so the env must be set first.
  process.env.TRUST_IAP_HEADER = "1";
  process.env.IAP_JWT_AUDIENCE = AUDIENCE;
  process.env.IAP_JWKS_URL = url;
  process.env.ADMIN_EMAILS = "boss@example.com";
  process.env.ROSTER = `${EMAIL}:Sam Chen`;

  const { identify, verifyIapJwt } = await import("../server/identity");

  console.log("IAP assertion verification\n");

  // --- the happy path ------------------------------------------------------
  try {
    const id = await identify(req({ "x-goog-iap-jwt-assertion": mint({ key: signing }) }));
    if (id.email === EMAIL && id.name === "Sam Chen" && id.isAdmin === false) {
      ok("a valid assertion resolves to the roster identity");
    } else {
      bad("a valid assertion resolves to the roster identity", JSON.stringify(id));
    }
  } catch (e: any) {
    bad("a valid assertion resolves to the roster identity", e.message);
  }

  try {
    const id = await identify(
      req({ "x-goog-iap-jwt-assertion": mint({ key: signing, email: "boss@example.com" }) })
    );
    id.isAdmin ? ok("ADMIN_EMAILS is honoured") : bad("ADMIN_EMAILS is honoured", "isAdmin false");
  } catch (e: any) {
    bad("ADMIN_EMAILS is honoured", e.message);
  }

  // --- the reason this change exists --------------------------------------
  await rejects(
    "the email header ALONE is refused (the spoof)",
    () => identify(req({ "x-goog-authenticated-user-email": "accounts.google.com:boss@example.com" })),
    /no IAP assertion/
  );

  await rejects(
    "a header disagreeing with the signed claim is refused",
    () =>
      identify(
        req({
          "x-goog-iap-jwt-assertion": mint({ key: signing }),
          "x-goog-authenticated-user-email": "accounts.google.com:boss@example.com",
        })
      ),
    /disagrees/
  );

  // --- malformed and hostile tokens ---------------------------------------
  await rejects("a token for another service is refused", () =>
    verifyIapJwt(mint({ key: signing, aud: "/projects/1/locations/us-central1/services/other" }))
  );
  await rejects("a wrong issuer is refused", () =>
    verifyIapJwt(mint({ key: signing, iss: "https://evil.example" }))
  );
  await rejects("an expired token is refused", () =>
    verifyIapJwt(mint({ key: signing, expDelta: -120 }))
  );
  await rejects("a not-yet-valid token is refused", () =>
    verifyIapJwt(mint({ key: signing, iatDelta: 600, expDelta: 1200 }))
  );
  await rejects("a token with no email is refused", () =>
    verifyIapJwt(mint({ key: signing, omitEmail: true }))
  );
  await rejects("alg=none is refused", () => {
    const t = mint({ key: signing });
    const [h, p, s] = t.split(".");
    const hdr = JSON.parse(Buffer.from(h, "base64url").toString());
    return verifyIapJwt(`${b64url(JSON.stringify({ ...hdr, alg: "none" }))}.${p}.${s}`);
  });
  await rejects("a tampered payload is refused", () => {
    const [h, p, s] = mint({ key: signing }).split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.email = "boss@example.com";
    return verifyIapJwt(`${h}.${b64url(JSON.stringify(claims))}.${s}`);
  });
  await rejects("garbage is refused", () => verifyIapJwt("not-a-jwt"));

  // --- a signature from a key Google never published -----------------------
  const impostor = makeKey();
  await rejects("a token signed by an unpublished key is refused", () =>
    verifyIapJwt(mint({ key: impostor }))
  );

  // --- key rotation --------------------------------------------------------
  const rotated = makeKey();
  published = [rotated]; // Google swaps its keys

  // Unknown key ids are throttled, so the refetch is refused for a few
  // seconds after any recent attempt. That throttle IS the outage window
  // during a genuine rotation, so assert it is short rather than absent.
  const throttled = jwksHits;
  await rejects("a rotation is throttled immediately after a recent fetch", () =>
    verifyIapJwt(mint({ key: rotated }))
  );
  jwksHits === throttled
    ? ok("...and the throttle really did suppress the request")
    : bad("...and the throttle really did suppress the request", "a fetch went out anyway");

  await new Promise((r) => setTimeout(r, 5_100)); // just past the cooldown

  const before = jwksHits;
  try {
    await verifyIapJwt(mint({ key: rotated }));
    jwksHits > before
      ? ok("once the throttle lapses, the new key is fetched and verifies")
      : bad("once the throttle lapses, the new key is fetched and verifies", "no refetch happened");
  } catch (e: any) {
    bad("once the throttle lapses, the new key is fetched and verifies", e.message);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
