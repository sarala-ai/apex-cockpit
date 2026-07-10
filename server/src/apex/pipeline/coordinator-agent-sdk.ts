/**
 * CoordinatorAgent backed by the Claude Agent SDK (spec 002).
 *
 * One-shot coordinators that draft the spec and the plan, streaming assistant
 * text to the cockpit as it's produced.
 *
 * Posture tracks the trust context (it is NOT a local security sandbox — the HITL
 * gate is the real control):
 *   - 'plan' (default, attended local): Claude Code plan mode — the agent reads
 *     and explores freely, including `gh` for GitHub context, but cannot mutate.
 *     Drafting stays clean and the gate stays meaningful, with zero setup.
 *   - 'readonly' (unattended/remote): hard tool bound (Read/Grep/Glob only) via a
 *     deny guard — no shell. Pair this with a scoped GitHub MCP server for context.
 *
 * Auth: whatever the local Claude Code has — a web/subscription login (`claude
 * login`, creds in the keychain/~/.claude) OR ANTHROPIC_API_KEY. We do NOT gate
 * on the API key: an env var is not a reliable signal of whether the agent can
 * run, and gating on it would silently downgrade a web-logged-in user to the stub.
 */

import { query, type CanUseTool, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { CoordinatorAgent } from './coordinator.js';
import { StubCoordinator } from './coordinator.js';
import type { Artifact, Task, Ticket } from './types.js';

const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

/** Allow read-only tools; deny anything that could mutate or run commands. */
const readOnlyGuard: CanUseTool = async (toolName, input) =>
  READONLY_TOOLS.has(toolName)
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: `coordinator is read-only; ${toolName} is not permitted` };

interface AgentResult {
  text: string;
  tokens?: number;
  costUsd?: number;
}

/** Trust posture — see the module doc comment. Not a security sandbox. */
export type CoordinatorPosture = 'plan' | 'readonly';

export interface AgentSdkCoordinatorOptions {
  /** Coordinator model. Judgment work → Opus by default. */
  model?: string;
  /** Map a ticket to a local repo checkout so the agent can read it. */
  resolveCwd?: (ticket: Ticket) => string | undefined;
  /** Bound cost/looping. */
  maxTurns?: number;
  /** 'plan' (attended local, default) or 'readonly' (unattended/remote). */
  posture?: CoordinatorPosture;
}

export class AgentSdkCoordinator implements CoordinatorAgent {
  private readonly model: string;
  private readonly resolveCwd: (t: Ticket) => string | undefined;
  private readonly maxTurns: number;
  private readonly posture: CoordinatorPosture;

  constructor(opts: AgentSdkCoordinatorOptions = {}) {
    this.model = opts.model ?? process.env.APEX_TOWER_COORDINATOR_MODEL ?? 'claude-opus-4-8';
    this.resolveCwd = opts.resolveCwd ?? (() => undefined);
    this.maxTurns = opts.maxTurns ?? 24;
    this.posture = opts.posture ?? (process.env.APEX_TOWER_COORDINATOR_POSTURE as CoordinatorPosture) ?? 'plan';
  }

