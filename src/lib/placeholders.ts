/**
 * SurveySparrow uses `$variable_name` for survey-context variables (folder
 * variables, contact fields, etc.). Older docs / GPT-generated prompts often
 * use `{{variable_name}}` instead — that's the canonical "ChatGPT
 * mustache-ish" style. We don't want users hitting blank `{{customer_name}}`
 * strings in their live surveys, so this module converts every
 * `{{name}}` it sees in user-supplied text to the SurveySparrow `$name`
 * syntax just before the payload is built.
 *
 * Conversion rules (matches the spec given in the variable-syntax update):
 *   {{customer_name}}        → $customer_name
 *   {{ customer_name }}      → $customer_name      (whitespace trimmed)
 *   {{ customer name }}      → $customer_name      (spaces → underscores)
 *   {{Customer-Email}}       → $customer_email     (hyphens → underscores, lowercased)
 *   {{ ticket_id }}          → $ticket_id
 *
 * Anything that doesn't look like a simple placeholder is left untouched —
 * we never want to mangle braces that appear in normal text.
 */

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9 _\-]*)\s*\}\}/g;

export interface NormalizeResult {
  out: string;
  count: number;
}

/** Returns the normalized string and the number of placeholders converted. */
export function normalizePlaceholdersInString(s: string | undefined | null): NormalizeResult {
  if (typeof s !== "string" || !s) return { out: s ?? "", count: 0 };
  let count = 0;
  const out = s.replace(PLACEHOLDER_RE, (match, raw: string) => {
    const key = raw
      .trim()
      .toLowerCase()
      .replace(/[ \-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!key) return match;
    count++;
    return `$${key}`;
  });
  return { out, count };
}

/** Convenience: drop the count, just return the string. */
export function normalizePlaceholders(s: string | undefined | null): string {
  return normalizePlaceholdersInString(s).out;
}
