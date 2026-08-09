/**
 * Parser for the `## Dependencies` section of a spec document (APEX-77).
 *
 * Grammar (from the Specifier charter):
 *   - Section heading: `## Dependencies`
 *   - No blockers: the body is the word `None` (case-insensitive, trimmed)
 *   - Each blocker line: `- Blocked by: APEX-N` (or any `PREFIX-\d+` token)
 *
 * The gate uses this to extract identifiers and wire blocking edges on approval.
 */

/**
 * Extract ticket identifier tokens (e.g. `APEX-26`) from the `## Dependencies`
 * section of a markdown spec body.
 *
 * Rules:
 * - Returns `[]` when there is no `## Dependencies` section.
 * - Returns `[]` when the section body is `none` (case-insensitive).
 * - Returns a deduped, uppercase-normalised array of identifier strings otherwise.
 * - Identifiers must match the pattern `[A-Z]+-\d+` (one or more uppercase letters,
 *   a hyphen, one or more digits). Tokens that don't match are ignored.
 * - Only tokens found in the `## Dependencies` section are returned; tokens
 *   elsewhere in the document are not extracted.
 */
export function parseSpecDependencies(body: string): string[] {
  if (!body) return [];

  // Split on `## ` headings to isolate sections.
  // We include the heading text so we can identify which split is "Dependencies".
  const sections = body.split(/^(?=##\s)/m);

  const depSection = sections.find((s) => /^##\s+Dependencies\b/i.test(s));
  if (!depSection) return [];

  // Remove the heading line and work with the body of the section.
  const sectionBody = depSection.replace(/^##[^\n]*\n?/, "").trim();

  if (sectionBody.toLowerCase() === "none") return [];

  const IDENTIFIER_PATTERN = /\b([A-Z]+-\d+)\b/gi;
  const seen = new Set<string>();
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_PATTERN.exec(sectionBody)) !== null) {
    const token = match[1]!.toUpperCase();
    if (!seen.has(token)) {
      seen.add(token);
      results.push(token);
    }
  }
  return results;
}
