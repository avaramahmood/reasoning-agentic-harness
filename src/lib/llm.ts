// Minimal streaming client for llama.cpp's `llama-server` OpenAI-compatible API.
// We use /v1/chat/completions so llama-server applies the model's own chat
// template (Qwen <|im_start|> format) — keeping the SFT/GRPO model in-distribution.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Only one chat model now: the 7B on :8080. (The 0.5B planner was removed.)
export type Server = "verify";

export interface StreamOpts {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  stop?: string[]; // override the default stop sequences
  server?: Server; // default "verify" (the 7B)
  frequencyPenalty?: number; // discourage repeated tokens (anti-degeneration)
  presencePenalty?: number;
  onToken?: (delta: string, full: string) => void;
}

// dev: Vite proxies /v1 -> 8080. packaged app: call llama-server directly.
function baseFor(_server: Server = "verify"): string {
  return import.meta.env.DEV ? "" : "http://127.0.0.1:8080";
}
function endpointFor(server: Server = "verify"): string {
  return `${baseFor(server)}/v1/chat/completions`;
}

export async function streamChat(
  messages: ChatMessage[],
  opts: StreamOpts = {}
): Promise<string> {
  const res = await fetch(endpointFor(opts.server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify({
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.3,
      top_p: 0.9,
      // anti-degeneration: stops the symbol-spew / repetition loops on a small
      // quantized model, especially on slightly out-of-distribution prompts.
      repeat_penalty: 1.18,
      frequency_penalty: opts.frequencyPenalty ?? 0.3,
      presence_penalty: opts.presencePenalty ?? 0,
      // hard stops so it can't ramble past the answer. "<|im_start|>" halts the
      // model when it tries to role-play a NEW turn; "xmlhttp" is its URL-spam
      // degeneration marker.
      stop: opts.stop ?? ["<|im_end|>", "<|endoftext|>", "<|im_start|>", "</answer>", "xmlhttp"],
      max_tokens: opts.maxTokens ?? 512,
      cache_prompt: true,
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`llama-server ${res.status}: ${text || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by double newlines; each line starts with "data: "
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the trailing partial line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta: string = json.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          opts.onToken?.(delta, full);
        }
      } catch {
        // ignore keep-alive / malformed partial frames
      }
    }
  }
  return full;
}

// Non-streaming completion — used for short structured calls (e.g. memory
// capture), where streaming adds no value and a single parse is more robust.
export interface ChatOpts {
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  server?: Server;
  signal?: AbortSignal;
}

export async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const res = await fetch(endpointFor(opts.server), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify({
      messages,
      stream: false,
      temperature: opts.temperature ?? 0.2,
      top_p: 0.9,
      repeat_penalty: 1.1,
      stop: opts.stop ?? ["<|im_end|>", "<|endoftext|>"],
      max_tokens: opts.maxTokens ?? 512,
      cache_prompt: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`llm ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

// Liveness check so the UI can tell the user to start the server.
export async function serverReady(server: Server = "verify"): Promise<boolean> {
  try {
    const res = await fetch(`${baseFor(server)}/v1/models`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
