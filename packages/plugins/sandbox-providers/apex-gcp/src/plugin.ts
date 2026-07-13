import { execFile } from "node:child_process";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";

// apex-gcp sandbox provider (apex-tower §5). Provisions a GCE instance as a
// Paperclip execution environment with the APEX CLI installed at boot, and runs
// commands over `gcloud compute ssh`. The lifecycle handlers below construct the
// real gcloud commands; the instance-boot / SSH-readiness timing is the part that
// still needs validation against live GCE (marked NEEDS-LIVE-VALIDATION).

interface ApexGcpConfig {
  projectId: string;
  zone: string;
  apexVersion: string | null;
  serviceAccount: string | null;
  machineType: string;
  imageFamily: string;
  imageProject: string;
  diskSizeGb: number;
  apexIndexUrl: string;
  reuseLease: boolean;
  useIap: boolean;
  timeoutMs: number;
}

const DEFAULTS = {
  machineType: "e2-medium",
  imageFamily: "debian-12",
  imageProject: "debian-cloud",
  diskSizeGb: 20,
  apexIndexUrl: "https://asia-south1-python.pkg.dev/sarala-cicd/sarala-packages/simple/",
  reuseLease: true,
  useIap: false,
  timeoutMs: 1_800_000,
} as const;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function parseConfig(raw: Record<string, unknown>): ApexGcpConfig {
  return {
    projectId: str(raw.projectId) ?? "",
    zone: str(raw.zone) ?? "",
    apexVersion: str(raw.apexVersion),
    serviceAccount: str(raw.serviceAccount),
    machineType: str(raw.machineType) ?? DEFAULTS.machineType,
    imageFamily: str(raw.imageFamily) ?? DEFAULTS.imageFamily,
    imageProject: str(raw.imageProject) ?? DEFAULTS.imageProject,
    diskSizeGb: num(raw.diskSizeGb, DEFAULTS.diskSizeGb),
    apexIndexUrl: str(raw.apexIndexUrl) ?? DEFAULTS.apexIndexUrl,
    reuseLease: bool(raw.reuseLease, DEFAULTS.reuseLease),
    useIap: bool(raw.useIap, DEFAULTS.useIap),
    timeoutMs: num(raw.timeoutMs, DEFAULTS.timeoutMs),
  };
}

/** Deterministic per-environment instance name (RFC1035: lowercase, <=63 chars). */
function instanceName(environmentId: string): string {
  const slug = environmentId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 45);
  return `apex-tower-${slug || "env"}`;
}

interface GcloudResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function runGcloud(args: string[], timeoutMs = 120_000): Promise<GcloudResult> {
  return new Promise((resolve) => {
    execFile(
      "gcloud",
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = (error as { killed?: boolean; signal?: string }).killed === true;
          const code =
            typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : null;
          resolve({ code, stdout, stderr: stderr || String(error), timedOut });
          return;
        }
        resolve({ code: 0, stdout, stderr, timedOut: false });
      },
    );
  });
}

const baseArgs = (c: ApexGcpConfig): string[] => ["--project", c.projectId, "--zone", c.zone];

/**
 * Startup script the instance runs at boot: install the pinned apex CLI from the
 * private AR using the instance's attached-SA ADC (the run-tower.sh mechanism —
 * deferred image, §4). Idempotent; writes a marker when done so readiness is
 * checkable.
 */
function buildStartupScript(c: ApexGcpConfig): string {
  const spec = c.apexVersion ? `apex-platform==${c.apexVersion}` : "apex-platform";
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "test -x /usr/local/bin/apex && { echo 'apex already installed'; exit 0; }",
    "apt-get update -y && apt-get install -y --no-install-recommends python3 python3-venv python3-pip git google-cloud-cli || true",
    "python3 -m venv /opt/apex",
    "/opt/apex/bin/pip install --no-cache-dir --upgrade pip keyrings.google-artifactregistry-auth",
    // ADC on GCE comes from the attached service account via the metadata server.
    `/opt/apex/bin/pip install --no-cache-dir --index-url "${c.apexIndexUrl}" --extra-index-url "https://pypi.org/simple/" "${spec}"`,
    "ln -sf /opt/apex/bin/apex /usr/local/bin/apex",
    "touch /var/run/apex-ready",
  ].join("\n");
}

