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
 *
 * Reliability:
 *   - The provider result carries a `truncated` flag (hit the output-token
 *     ceiling). We never silently accept truncated output.
 *   - We validate the structured result before returning it and hand the
 *     frontend a list of concrete issues plus source/output question counts,
 *     so partial or malformed output is flagged rather than inserted blindly.
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
    const check = validateFormatted(formatted, safeSurveyType);
    const sourceQuestionEstimate = estimateSourceQuestions(rawText);
    const outputQuestionCount = check.questionCount;

    const issues = [...check.issues];
    const warnings: string[] = [];

    // Provider-level truncation is authoritative — the survey is cut off.
    if (result.truncated) {
      issues.unshift("The model stopped at its output-length limit — the survey is cut off. Try a shorter input, split it into batches, or switch providers.");
    }

    if (!formatted) {
      issues.unshift("The provider returned an empty response. Try again or use a different model.");
    }

    // Heuristic: the source looks like it holds materially more questions than
    // the model returned. Soft signal (source counting is fuzzy), so it's a
    // warning, not a hard failure — but the frontend surfaces it prominently.
    const possibleQuestionLoss =
      outputQuestionCount > 0 &&
      sourceQuestionEstimate >= 5 &&
      outputQuestionCount < Math.floor(sourceQuestionEstimate * 0.6);
    if (possibleQuestionLoss) {
      warnings.push(`Possible question loss detected — the source looks like it has ~${sourceQuestionEstimate} questions but the output has ${outputQuestionCount}. Review before inserting.`);
    }

    const valid = issues.length === 0 && !!formatted;

    res.json({
      formattedPrompt: formatted,
      valid,
      truncated: result.truncated,
      issues,
      warnings,
      outputQuestionCount,
      sourceQuestionEstimate,
      possibleQuestionLoss,
    });
  } catch (err: unknown) {
    // err.message is already key-redacted by callLLM's provider helpers.
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `LLM call failed — ${message}` });
  }
});

/**
 * Extract the structured survey from a model response.
 *
 * LLMs sometimes wrap output in a code fence despite instructions. Handle it
 * safely:
 *   - If a fenced block exists, return the LARGEST fenced block's contents
 *     (the survey), ignoring any prose outside the fence.
 *   - Otherwise strip a stray leading / trailing fence line if present.
 * Never throws; worst case returns the trimmed input.
 */
export function cleanFormatted(s: string): string {
  if (!s) return "";
  const text = s.replace(/\r\n/g, "\n").trim();

  // Pull out fenced blocks: ```lang\n ... \n```
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let largest = "";
  while ((match = fenceRe.exec(text)) !== null) {
    const inner = match[1].trim();
    if (inner.length > largest.length) largest = inner;
  }
  if (largest) return largest;

  // No complete fenced block — strip a dangling leading / trailing fence line.
  let out = text.replace(/^```[a-zA-Z0-9_-]*[ \t]*\n?/, "").replace(/\n?```[ \t]*$/, "");
  return out.trim();
}

const OPTION_TYPES = ["single choice", "multiple choice", "multiplechoice", "singlechoice", "dropdown", "rank order", "rankorder", "constant sum", "constantsum", "ranking"];
const MATRIX_TYPES = ["matrix", "bipolar matrix", "bipolarmatrix"];

interface ValidationResult {
  questionCount: number;
  issues: string[];
}

/**
 * Lightweight structural validation of the formatted survey — a deliberately
 * conservative mirror of the real parser. It flags only clear problems so it
 * never rejects output the parser would accept.
 */
