import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetShellOptions,
} from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

const SEEDED_SHARED_FILES = ["settings.json", "CLAUDE.md"] as const;

interface SeedFile {
  name: string;
  sourcePath: string;
  contents: Buffer;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function sanitizeRemoteClaudeSettings(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  const settings = { ...(parsed as Record<string, unknown>) };
  settings.permissions = { defaultMode: "default" };
  delete settings.hooks;
  // Strip UNTRUSTED repo/user mcpServers from the seeded settings — the trusted
  // gateway MCP config is injected separately via --mcp-config (buildGatewayMcpConfig).
  delete settings.mcpServers;
  delete settings.permissionMode;
  delete settings.skipDangerousModePermissionPrompt;
  return JSON.stringify(settings);
}

/**
 * Build the TRUSTED apex-gateway MCP config for a run, or null when the gateway
 * isn't configured. Env-driven and refresh-tolerant: the run-env builder supplies
 * a short-lived GATEWAY JWT in `APEX_GATEWAY_TOKEN` (the adapter does NOT mint or
 * fetch it, and never caches it across runs — it's read fresh from the run env
 * each execution). The `Authorization` header uses the literal `${APEX_GATEWAY_TOKEN}`
 * so the Claude CLI resolves it from the run env at spawn time, and the token
 * value is never written to disk. Client transport is streamable-HTTP (`type:"http"`)
 * against the gateway's catch-all `/mcp` endpoint.
 *
 * NOTE: this injects the FULL gateway tool surface for any run whose env carries
 * the token — per-project / per-agent tool SCOPING is a later pass.
 */
export function buildGatewayMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): { mcpServers: Record<string, unknown> } | null {
  if (!nonEmpty(env.APEX_GATEWAY_TOKEN)) return null;
  const explicitMcpUrl = nonEmpty(env.APEX_GATEWAY_MCP_URL);
  const baseUrl = nonEmpty(env.APEX_GATEWAY_URL) ?? "http://localhost:4444";
  const mcpUrl = explicitMcpUrl ?? `${baseUrl.replace(/\/+$/, "")}/mcp`;
  return {
    mcpServers: {
      "apex-gateway": {
        type: "http",
        url: mcpUrl,
        headers: { Authorization: "Bearer ${APEX_GATEWAY_TOKEN}" },
      },
    },
  };
}

async function collectSeedFiles(sourceDir: string): Promise<SeedFile[]> {
  const files: SeedFile[] = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    const rawContents = await fs.readFile(sourcePath);
    const contents = name === "settings.json"
      ? Buffer.from(sanitizeRemoteClaudeSettings(rawContents.toString("utf8")), "utf8")
      : rawContents;
    files.push({ name, sourcePath, contents });
  }
  return files;
}

async function buildSeedSnapshotKey(files: SeedFile[]): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: SeedFile[];
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.writeFile(path.join(stagingDir, file.name), file.contents);
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}

export function buildRemoteClaudeConfigMaterializationCommand(input: {
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
}): string {
  return `mkdir -p ${shellQuote(input.remoteClaudeConfigDir)} && ` +
    `if [ -d ${shellQuote(input.remoteClaudeConfigSeedDir)} ]; then ` +
    `cp -R ${shellQuote(`${input.remoteClaudeConfigSeedDir}/.`)} ${shellQuote(input.remoteClaudeConfigDir)}/; ` +
    `fi; ` +
    `for file in .credentials.json credentials.json; do ` +
    `if [ -n "\${HOME:-}" ] && [ -f "\${HOME}/.claude/\${file}" ] && [ ! -f ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}" ]; then ` +
    `cp "\${HOME}/.claude/\${file}" ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}"; ` +
    `fi; ` +
    `done`;
}

export async function materializeRemoteClaudeConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: input.remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir: input.remoteClaudeConfigSeedDir,
    }),
    input.options,
  );
}