  private async run(prompt: string, systemAppend: string, ticket: Ticket, onData: (c: string) => void): Promise<AgentResult> {
    const strict = this.posture === 'readonly';
    const options: Options = {
      model: this.model,
      cwd: this.resolveCwd(ticket),
      maxTurns: this.maxTurns,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
      // Attended local (plan): read/explore freely incl. `gh`, no mutations — the
      // HITL gate is the control. Unattended/remote (readonly): hard tool bound.
      permissionMode: strict ? 'default' : 'plan',
      ...(strict ? { allowedTools: [...READONLY_TOOLS], canUseTool: readOnlyGuard } : {}),
    };

    let text = '';
    let tokens: number | undefined;
    let costUsd: number | undefined;

    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'assistant') {
        // Stream text blocks as they arrive; ignore thinking/tool_use blocks.
        const blocks = (msg.message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) {
            onData(b.text);
            text += b.text;
          }
        }
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          if (msg.result) text = msg.result; // canonical final text
          costUsd = msg.total_cost_usd;
          const u = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          if (u) tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        } else {
          // Error result — surface it; never treat as a clean draft.
          throw new Error(`coordinator agent errored (${msg.subtype})`);
        }
      }
    }

    if (!text.trim()) throw new Error('coordinator produced no output');
    return { text, tokens, costUsd };
  }

  async spec(ticket: Ticket, onData: (c: string) => void): Promise<Artifact> {
    const prompt =
      `Draft a concise engineering spec (GitHub-flavored markdown) for this ticket. ` +
      `Cover: problem, scope, approach, acceptance criteria, and non-goals. If a repo is ` +
      `available, read the relevant files to ground it. Output ONLY the spec.\n\n` +
      `Ticket ${ticket.id}: ${ticket.title}\n${ticket.url}\n\n${ticket.body}`;
    const r = await this.run(
      prompt,
      'You are a spec coordinator. You draft a tight, implementable spec and stop. Read-only.',
      ticket,
      onData,
    );
    return { kind: 'spec', body: r.text, tokens: r.tokens, costUsd: r.costUsd };
  }

  async plan(
    ticket: Ticket,
    spec: Artifact,
    onData: (c: string) => void,
  ): Promise<{ artifact: Artifact; tasks: Task[] }> {
    const prompt =
      `From this approved spec, produce an implementation plan (markdown) and an ordered ` +
      `task list. Each task must map to a deterministic APEX workflow (build, test, lint, ` +
      `deploy, etc.) — the plan decides WHAT and the order; APEX executes each step.\n\n` +
      `End your reply with a fenced json block, exactly:\n` +
      '```json\n{"tasks":[{"id":"t1","title":"…","workflow":"build","params":{}}]}\n```\n\n' +
      `Spec:\n${spec.body}`;
    const r = await this.run(
      prompt,
      'You are a plan coordinator. You turn a spec into an ordered, APEX-executable task list and stop. Read-only.',
      ticket,
      onData,
    );
    return { artifact: { kind: 'plan', body: r.text, tokens: r.tokens, costUsd: r.costUsd }, tasks: parseTasks(r.text, onData) };
  }
}

/** Extract the trailing ```json {"tasks":[…]} ``` block; fall back safely. */
export function parseTasks(text: string, onData: (c: string) => void): Task[] {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (last) {
    try {
      const parsed = JSON.parse(last) as { tasks?: Array<Partial<Task>> };
      const tasks = (parsed.tasks ?? [])
        .filter((t) => t.title && t.workflow)
        .map((t, i) => ({
          id: t.id ?? `t${i + 1}`,
          title: t.title as string,
          workflow: t.workflow as string,
          params: t.params ?? {},
          status: 'pending' as const,
        }));
      if (tasks.length) return tasks;
    } catch {
      /* fall through */
    }
  }
  onData('\n[plan] could not parse a task block — defaulting to build+test.\n');
  return [
    { id: 't1', title: 'build', workflow: 'build', params: {}, status: 'pending' },
    { id: 't2', title: 'test', workflow: 'test', params: {}, status: 'pending' },
  ];
}

/**
 * Factory. Defaults to the real Agent SDK coordinator, which uses whatever local
 * Claude Code auth exists (web/subscription login OR API key). The stub is an
 * EXPLICIT opt-in for dev (APEX_TOWER_COORDINATOR=stub) — never an automatic
 * fallback, so we don't silently downgrade an authenticated user. If auth is
 * genuinely absent, the SDK surfaces an actionable error (run `claude login`),
 * which the pipeline reports rather than swallowing.
 */
export function createCoordinator(
  opts: AgentSdkCoordinatorOptions = {},
): { coordinator: CoordinatorAgent; kind: 'agent-sdk' | 'stub' } {
  if (process.env.APEX_TOWER_COORDINATOR === 'stub') {
    return { coordinator: new StubCoordinator(), kind: 'stub' };
  }
  return { coordinator: new AgentSdkCoordinator(opts), kind: 'agent-sdk' };
}
