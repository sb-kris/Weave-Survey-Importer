/**
 * POST /api/format-with-llm — converts rough survey text into Weave's
 * structured prompt format by delegating to a user-supplied LLM key.
 *
 * Security:
 *   - The key only lives for the duration of this request. Never logged,
 *     never persisted server-side, redacted from any error string before
 *     it leaves this process.
 *   - 30 KB cap on rawText. The frontend enforces this too, but we
 *     re-check defensively.
 */
import { Router, type IRouter } from "express";
import { callLLM, type LLMProvider } from "../lib/llm.js";
import { buildFormatterPrompt } from "../lib/llm-prompt.js";

const router: IRouter = Router();

const SUPPORTED_PROVIDERS = new Set<LLMProvider>(["openai", "anthropic", "gemini"]);
const SUPPORTED_SURVEY_TYPES = new Set(["ClassicForm", "NPS", "CSAT", "CES"]);
const MAX_RAW_TEXT = 30_000;

router.post("/format-with-llm", async (req, res) => {
  const { provider, apiKey, surveyType, rawText, options } = req.body as {
    provider?: string;
    apiKey?: string;
    surveyType?: string;
    rawText?: string;
    options?: Partial<{
      preserveWording: boolean;
      removeDuplicates: boolean;
      includeSections: boolean;
      includeWelcomeThankYou: boolean;
      preserveVariables: boolean;
    }>;
  };

  // ── Validation ──────────────────────────────────────────────────────
  if (!provider || !SUPPORTED_PROVIDERS.has(provider as LLMProvider)) {
    res.status(400).json({ error: "Pick a provider: OpenAI, Anthropic, or Gemini." });
    return;
  }
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
    res.status(400).json({ error: "Provide your LLM API key." });
    return;
  }
  if (!rawText || typeof rawText !== "string" || !rawText.trim()) {
    res.status(400).json({ error: "Paste some text or upload a file to format." });
    return;
  }
  if (rawText.length > MAX_RAW_TEXT) {
    res.status(400).json({
      error: `Input is ${rawText.length.toLocaleString()} characters — too long. Trim or split into smaller batches (max ${MAX_RAW_TEXT.toLocaleString()}).`,
    });
    return;
  }

  const safeSurveyType = SUPPORTED_SURVEY_TYPES.has(surveyType ?? "") ? (surveyType as string) : "ClassicForm";
  const safeOptions = {
    preserveWording:        options?.preserveWording        ?? true,
    removeDuplicates:       options?.removeDuplicates       ?? true,
    includeSections:        options?.includeSections        ?? true,
    includeWelcomeThankYou: options?.includeWelcomeThankYou ?? true,
    preserveVariables:      options?.preserveVariables      ?? true,
  };

  const { systemPrompt, userPrompt } = buildFormatterPrompt({
    surveyType: safeSurveyType,
    rawText,
    options: safeOptions,
  });

  // ── Provider call ───────────────────────────────────────────────────
  try {
    const result = await callLLM({
      provider: provider as LLMProvider,
      apiKey: apiKey.trim(),
      systemPrompt,
      userPrompt,
    });
    const formatted = cleanFormatted(result.text);
    const warnings: string[] = [];
    if (!formatted) warnings.push("The provider returned an empty response. Try again or use a different model.");
    res.json({ formattedPrompt: formatted, warnings });
  } catch (err: unknown) {
    // err.message is already key-redacted by callLLM's provider helpers.
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `LLM call failed — ${message}` });
  }
});

/**
 * LLMs sometimes wrap their response in a code fence despite being told not to.
 * Strip leading/trailing fences so the structured prompt drops cleanly into
 * Weave's textarea.
 */
function cleanFormatted(s: string): string {
  if (!s) return "";
  let out = s.trim();
  out = out.replace(/^```[a-zA-Z0-9_-]*\s*/i, "").replace(/\s*```\s*$/i, "");
  return out.trim();
}

export default router;
