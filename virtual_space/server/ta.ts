// HTTP client for the Virtual TA "brain" (virtual_ta,
// its own server on localhost:3000). The space gives the TA a body;
// these calls give the body its mind. Server-to-server on localhost —
// the browser never talks to the TA directly.

const TA_BASE = (process.env.TA_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

export interface TaChatResult {
  reply: string;
  skill: string;
  data?: Record<string, unknown> | null;
}

// Who is speaking, so the TA can write it onto the turn it logs. The
// conversation log is the course's durable record; it should name the
// student rather than make the reader decode a session key.
export interface TaWho {
  sessionId: string;
  email: string;
  name: string;
}

// One chat turn with the brain. `skill` (optional) bypasses the TA's
// intent router — used for the room-based modes (classroom/prep/broadcast).
export async function taChat(
  who: TaWho,
  message: string,
  skill?: string,
): Promise<TaChatResult> {
  const res = await fetch(`${TA_BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: who.sessionId,
      message,
      who: { email: who.email, name: who.name },
      ...(skill ? { skill } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`TA brain HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as TaChatResult;
}

// Forward one chunk of the lecturer's mic transcript to the class-wide
// transcript in the TA brain.
export async function taListen(text: string): Promise<void> {
  const res = await fetch(`${TA_BASE}/api/listen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "space:class", scope: "class", text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`TA listen HTTP ${res.status}`);
}
