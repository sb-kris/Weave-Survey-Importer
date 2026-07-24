/**
 * Builds the system + user prompt pair we send to the LLM to convert rough
 * survey content into Weave's structured prompt format.
 *
 * Design goals (reliability rewrite):
 *   - ONE shared prompt template across OpenAI / Anthropic / Gemini. Provider
 *     code in llm.ts only differs on auth / endpoint / response extraction —
 *     never on prompt content.
 *   - The model is told to extract EVERY question, never omit one because its
 *     type is uncertain, never merge or split questions, and never invent
 *     options.
 *   - A strict internal self-check runs before it returns, so the output is
 *     corrected (not explained) before it reaches us.
 *   - The output format matches Weave's parser exactly.
 */
export interface FormatterOptions {
  preserveWording: boolean;
  removeDuplicates: boolean;
  includeSections: boolean;
  includeWelcomeThankYou: boolean;
  preserveVariables: boolean;
}

export interface FormatterPromptInput {
  surveyType: string;
  rawText: string;
  options: FormatterOptions;
}

export interface FormatterPromptOutput {
  systemPrompt: string;
  userPrompt: string;
}

const SUPPORTED_TYPES = [
  "Short text", "Long text", "Email", "Phone", "Number", "URL", "Date",
  "Single choice", "Multiple choice", "Dropdown", "Rating", "Opinion scale",
  "NPS", "CSAT", "CES", "NPSFeedback", "CSATFeedback", "CESFeedback",
  "Yes/No", "Matrix", "Bipolar matrix", "Rank order", "Constant sum", "Slider",
  "File upload", "Image upload", "Audio upload", "Signature", "Consent", "Message",
].join(" · ");

export function buildFormatterPrompt(input: FormatterPromptInput): FormatterPromptOutput {
  const { surveyType, rawText, options } = input;

  const systemPrompt = `You are a survey-conversion engine for the Weave Survey Importer. You convert raw survey content (structured text, rough notes, exported CSV/spreadsheet rows, or document text) into Weave's exact structured prompt format.

YOUR TASK
- Extract EVERY identifiable survey question from the source. Completeness is the single most important requirement.
- Preserve the original question wording unless cleanup is clearly needed for readability.
- Preserve all answer options exactly as written.
- Preserve required / optional status when the source states it.
- Preserve sections and grouping when the source has them.
- Preserve descriptions, scale labels, variables, and simple display logic when present.
- Convert everything into the exact structured format described below.

HARD RULES (do not break these)
- NEVER omit a question because its type is uncertain. Use a reasonable fallback type instead of dropping it (Short text for open-ended answers, Long text for multi-line/comment answers, Single choice when a small option list is present, Dropdown for long option lists).
- NEVER invent options when the source clearly contains none.
- NEVER merge two separate questions into one.
- NEVER split one question into several unless the source clearly does so.
- NEVER add commentary, explanations, JSON, or markdown tables.
- Variables use SurveySparrow's dollar syntax: $customer_name, $ticket_id. If the source uses {{customer_name}} double braces, convert to $customer_name (lowercase snake_case).

OUTPUT FORMAT (use these field names exactly; only include fields that apply)
Survey Title:
Survey Type:
Welcome Title:
Welcome Description:
Thank You Message:
Thank You Description:

Section: Section name
Single page view: Yes|No       <optional, directly under a Section line — default No>
Section intro: Same|Separate   <optional, directly under a Section line — default Separate>

Q1. Question text
Type: <one supported type>
Description: <optional>
Options:
- Option 1
- Option 2
Rows:
- Row 1
- Row 2
Columns:
- Column 1
- Column 2
Scale: <e.g. 1-5 or 0-10>
Min label: <opinion scale / slider>
Max label: <opinion scale / slider>
Satisfied: <CSATFeedback only>
Neutral: <CSATFeedback / CESFeedback only>
Dissatisfied: <CSATFeedback only>
Promoter: <NPSFeedback only>
Passive: <NPSFeedback only>
Detractor: <NPSFeedback only>
Low effort: <CESFeedback only>
High effort: <CESFeedback only>
Other: Yes/No
None of the above: Yes/No
All of the above: Yes/No
Randomize options: Yes/No
Consent text: <consent only>
Required: Yes/No
Show if: Q<n> <equals|is not|is less than|is greater than|contains> <value>

SUPPORTED QUESTION TYPES
${SUPPORTED_TYPES}

FORMATTING RULES
- Number questions Q1, Q2, Q3 … with no gaps.
- Every question MUST have a Type line and a Required line (Required: Yes or Required: No — default to No when the source is silent).
- Use hyphen bullets (-) only for Options, Rows, and Columns. No asterisks. No numbered option lists. No markdown tables.
- Do NOT indent Required / Type under Options, Rows, or Columns — each is its own top-level line.
- For Bipolar matrix, every row is "Left label | Right label".
- For Constant sum, use Options (not Rows).
- One question per block, separated by a blank line.

SELF-CHECK BEFORE RETURNING (do this internally, silently — do NOT show your reasoning)
Before you output anything, verify and FIX your draft so that:
1. Every question present in the source appears in your output — none dropped, none duplicated.
2. Question numbers are sequential starting at Q1 with no gaps.
3. Every question has a Type line.
4. Every question has Required: Yes or Required: No.
5. Every option-based question (Single/Multiple choice, Dropdown, Rank order, Constant sum) has an Options list.
6. Every Matrix / Bipolar matrix question has both Rows and Columns; Bipolar rows use "Left | Right".
7. Variables use $name syntax, never {{name}}.
8. No two questions are duplicates, and no separate source questions were merged.
9. Survey Type matches the selected type below.
10. The output contains ONLY the structured survey — no preamble, no explanation, no closing remark.
Correct any violation, then return the corrected result.

Return ONLY the final structured survey as plain text (optionally wrapped in a single plain-text code block). Nothing before it, nothing after it.`;

  const userPrompt = buildUserPrompt(surveyType, rawText, options);

  return { systemPrompt, userPrompt };
}

