/**
 * Thin BYO-key LLM client. Each provider is one fetch() call. No SDKs, no
 * persistence — the caller supplies the API key per request, we use it, drop
 * the reference, and redact it from any error string before returning.
 *
 * Default model names are configurable constants — change them here if a
 * provider rolls a new flagship and the previous identifier stops working.
 */
export type LLMProvider = "openai" | "anthropic" | "gemini";

// Default models. Cheap-and-fast variants chosen on purpose — survey
// formatting is a structured rewriting task, not a creative one. Update
// in one place if a provider deprecates a model.
const PROVIDER_MODELS: Record<LLMProvider, string> = {
  openai:    "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  gemini:    "gemini-2.0-flash",
};

export interface LLMRequest {
  provider: LLMProvider;
  apiKey: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface LLMResult {
  text: string;
}

export async function callLLM(req: LLMRequest): Promise<LLMResult> {
  switch (req.provider) {
    case "openai":    return callOpenAI(req);
    case "anthropic": return callAnthropic(req);
    case "gemini":    return callGemini(req);
    default:
      throw new Error("Unsupported provider");
  }
}

async function callOpenAI({ apiKey, systemPrompt, userPrompt }: LLMRequest): Promise<LLMResult> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: PROVIDER_MODELS.openai,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw await providerError("OpenAI", res, apiKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  return { text: data?.choices?.[0]?.message?.content ?? "" };
}

async function callAnthropic({ apiKey, systemPrompt, userPrompt }: LLMRequest): Promise<LLMResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: PROVIDER_MODELS.anthropic,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) throw await providerError("Anthropic", res, apiKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  // Anthropic's content array can contain multiple blocks; join any text ones.
  const blocks = Array.isArray(data?.content) ? data.content : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
  return { text };
}

async function callGemini({ apiKey, systemPrompt, userPrompt }: LLMRequest): Promise<LLMResult> {
  // Gemini takes the key as a query parameter on v1beta. We URL-encode it
  // and never log the URL anywhere downstream.
  const model = PROVIDER_MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Gemini doesn't have a strict system-message slot; the v1beta convention
      // is to prepend the system instruction as the first user-role text part.
      contents: [
        { role: "user", parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] },
      ],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!res.ok) throw await providerError("Gemini", res, apiKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = parts.map((p: any) => p?.text ?? "").join("");
  return { text };
}

/**
 * Build a clean Error from a non-2xx provider response. Always redacts the
 * API key from the body and the URL before surfacing — provider errors can
 * sometimes echo headers back, and we never want a key in our own response.
 */
async function providerError(name: string, res: Response, apiKey: string): Promise<Error> {
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  body = redactKey(body, apiKey);
  // Trim very long bodies — provider error pages can be huge.
  if (body.length > 600) body = body.slice(0, 600) + "…";
  return new Error(`${name} returned ${res.status}${body ? `: ${body}` : ""}`);
}

function redactKey(s: string, key: string): string {
  if (!s || !key) return s;
  // Replace the literal key everywhere it might appear.
  return s.split(key).join("***");
}