export function validateFormatted(text: string, expectedSurveyType: string): ValidationResult {
  const issues: string[] = [];
  if (!text) return { questionCount: 0, issues: ["Empty output."] };

  const lines = text.split("\n");

  const titleVal = firstFieldValue(lines, "Survey Title");
  const typeVal = firstFieldValue(lines, "Survey Type");
  if (titleVal === null) issues.push("Missing a `Survey Title:` line.");
  else if (!titleVal.trim()) issues.push("`Survey Title:` is empty.");
  if (typeVal === null) issues.push("Missing a `Survey Type:` line.");
  else if (!typeVal.trim()) issues.push("`Survey Type:` is empty.");
  else if (typeVal.trim().toLowerCase() !== expectedSurveyType.toLowerCase()) {
    issues.push(`Survey Type is "${typeVal.trim()}" but "${expectedSurveyType}" was selected.`);
  }

  // Split into question blocks.
  const blocks: { num: number; lines: string[] }[] = [];
  let current: { num: number; lines: string[] } | null = null;
  for (const raw of lines) {
    const m = raw.match(/^\s*Q(\d+)\s*\./);
    if (m) {
      if (current) blocks.push(current);
      current = { num: parseInt(m[1], 10), lines: [raw] };
    } else if (current) {
      current.lines.push(raw);
    }
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) {
    issues.push("No questions found (expected lines like `Q1.`, `Q2.`).");
    return { questionCount: 0, issues };
  }

  // Sequential numbering Q1..Qn.
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].num !== i + 1) {
      issues.push(`Question numbering is not sequential — expected Q${i + 1} but found Q${blocks[i].num}.`);
      break;
    }
  }

  for (const b of blocks) {
    const body = b.lines.join("\n");
    const typeLine = fieldValueIn(b.lines, "Type");
    const requiredLine = fieldValueIn(b.lines, "Required");
    if (typeLine === null || !typeLine.trim()) issues.push(`Q${b.num} is missing a Type.`);
    if (requiredLine === null) issues.push(`Q${b.num} is missing a Required: Yes/No line.`);
    else if (!/^\s*(yes|no)\s*$/i.test(requiredLine)) issues.push(`Q${b.num} has an invalid Required value ("${requiredLine.trim()}"); expected Yes or No.`);

    const t = (typeLine || "").trim().toLowerCase();
    if (OPTION_TYPES.some((ot) => t === ot || t.replace(/[^a-z]/g, "") === ot.replace(/[^a-z]/g, "")) && !/^\s*-\s+\S/m.test(afterField(body, "Options"))) {
      issues.push(`Q${b.num} (${typeLine?.trim()}) has no Options list.`);
    }
    if (MATRIX_TYPES.some((mt) => t === mt || t.replace(/[^a-z]/g, "") === mt.replace(/[^a-z]/g, ""))) {
      if (!/^\s*-\s+\S/m.test(afterField(body, "Rows"))) issues.push(`Q${b.num} (matrix) has no Rows.`);
      if (!/^\s*-\s+\S/m.test(afterField(body, "Columns"))) issues.push(`Q${b.num} (matrix) has no Columns.`);
    }
  }

  // Truncation heuristic (content-based): the last block is missing its
  // Required line, which usually means the response was cut off mid-question.
  const last = blocks[blocks.length - 1];
  if (fieldValueIn(last.lines, "Required") === null && fieldValueIn(last.lines, "Type") === null) {
    issues.push("The output appears to end abruptly (the last question is incomplete).");
  }

  return { questionCount: blocks.length, issues };
}

/** First value of a top-level `Field:` line anywhere in the doc, or null. */
function firstFieldValue(lines: string[], field: string): string | null {
  const re = new RegExp(`^\\s*${field}\\s*:(.*)$`, "i");
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Value of a `Field:` line within a single question block, or null. */
function fieldValueIn(lines: string[], field: string): string | null {
  const re = new RegExp(`^\\s*${field}\\s*:(.*)$`, "i");
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m[1];
  }
  return null;
}

/** The block text after a `Field:` label up to the next field label. */
function afterField(body: string, field: string): string {
  const re = new RegExp(`^\\s*${field}\\s*:[ \\t]*\\n?`, "im");
  const idx = body.search(re);
  if (idx < 0) return "";
  return body.slice(idx);
}

/**
 * Rough estimate of how many questions the SOURCE contains. Source text is
 * unstructured, so this is intentionally fuzzy and used only to raise a soft
 * "possible question loss" flag — never to reject output. Takes the max of two
 * cheap signals: explicit numbered lines, and lines that read as questions.
 */
export function estimateSourceQuestions(raw: string): number {
  if (!raw) return 0;
  const lines = raw.split(/\r?\n/);
  let numbered = 0;
  let questionish = 0;
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (/^(Q\s*)?\d+\s*[.)\]:-]/i.test(t)) numbered++;
    if (t.endsWith("?")) questionish++;
  }
  return Math.max(numbered, questionish);
}

export default router;
