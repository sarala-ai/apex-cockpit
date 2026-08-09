/**
 * Structured dependency declaration for spec documents (APEX-77).
 *
 * Authoritative source: the `dependencies` YAML front matter field.
 *
 *   ---
 *   dependencies: [APEX-26, APEX-51]
 *   ---
 *
 * The `## Dependencies` prose section is HUMAN documentation only. At the
 * spec_review gate, the structured field and the prose section must agree;
 * a mismatch is a validation error that blocks gate approval.
 */

import { parseFrontmatterMarkdown } from "@paperclipai/shared";

const IDENTIFIER_RE = /^[A-Z]+-\d+$/;

/**
 * Parse the `dependencies` YAML front matter field from a spec document.
 * Returns a deduped, uppercase-normalised array of identifiers.
 *
 * This is the AUTHORITATIVE source — do not use prose section parsing to
 * produce machine state; use this function or `detectSpecDependenciesMismatch`.
 */
export function parseSpecDependencies(rawDoc: string): string[] {
  if (!rawDoc) return [];
  const { frontmatter } = parseFrontmatterMarkdown(rawDoc);
  const deps = frontmatter.dependencies;
  if (!deps) return [];

  // Block notation (`dependencies:\n  - APEX-26`) → Array.
  // Inline flow sequence (`dependencies: [APEX-26]`) → the custom YAML parser
  // returns a raw string when JSON.parse fails on non-JSON values.
  let items: unknown[];
  if (Array.isArray(deps)) {
    items = deps;
  } else if (typeof deps === "string" && deps.startsWith("[") && deps.endsWith("]")) {
    items = deps.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    return [];
  }

  const seen = new Set<string>();
  const results: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const upper = item.trim().toUpperCase();
    if (IDENTIFIER_RE.test(upper) && !seen.has(upper)) {
      seen.add(upper);
      results.push(upper);
    }
  }
  return results;
}

/**
 * Extract ticket identifiers from the `## Dependencies` prose section.
 * Internal — used only for mismatch detection. Not authoritative.
 */
function parseProseSpecDependencies(body: string): string[] {
  if (!body) return [];
  const sections = body.split(/^(?=##\s)/m);
  const depSection = sections.find((s) => /^##\s+Dependencies\b/i.test(s));
  if (!depSection) return [];

  const sectionBody = depSection.replace(/^##[^\n]*\n?/, "").trim();
  if (sectionBody.toLowerCase() === "none") return [];

  const IDENT_RE = /\b([A-Z]+-\d+)\b/gi;
  const seen = new Set<string>();
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = IDENT_RE.exec(sectionBody)) !== null) {
    const token = match[1]!.toUpperCase();
    if (!seen.has(token)) {
      seen.add(token);
      results.push(token);
    }
  }
  return results;
}

/**
 * Returns an error message when the YAML front matter `dependencies` field and
 * the `## Dependencies` prose section disagree; returns null when they agree.
 *
 * "Agree" means the set of identifiers is identical. If neither source
 * declares any dependencies, they agree. If only one source declares
 * dependencies, that is a mismatch.
 *
 * This must be called at the spec_review gate before the case transitions.
 */
export function detectSpecDependenciesMismatch(rawDoc: string): string | null {
  const { body } = parseFrontmatterMarkdown(rawDoc);
  const structured = parseSpecDependencies(rawDoc);
  const prose = parseProseSpecDependencies(body);

  const structuredSet = new Set(structured);
  const proseSet = new Set(prose);

  const missingFromProse = structured.filter((d) => !proseSet.has(d));
  const extraInProse = prose.filter((d) => !structuredSet.has(d));

  if (missingFromProse.length === 0 && extraInProse.length === 0) return null;

  const parts: string[] = [];
  if (missingFromProse.length > 0) {
    parts.push(
      `declared in front matter but absent from ## Dependencies prose: ${missingFromProse.join(", ")}`,
    );
  }
  if (extraInProse.length > 0) {
    parts.push(
      `present in ## Dependencies prose but missing from front matter dependencies field: ${extraInProse.join(", ")}`,
    );
  }
  return `spec dependencies mismatch — ${parts.join("; ")}`;
}
