/**
 * Subscription bridge — OpenAI-compatible HTTP shim that fronts headless
 * Claude via `claude -p` (the sanctioned Agent SDK harness, invoked via CLI).
 *
 * The cockpit mounts this as an express Router at `/bridge/v1` and then
 * registers the resulting URL as an `openai_compatible` provider row in the
 * gateway's LLM plane. The gateway routes `apex-*` alias calls through this
 * URL, which spawns `claude -p` (the Agent SDK under the hood) to process them.
 *
 * COMPLIANCE HARD RULE: the subscription OAuth token MUST NOT be stored as a
 * raw credential in the gateway's encrypted store. The bridge calls the claude
 * harness; the gateway sees it only as an ordinary OpenAI-compatible upstream.
 *
 * CLI approach (vs. direct Agent SDK import): `coordinator-agent-sdk.ts` is
 * excluded from the server's tsconfig because @anthropic-ai/claude-agent-sdk
 * is not a declared server dependency. The bridge uses `claude -p` (same as
 * board-chat.ts) which invokes the Agent SDK binary internally — equivalent
 * sanctioned path, no additional dependency needed.
 */

import { Router, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** Max time to wait for `claude -p` to respond (ms). Judge calls need headroom. */
const BRIDGE_TIMEOUT_MS = 120_000;

type OAIRole = 'system' | 'user' | 'assistant';
interface OAIMessage {
  role: OAIRole;
  content: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages: OAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

/** Serialize OpenAI messages to a `claude -p` compatible prompt string.
 *
 * `claude -p` accepts a single stdin prompt. For multi-turn we inline
 * conversation history in a human-readable format claude understands.
 * The system message is prepended if present. */
function buildClaudePrompt(messages: OAIMessage[]): string {
  const systemMsg = messages.find((m) => m.role === 'system');
  const conversationMsgs = messages.filter((m) => m.role !== 'system');

  const parts: string[] = [];

  if (systemMsg?.content) {
    parts.push(`<system>\n${systemMsg.content}\n</system>`);
  }

  if (conversationMsgs.length === 0) {
    return parts.join('\n\n');
  }

  // Single user message — most common judge invocation
  if (conversationMsgs.length === 1 && conversationMsgs[0].role === 'user') {
    parts.push(conversationMsgs[0].content);
    return parts.join('\n\n');
  }

  // Multi-turn: serialize into conversation format
  const turns = conversationMsgs
    .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  parts.push(turns);
  return parts.join('\n\n');
}

/** Spawn `claude -p` with the given prompt and return the response text. */
function runClaude(prompt: string, abortSignal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // --no-stream avoids interleaved SSE data in the output; --print captures
    // the final response in a single block. The board-chat uses the same
    // flags for its one-shot invocations.
    const args = ['--print', '--output-format', 'text', '--max-turns', '8'];
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: BRIDGE_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const errText = stderr.trim() || stdout.trim() || `claude exited with code ${code}`;
        reject(new Error(errText));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        reject(new Error('Request aborted'));
      });
    }

    // Write prompt to stdin and close to signal end of input
    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();
  });
}

/** Build an OpenAI-compatible chat completion response object. */
function buildCompletionResponse(model: string, text: string): object {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

/** Send a minimal SSE stream for callers that expect `stream: true`. */
function sendStreamResponse(res: Response, model: string, text: string): void {
  const chunkId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const chunk = {
    id: chunkId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, logprobs: null, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);

  const done = {
    id: chunkId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
  };
  res.write(`data: ${JSON.stringify(done)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Build the express Router that handles `POST /chat/completions`.
 * Mount at `/bridge/v1` in the cockpit app.
 */
export function subscriptionBridgeRouter(): Router {
  const router = Router();

  // POST /chat/completions — OpenAI-compatible chat endpoint
  router.post('/chat/completions', async (req: Request, res: Response) => {
    const body = req.body as ChatCompletionRequest;

    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' },
      });
      return;
    }

    const model = body.model ?? 'claude-subscription';
    const prompt = buildClaudePrompt(body.messages);

    if (!prompt.trim()) {
      res.status(400).json({
        error: { message: 'No content derived from messages', type: 'invalid_request_error' },
      });
      return;
    }

    // Wire request abort to the claude subprocess
    const abortController = new AbortController();
    req.socket?.once('close', () => abortController.abort());

    try {
      const text = await runClaude(prompt, abortController.signal);

      if (body.stream) {
        sendStreamResponse(res, model, text);
      } else {
        res.json(buildCompletionResponse(model, text));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isAuth = /not.authenticated|auth|login|unauthorized|not logged/i.test(message);
      const isMissing = /ENOENT|not found|no such file/i.test(message);
      const status = isAuth ? 401 : isMissing ? 503 : 502;
      res.status(status).json({
        error: {
          message: isAuth
            ? 'Claude is not authenticated — run `claude login` on the cockpit host'
            : isMissing
              ? 'Claude CLI not found — install Claude Code on the cockpit host'
              : `Subscription bridge error: ${message}`,
          type: isAuth ? 'authentication_error' : 'upstream_error',
        },
      });
    }
  });

  // GET /models — minimal models list so the gateway can probe the provider health
  router.get('/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [
        { id: 'claude-subscription', object: 'model', created: 0, owned_by: 'anthropic' },
      ],
    });
  });

  return router;
}
