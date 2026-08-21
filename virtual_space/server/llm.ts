// Provider-flexible LLM client. Default is Ollama (OpenAI-compatible
// chat-completions endpoint, e.g. Ollama Cloud at https://ollama.com/v1),
// with Anthropic as an optional fallback — controlled by LLM_PROVIDER in
// .env. Uses Node's built-in fetch; no SDK needed. The API key never
// leaves the server process.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function chatLLM(
  system: string,
  messages: ChatMessage[],
  maxTokens = 300
): Promise<string> {
  const provider = (process.env.LLM_PROVIDER || "ollama").toLowerCase();
  if (provider === "anthropic") return anthropicChat(system, messages, maxTokens);
  return ollamaChat(system, messages, maxTokens);
}

async function ollamaChat(
  system: string,
  messages: ChatMessage[],
  maxTokens: number
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
      max_tokens: maxTokens,
      temperature: 0.8,
      messages: [{ role: "system", content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(90_000),
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
  maxTokens: number
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
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(90_000),
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
