// Provider-flexible LLM client. Default is Ollama (OpenAI-compatible
// chat-completions endpoint, e.g. Ollama Cloud at https://ollama.com/v1),
// with Anthropic as an optional fallback — controlled by LLM_PROVIDER in
// .env. Uses Node's built-in fetch; no SDK. The API key never leaves the
// server process.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
}

export function llmInfo(): { provider: string; model: string } {
  const provider = (process.env.LLM_PROVIDER || "ollama").toLowerCase();
  const model =
    provider === "anthropic"
      ? process.env.ANTHROPIC_MODEL || "claude-sonnet-5"
      : process.env.OLLAMA_MODEL || "gpt-oss:120b";
  return { provider, model };
}

// E9. The coach prompt asks for maths in `$…$`, and the model half-listens:
// inline maths comes back right, display equations still arrive as `\[ … \]`
// every time — reliably enough to reproduce on demand by asking for a formula.
// A prompt is a request. This is the guarantee.
//
// Why it matters past the chat bubble, which renders no maths either way: TA
// replies are also written into reading digests, and those are markdown that
// `render.ts` later renders for real. `$$…$$` sets an equation there; `\[ … \]`
// shows the student four literal backslashes. One dialect in, one out.
//
// Deliberately not touched: `\[` inside a fenced code block, where it is far
// more likely to be Python indexing or a regex than maths.
export function normaliseMaths(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // odd indices are the code spans themselves
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `$$${body.trim()}$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);
    })
    .join("");
}

async function rawChat(
  system: string,
  messages: ChatMessage[],
  opts: LLMOptions = {}
): Promise<string> {
  const { provider } = llmInfo();
  if (provider === "anthropic") return anthropicChat(system, messages, opts);
  return ollamaChat(system, messages, opts);
}

export async function chatLLM(
  system: string,
  messages: ChatMessage[],
  opts: LLMOptions = {}
): Promise<string> {
  return normaliseMaths(await rawChat(system, messages, opts));
}

// Ask for a JSON object and parse it defensively. Returns null when the
// model's output contains nothing parseable — callers decide the fallback.
export async function jsonLLM(
  system: string,
  messages: ChatMessage[],
  opts: LLMOptions = {}
): Promise<Record<string, unknown> | null> {
  // rawChat, not chatLLM: the maths normalisation is for prose a student
  // reads. Rewriting delimiters inside a JSON string value would corrupt it.
  const raw = await rawChat(system, messages, {
    temperature: 0,
    maxTokens: 200,
    ...opts,
  });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function ollamaChat(
  system: string,
  messages: ChatMessage[],
  opts: LLMOptions
): Promise<string> {
  const base = (process.env.OLLAMA_BASE_URL || "https://ollama.com/v1").replace(/\/+$/, "");
  const key = process.env.OLLAMA_API_KEY || "";
  const model = process.env.OLLAMA_MODEL || "gpt-oss:120b";

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.7,
      messages: [{ role: "system", content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Ollama HTTP ${res.status}: ${body}`);
  }
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("LLM returned empty content");
  return text.trim();
}

async function anthropicChat(
  system: string,
  messages: ChatMessage[],
  opts: LLMOptions
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY || "";
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 800,
      temperature: opts.temperature ?? 0.7,
      system,
      messages,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Anthropic HTTP ${res.status}: ${body}`);
  }
  const data: any = await res.json();
  const text = (data?.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  if (!text.trim()) throw new Error("LLM returned empty content");
  return text.trim();
}
