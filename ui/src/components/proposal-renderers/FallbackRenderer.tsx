import type { ProposalColumn, ProposalRecord } from "@paperclipai/shared";
import type { ProposalRenderer } from "./registry";

/**
 * The fallback: an unregistered kind still renders, read-only, with one column
 * per field key found across its records. A reviewer can READ an unknown kind
 * and see its provenance; they simply cannot correct it until someone
 * registers the kind. Degrading to "readable" beats degrading to blank.
 */
function columnsFromRecords(records: readonly ProposalRecord[]): ProposalColumn[] {
  const keys: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record.fields ?? {})) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys.map((key) => ({ key, label: key, editable: false }));
}

export const fallbackProposalRenderer: ProposalRenderer = {
  kind: "__fallback__",
  label: "Record",
  columns: [],
  match: () => true,
};

/** The grid asks for columns per proposal; the fallback derives them. */
export function fallbackColumnsFor(records: readonly ProposalRecord[]): ProposalColumn[] {
  return columnsFromRecords(records);
}