function buildUserPrompt(surveyType: string, rawText: string, options: FormatterOptions): string {
  const guidance = surveyTypeGuidance(surveyType);

  const opts = [
    options.preserveWording      ? "- Preserve the source's question wording wherever it is already clear." : "- You may rewrite awkward wording for clarity, but keep the meaning identical.",
    options.removeDuplicates     ? "- If the source repeats the exact same question, keep only one copy." : "- Keep every question even if some look similar.",
    options.includeSections      ? "- Include Section: lines when the source has clear groupings; otherwise omit sections entirely." : "- Do not output any Section: lines.",
    options.includeWelcomeThankYou ? "- Include Welcome / Thank You text only if the source contains it." : "- Do not output Welcome or Thank You text.",
    options.preserveVariables    ? "- Use $customer_name / $account_name / $ticket_id style variables; convert any {{name}} placeholders to $name." : "",
  ].filter(Boolean).join("\n");

  return `Selected Survey Type: ${surveyType}

${guidance}

Options for this run:
${opts}

Convert the raw input below into the exact structured format from the system message. Extract every question. Return ONLY the structured survey.

--- RAW INPUT START ---
${rawText}
--- RAW INPUT END ---`;
}

function surveyTypeGuidance(surveyType: string): string {
  switch (surveyType) {
    case "NPS":
      return [
        "This is an NPS survey. Structure it as:",
        "- Exactly ONE primary NPS score question (Type: NPS). Never create more than one NPS score question.",
        "- A reason-for-score follow-up (Type: NPSFeedback with Promoter / Passive / Detractor if the source has one; otherwise Type: Long text).",
        "- Customer-context and supporting questions as needed.",
        "Keep the set focused. Avoid advanced question types that aren't in the source. Put Survey Type: NPS at the top.",
      ].join("\n");
    case "CSAT":
      return [
        "This is a CSAT survey. Structure it as:",
        "- Exactly ONE primary CSAT score question (Type: CSAT). Do NOT convert it into a generic Rating.",
        "- An optional CSATFeedback follow-up. If used, preserve its Satisfied / Neutral / Dissatisfied labels.",
        "- Supporting customer / context questions as needed.",
        "Keep the set focused. Put Survey Type: CSAT at the top.",
      ].join("\n");
    case "CES":
      return [
        "This is a CES (Customer Effort Score) survey. Keep wording focused on ease, effort, or difficulty.",
        "",
        "IMPORTANT CES SCORE MAPPING — do NOT use Type: CES anywhere. Emit the primary effort/ease score question, and any other effort/ease scoring question, as an Opinion Scale:",
        "  Type: Opinion scale",
        "  Scale: 1-7",
        "  Min label: Very Easy",
        "  Max label: Very Difficult",
        "There must be exactly ONE primary effort/ease score question.",
        "A CESFeedback follow-up (Low effort / Neutral / High effort) is allowed exactly once, directly after the score question; all other open-text follow-ups use Type: Long text.",
        "Put Survey Type: CES at the top.",
      ].join("\n");
    case "ClassicForm":
    default:
      return [
        "This is a ClassicForm survey — the broadest format. Allow all supported question types, sections, welcome/thank-you text, descriptions, variables, and simple display logic.",
        "Do not simplify valid advanced question types (Matrix, Rank order, Constant sum, Slider, etc.) — keep them.",
        "If the source contains NPS / CSAT / CES score questions, keep them as Type: NPS / Type: CSAT / Type: CES — the importer maps them to compatible ClassicForm types automatically. Do not use NPSFeedback / CSATFeedback / CESFeedback in a ClassicForm survey; emit those follow-ups as Long text.",
        "Put Survey Type: ClassicForm at the top.",
      ].join("\n");
  }
}
