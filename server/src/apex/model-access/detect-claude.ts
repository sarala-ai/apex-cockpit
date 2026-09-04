/**
 * Claude subscription detection — answers "is this machine capable of serving
 * model calls through the Claude Agent SDK subscription bridge?"
 *
 * Detection is intentionally lightweight so it can be called on every
 * GET /setup/state poll (every few seconds from the setup wizard UI).
 * Heavy verification (actually running a query) is NOT done here; the
 * provision endpoint does a real probe before generating artifacts.
 *
 * Detection priority (first match wins):
 * 1. ANTHROPIC_API_KEY env — marks api_key mode (gateway LiteLLM backend),
 *    NOT subscription mode. Reported separately so the UI can show the correct
 *    card state.
 * 2. CLAUDE_CODE_OAUTH_TOKEN env — remote subscription mode (setup-token
 *    minted by a human founder run; remote executor will pick it up via
 *    APEX-101 slot).
 * 3. Local Claude CLI with active login — zero-credential local mode.
 *    We check: (a) claude binary present, (b) OS keychain entry or session
 *    daemon signs of a logged-in account.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Db } from '@paperclipai/db';
import { run } from '../exec.js';
import {
  readWorkstationReport,
  serverIsOperatorWorkstation,
  workstationReportIsStale,
} from '../setup/operator-auth.js';

/** `unknown` = nobody who could answer has answered (hosted cockpit, no
 *  workstation report). Never inferred from the container. */
export type ClaudeAuthMode = 'subscription_local' | 'subscription_remote' | 'api_key' | 'none' | 'unknown';

export interface ClaudeDetectResult {
  mode: ClaudeAuthMode;
  /** null = unknown. */
  installed: boolean | null;
  /** Who answered: this server's own probe, the operator's workstation
   *  report, or nobody. */
  source: 'server' | 'workstation' | 'unknown';
  reportedAt: string | null;
}

export const UNKNOWN_CLAUDE_DETECT: ClaudeDetectResult = {
  mode: 'unknown',
  installed: null,
  source: 'unknown',
  reportedAt: null,
};

/** ~/.claude directory — where Claude Code persists login state. */
const claudeDir = () => path.join(os.homedir(), '.claude');

/**
 * Check for evidence of a local claude login without spawning claude itself.
 * Heuristic: the daemon/ dir exists and has a socket or session-related files,
 * OR the sessions/ dir has a recent .json file (indicating an active session
 * was established at some point).
 */
async function hasLocalClaudeLogin(): Promise<boolean> {
  const dir = claudeDir();
  // macOS keychain check — Claude Code stores OAuth under service "claude.ai"
  // with account "login". Presence = an oauth token is stored.
  if (process.platform === 'darwin') {
    const res = await run('security', ['find-generic-password', '-s', 'claude.ai', '-a', 'login'], 3000);
    if (res.status === 'ok') return true;
  }

  // Cross-platform: check ~/.claude/CREDENTIALS or ~/.claude/.credentials.json
  for (const fname of ['.credentials.json', 'CREDENTIALS']) {
    try {
      await fs.access(path.join(dir, fname));
      return true;
    } catch {
      // not found — continue
    }
  }

  // Sessions dir with at least one JSON file is a soft signal that claude was
  // previously logged in (the files aren't cleaned up on logout).
  const sessionsDir = path.join(dir, 'sessions');
  try {
    const entries = await fs.readdir(sessionsDir);
    return entries.some((e) => e.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * Detect how (if at all) Claude model calls can be made from this instance.
 * Never throws — returns `{mode: 'none'}` on any failure.
 */
export async function detectClaudeAuth(): Promise<ClaudeDetectResult> {
  // --- Step 1: is the claude CLI installed? ---
  const versionRes = await run('claude', ['--version'], 4000);
  const installed = versionRes.status === 'ok';
  const base = { installed, source: 'server' as const, reportedAt: null };

  // --- Step 2: classify the auth mode ---
  // api_key mode: explicit key overrides any local login
  if (process.env.ANTHROPIC_API_KEY) {
    return { mode: 'api_key', ...base };
  }

  // Remote subscription: CLAUDE_CODE_OAUTH_TOKEN is set (APEX-101 slot, seeded
  // by a founder-run `claude setup-token`)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { mode: 'subscription_remote', ...base };
  }

  // Local subscription: claude is installed and shows signs of an active login
  if (installed && (await hasLocalClaudeLogin())) {
    return { mode: 'subscription_local', ...base };
  }

  return { mode: 'none', ...base };
}

/**
 * Claude detection scoped to the operator. On the operator's own workstation
 * (local_trusted) the server probes itself. On a hosted cockpit the container
 * has the CLI installed (image) and is never logged in, so neither fact is the
 * operator's: the answer comes from the operator's workstation report, and is
 * `unknown` when there is none or it is stale. A workstation login does not
 * make this server able to call Claude; the claudeSession step owns that.
 */
export async function detectClaudeAuthForOperator(
  db: Db,
  userId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeDetectResult> {
  if (serverIsOperatorWorkstation(env)) return detectClaudeAuth();
  if (!userId) return UNKNOWN_CLAUDE_DETECT;
  const row = await readWorkstationReport(db, userId);
  if (!row || workstationReportIsStale(row)) return UNKNOWN_CLAUDE_DETECT;
  const claude = row.report.claude;
  const loggedIn = claude.loggedIn ?? null;
  return {
    installed: claude.installed,
    mode: !claude.installed || loggedIn === false ? 'none' : loggedIn === true ? 'subscription_local' : 'unknown',
    source: 'workstation',
    reportedAt: row.reportedAt.toISOString(),
  };
}
