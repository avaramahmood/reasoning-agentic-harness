// Minimal streaming client for llama.cpp's `llama-server` OpenAI-compatible API.
// We use /v1/chat/completions so llama-server applies the model's own chat
// template (Qwen <|im_start|> format) — keeping the SFT/GRPO model in-distribution.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOpts {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  stop?: string[]; // override the default stop sequences
  onToken?: (delta: string, full: string) => void;
}

// dev: Vite proxies /v1 -> 8080. packaged app: no proxy, call llama-server directly.
const LLM_BASE = import.meta.env.DEV ? "" : "http://127.0.0.1:8080";
const ENDPOINT = `${LLM_BASE}/v1/chat/completions`;

export async function streamChat(
  messages: ChatMessage[],
  opts: StreamOpts = {}
): Promise<string> {
  const res = await fetch(ENDPOINT, {
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
      repeat_penalty: 1.15,
      // hard stops so it can't ramble past the answer into garbage
      stop: opts.stop ?? ["<|im_end|>", "<|endoftext|>", "</answer>"],
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

// Liveness check so the UI can tell the user to start the server.
export async function serverReady(): Promise<boolean> {
  try {
    const res = await fetch(`${LLM_BASE}/v1/models`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