/** Minimal POSIX single-quote escaping for a remote command string. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function remoteCommand(params: PluginEnvironmentExecuteParams): string {
  const parts: string[] = [];
  if (params.cwd) parts.push(`cd ${shQuote(params.cwd)}`);
  const env: Record<string, string> = params.env ?? {};
  for (const [k, v] of Object.entries(env)) {
    parts.push(`export ${k}=${shQuote(v)}`);
  }
  const argv = [params.command, ...(params.args ?? [])].map(shQuote).join(" ");
  parts.push(argv);
  return parts.join(" && ");
}

async function sshExec(
  c: ApexGcpConfig,
  name: string,
  remoteCmd: string,
  timeoutMs: number,
): Promise<GcloudResult> {
  const args = [
    "compute",
    "ssh",
    name,
    ...baseArgs(c),
    ...(c.useIap ? ["--tunnel-through-iap"] : []),
    "--command",
    remoteCmd,
  ];
  return runGcloud(args, timeoutMs);
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("apex-gcp sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok" as const, message: "apex-gcp sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const c = parseConfig(params.config);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!c.projectId) errors.push("projectId is required.");
    if (!c.zone) errors.push("zone is required (e.g. asia-south1-a).");
    if (c.zone && !/^[a-z]+-[a-z0-9]+-[a-z]$/.test(c.zone)) {
      warnings.push(`zone '${c.zone}' does not look like a GCE zone (region-letter).`);
    }
    if (c.diskSizeGb < 10) errors.push("diskSizeGb must be at least 10.");
    if (c.timeoutMs < 1000 || c.timeoutMs > 86_400_000) {
      errors.push("timeoutMs must be between 1000 and 86400000.");
    }
    if (!c.apexVersion) {
      warnings.push("apexVersion is unset — the instance installs the latest apex, not a pinned version.");
    }
    if (errors.length > 0) return { ok: false, errors, warnings };
    return { ok: true, warnings, normalizedConfig: { ...c } };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const c = parseConfig(params.config);
    // Cheap reachability check: describe the zone (auth + project + zone valid).
    const r = await runGcloud(
      ["compute", "zones", "describe", c.zone, "--project", c.projectId, "--format=value(name)"],
      30_000,
    );
    if (r.code === 0) {
      return { ok: true, summary: `Reached GCP project ${c.projectId}, zone ${c.zone}.` };
    }
    const unauth = /credential|auth|login|permission|denied/i.test(r.stderr);
    return {
      ok: false,
      summary: unauth
        ? "Not authenticated to GCP, or missing permission on the project/zone."
        : `Could not reach project ${c.projectId} / zone ${c.zone}.`,
      diagnostics: [{ severity: "error", message: r.stderr.trim().slice(0, 300) }],
    };
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const c = parseConfig(params.config);
    const name = instanceName(params.environmentId);
    const meta = { zone: c.zone, projectId: c.projectId, useIap: c.useIap };

    // Reuse a running instance if present (warm workspace/state across stages).
    const describe = await runGcloud(
      ["compute", "instances", "describe", name, ...baseArgs(c), "--format=value(status)"],
      30_000,
    );
    if (describe.code === 0) {
      const status = describe.stdout.trim();
      if (status === "TERMINATED") {
        await runGcloud(["compute", "instances", "start", name, ...baseArgs(c)], c.timeoutMs);
      }
      return { providerLeaseId: name, metadata: meta };
    }

    // Otherwise create it with the apex-install startup script. NEEDS-LIVE-VALIDATION:
    // boot + startup-script completion timing (poll /var/run/apex-ready before first
    // exec) is not yet enforced here.
    const create = await runGcloud(
      [
        "compute",
        "instances",
        "create",
        name,
        ...baseArgs(c),
        "--machine-type",
        c.machineType,
        "--image-family",
        c.imageFamily,
        "--image-project",
        c.imageProject,
        `--boot-disk-size=${c.diskSizeGb}GB`,
        "--scopes=cloud-platform",
        ...(c.serviceAccount ? [`--service-account=${c.serviceAccount}`] : []),
        `--metadata=startup-script=${buildStartupScript(c)}`,
        "--format=value(name)",
      ],
      c.timeoutMs,
    );
    if (create.code !== 0) {
      throw new Error(`apex-gcp: failed to create instance ${name}: ${create.stderr.trim().slice(0, 300)}`);
    }
    return { providerLeaseId: name, metadata: meta };
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const c = parseConfig(params.config);
    if (!params.providerLeaseId) return { providerLeaseId: null, metadata: { expired: true } };
    const r = await runGcloud(
      ["compute", "instances", "describe", params.providerLeaseId, ...baseArgs(c), "--format=value(status)"],
      30_000,
    );
    if (r.code !== 0) return { providerLeaseId: null, metadata: { expired: true } };
    return { providerLeaseId: params.providerLeaseId, metadata: { zone: c.zone, projectId: c.projectId } };
  },

  async onEnvironmentReleaseLease(params: PluginEnvironmentReleaseLeaseParams): Promise<void> {
    const c = parseConfig(params.config);
    if (!params.providerLeaseId) return;
    // reuse → stop (warm restart later); otherwise delete.
    const verb = c.reuseLease ? "stop" : "delete";
    const extra = c.reuseLease ? [] : ["--quiet"];
    await runGcloud(["compute", "instances", verb, params.providerLeaseId, ...baseArgs(c), ...extra], c.timeoutMs);
  },

  async onEnvironmentDestroyLease(params: PluginEnvironmentDestroyLeaseParams): Promise<void> {
    const c = parseConfig(params.config);
    if (!params.providerLeaseId) return;
    await runGcloud(
      ["compute", "instances", "delete", params.providerLeaseId, ...baseArgs(c), "--quiet"],
      c.timeoutMs,
    );
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const c = parseConfig(params.config);
    const name = params.lease.providerLeaseId;
    const remoteCwd = params.workspace.remotePath ?? "/workspace";
    if (!name) return { cwd: remoteCwd };
    // Ensure the workspace dir exists. Git population (clone/sync) is layered on
    // top later; scope here is a ready working directory.
    await sshExec(c, name, `mkdir -p ${shQuote(remoteCwd)}`, 120_000);
    return { cwd: remoteCwd, metadata: { remoteCwd } };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    const c = parseConfig(params.config);
    const name = params.lease.providerLeaseId;
    if (!name) {
      return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "apex-gcp: no instance lease" };
    }
    const r = await sshExec(c, name, remoteCommand(params), params.timeoutMs ?? c.timeoutMs);
    return {
      exitCode: r.code,
      signal: null,
      timedOut: r.timedOut,
      stdout: r.stdout,
      stderr: r.stderr,
      metadata: { instance: name, zone: c.zone },
    };
  },
});

export default plugin;
