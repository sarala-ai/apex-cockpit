/**
 * Minimal transit+json decoder for the ONE shape Penpot's RPC endpoints return:
 * a top-level map encoded as a flat array whose first element is the map marker
 * `"^ "`, followed by alternating key/value entries.
 *
 *   ["^ ", "~:id", "~u6f1b…", "~:token", "eyJ…", "~:name", "apex"]
 *     → { id: "6f1b…", token: "eyJ…", name: "apex" }
 *
 * Why this exists at all: an operator once minted a Penpot token by hand with
 * curl, behind a "only print the body if it looks malformed" guard. The guard
 * compared the body against JSON expectations, transit is not JSON, the guard
 * fired, and the raw body — token included — was echoed into an LLM transcript.
 * The token had to be revoked. Parsing the format properly is what makes the
 * "never print the body" rule keepable: with a real parser there is never a
 * reason to look at the raw text, and every failure below is reported by SHAPE,
 * never by content (see the error messages — not one of them interpolates the
 * body).
 *
 * Deliberately not a full transit implementation. Value caching (`^0`, `^1` …),
 * nested maps-as-values and tagged composites are REJECTED rather than guessed
 * at: a decoder that silently returns a partial map is how a caller ends up
 * with a truncated credential it believes is whole.
 */

export type TransitParseErrorCode =
  | "transit_not_a_map"
  | "transit_odd_entries"
  | "transit_bad_key"
  | "transit_unsupported_cache_ref";

/** Classified parse failure. Never carries any part of the decoded body. */
export class TransitParseError extends Error {
  constructor(
    public readonly code: TransitParseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransitParseError";
  }
}

const MAP_MARKER = "^ ";
const CACHE_REF_RE = /^\^[0-9A-Za-z]/;

/**
 * Decode a scalar transit value. Tag prefixes we care about:
 *   `~:kw` → "kw"      (keyword)
 *   `~uUUID` → "UUID"  (uuid)
 *   `~tISO` → "ISO"    (instant)
 *   `~~x` → "~x"       (escaped literal tilde)
 * Any other `~X…` tag is returned verbatim, tag included: unknown tags are not
 * this decoder's business, and stripping a tag it does not understand would
 * corrupt the value.
 */
function decodeScalar(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.startsWith("~~")) return value.slice(1);
  if (value.startsWith("~:") || value.startsWith("~u") || value.startsWith("~t")) {
    return value.slice(2);
  }
  return value;
}

/**
 * Parse a transit-encoded top-level map into a plain object.
 *
 * @throws TransitParseError with a classified `code` — the caller decides
 *   whether that is a retryable upstream hiccup or a contract change, and can
 *   say so in a message without ever touching the payload.
 */
export function parseTransitMap(body: unknown): Record<string, unknown> {
  if (!Array.isArray(body) || body[0] !== MAP_MARKER) {
    const shape = Array.isArray(body)
      ? `array of ${body.length} whose first element is ${typeof body[0]}`
      : typeof body;
    throw new TransitParseError(
      "transit_not_a_map",
      `expected a transit map (a JSON array starting with "^ "), got ${shape}`,
    );
  }

  const entries = body.slice(1);
  if (entries.length % 2 !== 0) {
    throw new TransitParseError(
      "transit_odd_entries",
      `transit map has ${entries.length} entries after the marker; a map must have an even count`,
    );
  }

  const out: Record<string, unknown> = {};
  for (let i = 0; i < entries.length; i += 2) {
    const rawKey = entries[i];
    if (typeof rawKey !== "string") {
      throw new TransitParseError(
        "transit_bad_key",
        `transit map key at index ${i} is ${typeof rawKey}, expected a "~:"-prefixed string`,
      );
    }
    if (CACHE_REF_RE.test(rawKey)) {
      throw new TransitParseError(
        "transit_unsupported_cache_ref",
        `transit map key at index ${i} is a cache reference; this decoder handles flat single maps only`,
      );
    }
    if (!rawKey.startsWith("~:")) {
      throw new TransitParseError(
        "transit_bad_key",
        `transit map key at index ${i} is not a keyword (expected a "~:" prefix)`,
      );
    }
    out[rawKey.slice(2)] = decodeScalar(entries[i + 1]);
  }
  return out;
}

/**
 * Read a required non-empty string field out of a decoded transit map.
 * Separate from parseTransitMap so the "the map parsed but the field we need is
 * missing" case is still a classified failure and not an `undefined` that
 * travels onward as a credential.
 */
export function requireTransitString(
  map: Record<string, unknown>,
  field: string,
): string {
  const value = map[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TransitParseError(
      "transit_bad_key",
      `transit map is missing a usable "${field}" field (present keys: ${Object.keys(map).join(", ") || "none"})`,
    );
  }
  return value;
}
