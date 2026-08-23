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

// One chat turn with the brain. No skill parameter: the TA brain has exactly one skill now, so there is
// nothing for a caller to force. The wire still accepts one — see
// virtual_ta/server/router.ts SINGLE_SKILL — but nothing here sends it.
// `bulletin` is course logistics the space knows and the brain does not: the
// instructor's announcements, and later the agenda. Sent per turn rather than
// synced, because it is small and because the alternative — the brain reading
// the space's boards.json across a server boundary — couples two processes
// that otherwise only speak HTTP.
export async function taChat(who: TaWho, message: string, bulletin?: string): Promise<TaChatResult> {
  const res = await fetch(`${TA_BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: who.sessionId,
      message,
      who: { email: who.email, name: who.name },
      bulletin: bulletin || undefined,
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

// ---------- the course corpus ----------
// The TA owns the corpus: virtual_ta/materials/ plus its manifest is what
// searchMaterials indexes. A second copy on this side, for the Library to
// render from, would drift within a month — so the Library renders whatever
// the TA reports. One list, two consumers. These two calls are the bridge,
// and they exist only because the TA's port is not reachable from a browser.

export interface TaReading {
  id: string;
  title: string;
  link?: string;
  format: string; // "md" | "html" | "pdf" | …
}

export async function taMaterials(): Promise<TaReading[]> {
  const res = await fetch(`${TA_BASE}/api/materials`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`TA materials HTTP ${res.status}`);
  const body = (await res.json()) as { readings?: TaReading[] };
  return body.readings ?? [];
}

// Null means "no such reading", which is a 404 to the student rather than an
// error — an id can go stale when the instructor edits the manifest.
export async function taMaterialFile(
  id: string
): Promise<{ bytes: Buffer; type: string } | null> {
  const res = await fetch(`${TA_BASE}/api/materials/${encodeURIComponent(id)}/file`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TA material HTTP ${res.status}`);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    type: res.headers.get("content-type") || "application/octet-stream",
  };
}

export interface TaAgendaRow {
  date: string;
  iso: string;
  week: string;
  lecture: string;
  content: string;
  homework: string;
  topic: string;
  planned: boolean;
}

export async function taAgenda(): Promise<{ rows: TaAgendaRow[]; problems: string[] }> {
  const res = await fetch(`${TA_BASE}/api/agenda`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`TA agenda HTTP ${res.status}`);
  return (await res.json()) as { rows: TaAgendaRow[]; problems: string[] };
}

// Forward one uploaded reading to the corpus. The caller MUST have checked
// that the uploader is the instructor — see server/index.ts.
export async function taUpload(
  params: Record<string, string>,
  bytes: Buffer
): Promise<{ ok: boolean; note: string; id?: string }> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${TA_BASE}/api/materials?${qs}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(60_000),
  });
  return (await res.json()) as { ok: boolean; note: string; id?: string };
}
