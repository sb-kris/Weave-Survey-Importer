/**
 * Builds the system + user prompt pair we send to the LLM to convert rough
 * survey content into Weave's structured prompt format.
 *
 * The prompt is intentionally compact — direct API calls don't need the
 * conversational framing the in-app "Open Formatting Helper" prompt uses
 * for ChatGPT/Claude UI. Same structural rules, fewer words.
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

export function buildFormatterPrompt(input: FormatterPromptInput): FormatterPromptOutput {
  const { surveyType, rawText, options } = input;

  const systemPrompt = `You convert rough survey content into the Weave Survey Importer's structured prompt format.

OUTPUT RULES (non-negotiable)
- Return ONLY the structured survey. No explanation, no JSON, no markdown.
- Use Q1, Q2, Q3 numbering.
- Use \`Type:\` and \`Required:\` for every question.
- Use hyphen bullets (-) only. No asterisk bullets. No markdown tables.
- Do not indent \`Required\` under Options / Rows / Columns.
- For Bipolar matrix rows use \`Left label | Right label\`.
- For Constant sum use Options, not Rows.
- If the source describes image-based answer choices, convert them into text options.

TOP-LEVEL FIELDS
Survey Title:
Survey Type:
Welcome Title:
Welcome Description:
Thank You Message:
Thank You Description:

PER-QUESTION FIELDS
Q<n>. <text>
Type: <one of the supported types>
Description: <optional>
Options: (one per line, hyphen-bulleted)
Rows: (matrix only)
Columns: (matrix only)
Scale: <e.g. 1-5 or 0-10>
Min label: <opinion scale>
Max label: <opinion scale>
Other: Yes/No
None of the above: Yes/No
All of the above: Yes/No
Randomize options: Yes/No
Consent text: <consent only>
Required: Yes/No
Show if: Q<n> <equals|is not|is less than|is greater than|contains> <value>

SUPPORTED QUESTION TYPES
Short text · Long text · Email · Phone · Number · URL · Date · Single choice · Multiple choice · Dropdown · Rating · Opinion scale · NPS · CSAT · CES · Yes/No · Matrix · Bipolar matrix · Rank order · Constant sum · Slider · File upload · Image upload · Audio upload · Signature · Consent · Message`;

  const userPrompt = buildUserPrompt(surveyType, rawText, options);

  return { systemPrompt, userPrompt };
}

function buildUserPrompt(surveyType: string, rawText: string, options: FormatterOptions): string {
  const guidance = surveyTypeGuidance(surveyType);

  const opts = [
    options.preserveWording      ? "- Preserve existing question wording where possible." : "",
    options.removeDuplicates     ? "- Remove obvious duplicate questions." : "",
    options.includeSections      ? "- Include sections when the source content has clear groupings; otherwise omit them." : "- Do not include sections.",
    options.includeWelcomeThankYou ? "- Include welcome and thank-you text if the source has them." : "- Do not include welcome / thank-you text.",
    options.preserveVariables    ? "- Preserve placeholders like {{customer_name}} verbatim. Do not rename or remove them." : "",
  ].filter(Boolean).join("\n");

  return `Selected Survey Type: ${surveyType}

${guidance}

User options:
${opts || "(none)"}

Convert the raw input below into the structured format described in the system message. Return ONLY the structured survey.

Raw input:
${rawText}`;
}

function surveyTypeGuidance(surveyType: string): string {
  switch (surveyType) {
    case "NPS":
      return "Keep Survey Type: NPS. Focus the survey on the NPS score, the reason for the score, customer context, and follow-up feedback. Use Type: NPS for the score question. Do not include unsupported advanced types unless clearly required.";
    case "CSAT":
      return "Keep Survey Type: CSAT. Focus the survey on the satisfaction score, the reason for the score, and customer context. Use Type: CSAT for the score question.";
    case "CES":
      return "Keep Survey Type: CES. Focus the survey on the effort / ease score, the reason for the score, and customer context. Use Type: CES for the score question.";
    case "ClassicForm":
    default:
      return "Keep Survey Type: ClassicForm. Standard import. NPS / CSAT / CES question types are allowed and the importer converts them to compatible question types automatically.";
  }
}
