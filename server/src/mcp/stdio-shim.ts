/**
 * APEX-35 T11 — stdio token-carrying shim for stdio-only MCP hosts.
 *
 * Streamable HTTP is the canonical transport; this shim is the only stdio
 * support. It speaks newline-delimited JSON-RPC over stdio to the host and
 * proxies every message to the canonical /mcp streamable-HTTP endpoint,
 * attaching the bearer token read from PAPERCLIP_MCP_TOKEN. The dispatcher
 * injects that token at the same seam as the run-JWT dispatch env (T8); the
 * shim contains no auth logic beyond forwarding it.
 *
 * Config comes exclusively from the environment:
 *   PAPERCLIP_MCP_TOKEN — bearer token (required; argv/flags are rejected so
 *                         tokens never land in process listings or shell history)
 *   PAPERCLIP_MCP_URL   — the /mcp endpoint URL (required)
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";

export type ShimConfig =
  | { ok: true; token: string; url: string }
  | { ok: false; error: string };

export function resolveShimConfig(
  env: Record<string, string | undefined>,
  argv: string[],
): ShimConfig {
  if (argv.length > 0) {
    return {
      ok: false,
      error:
        "cockpit-mcp-stdio-shim accepts no arguments or flags; " +
        "set PAPERCLIP_MCP_TOKEN and PAPERCLIP_MCP_URL in the environment instead",
    };
  }
  const token = env.PAPERCLIP_MCP_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      error:
        "PAPERCLIP_MCP_TOKEN is not set; refusing to open an anonymous session against /mcp",
    };
  }
  const url = env.PAPERCLIP_MCP_URL?.trim();
  if (!url) {
    return { ok: false, error: "PAPERCLIP_MCP_URL is not set" };
  }
  return { ok: true, token, url };
}

// Extract every JSON-RPC message from a streamable-HTTP response body —
// either a plain JSON body (object or batch array) or an SSE stream whose
// `data:` lines carry one JSON-RPC message each.
export function extractJsonRpcMessages(contentType: string, body: string): unknown[] {
  if (contentType.includes("text/event-stream")) {
    const messages: unknown[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (!payload) continue;
      try {
        messages.push(JSON.parse(payload));
      } catch {
        // skip non-JSON data lines (e.g. SSE comments/keepalives)
      }
    }
    return messages;
  }
  if (!body.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export async function runStdioShim(opts: {
  input: Readable;
  output: Writable;
  token: string;
  url: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const writeMessage = (message: unknown): void => {
    opts.output.write(`${JSON.stringify(message)}\n`);
  };

  const rl = createInterface({ input: opts.input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message: { id?: unknown };
    try {
      message = JSON.parse(trimmed) as { id?: unknown };
    } catch {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }

    let response: globalThis.Response;
    try {
      response = await doFetch(opts.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: trimmed,
      });
    } catch (err) {
      if (message.id !== undefined && message.id !== null) {
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: `upstream request failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
      continue;
    }

    const body = await response.text();
    if (!response.ok) {
      if (message.id !== undefined && message.id !== null) {
        writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: `upstream HTTP ${response.status}` },
        });
      }
      continue;
    }

    // 202 Accepted (notifications/responses) carries no messages to relay.
    const contentType = response.headers.get("content-type") ?? "";
    for (const relayed of extractJsonRpcMessages(contentType, body)) {
      writeMessage(relayed);
    }
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = resolveShimConfig(process.env, process.argv.slice(2));
  if (!config.ok) {
    process.stderr.write(`${config.error}\n`);
    process.exit(2);
  }
  runStdioShim({
    input: process.stdin,
    output: process.stdout,
    token: config.token,
    url: config.url,
  }).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
