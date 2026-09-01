/**
 * Contract run targets — APEX-38.
 *
 * A lifecycle names WHAT must be true ("checks pass", "deployed"), never the
 * tool. The seeded lifecycles used to hardcode `pytest tests/unit` and the
 * `cloud_run_deploy` workflow, which made every non-Python, non-Cloud-Run
 * project fail its checks on TOOL MISMATCH rather than on the work.
 *
 * A `contract` target is declared on the stage and resolved HERE, at dispatch
 * time, from the case's pipeline's project — its primary workspace declares
 * `checkCommand` (how this stack verifies itself) and `deployWorkflow` (the
 * APEX workflow that ships it). Resolution is deliberately a lookup, not a
 * guess: a project that declares nothing gets a CLASSIFIED failure, which the
 * run step's no-failure-route default turns into an honest HOLD — never an
 * invocation of a tool the project never declared.
 *
 * Trust boundary: the resolved `shell` target executes on the host, but its
 * command comes from `project_workspaces.check_command` — the same surface as
 * the workspace's `setup_command`, which already executes on the host and is
 * governed by who may edit project workspaces. Authoring a `contract` target
 * on a stage names no tool at all, which is why it is exempt from the
 * `command`-target authoring restriction in services/pipelines.ts.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { projectWorkspaces } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { RunTarget } from "../steps/step-executor.js";

export const RUN_CONTRACTS = ["checks_pass", "deployed", "security_clean"] as const;
export type RunContract = (typeof RUN_CONTRACTS)[number];

export type ContractRunTarget = { type: "contract"; contract: RunContract };

export function isRunContract(value: unknown): value is RunContract {
  return typeof value === "string" && (RUN_CONTRACTS as readonly string[]).includes(value);
}

/**
 * WHERE A PROJECT'S DESIGN LIVES, as `owner/name` plus an optional folder.
 *
 * Two shapes, because both are real: a dedicated design repository, and a
 * folder inside the project's own monorepo. `designRepo` decides which — set,
 * it wins; unset, design lives in this project's own repo and the coordinate
 * is derived from `repoUrl`.
 */
export type DesignCoordinates = { repo: string; path: string };

// Deliberately excludes ':' and '@' rather than "anything without a slash".
// `git@github.com-ck:sarala-ai/apex-cockpit.git` contains exactly one slash, so
// a looser pattern accepts the whole SSH URL as if it were already a slug and
// hands a garbage repo to the GitHub API.
const OWNER_NAME_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * `owner/name` from a git remote, or null. Accepts the three forms a workspace
 * actually stores — ssh, ssh-with-host-alias (`git@github.com-ck:o/n.git`, the
 * form this instance uses) and https — because a coordinate that only works
 * for one of them fails at dispatch on somebody else's machine.
 */
export function ownerNameFromRepoUrl(repoUrl: string | null | undefined): string | null {
  const value = (repoUrl ?? "").trim();
  if (!value) return null;
  if (OWNER_NAME_RE.test(value)) return value.replace(/\.git$/, "");
  const match =
    /^git@[^:]+:(.+?)(?:\.git)?$/.exec(value) ??
    /^(?:https?|ssh):\/\/[^/]+\/(.+?)(?:\.git)?$/.exec(value);
  const slug = match?.[1]?.replace(/^\/+|\/+$/g, "");
  return slug && OWNER_NAME_RE.test(slug) ? slug : null;
}

export type DesignResolution =
  | { ok: true; coordinates: DesignCoordinates }
  | { ok: false; errorType: string; message: string };

/**
 * Resolve design coordinates from the project's primary workspace, or refuse
 * with a message naming what to declare and where.
 *
 * Refusing matters more here than for most config: the fallback anyone would
 * reach for is "the repo we always used", and on a company-shared lifecycle
 * that means pushing one company's design into another's repository. There is
 * no safe default, so there is no default.
 */
export async function resolveDesignCoordinates(
  db: Db,
  input: { companyId: string; projectId: string | null },
): Promise<DesignResolution> {
  if (!input.projectId) {
    return {
      ok: false,
      errorType: "design_source_unresolvable",
      message:
        `the design lifecycle resolves its repository from project workspace config, ` +
        `but neither this pipeline nor the case's work issue names a project — link one`,
    };
  }
  const workspace = await db
    .select({
      name: projectWorkspaces.name,
      repoUrl: projectWorkspaces.repoUrl,
      designRepo: projectWorkspaces.designRepo,
      designPath: projectWorkspaces.designPath,
    })
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
      ),
    )
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!workspace) {
    return {
      ok: false,
      errorType: "design_source_unresolvable",
      message:
        `the design lifecycle resolves its repository from project workspace config, ` +
        `but this project has no workspace`,
    };
  }

  const declared = workspace.designRepo?.trim();
  // Declared design repo wins; otherwise design lives in this project's own
  // repo — the monorepo case, where only a folder was declared.
  const repo = declared || ownerNameFromRepoUrl(workspace.repoUrl);
  if (!repo) {
    return {
      ok: false,
      errorType: "design_repo_not_configured",
      message:
        `project workspace "${workspace.name}" declares no designRepo, and its repoUrl ` +
        `(${workspace.repoUrl ?? "unset"}) does not yield an owner/name to fall back on. ` +
        `Holding the design stage rather than pushing to a repository this project never ` +
        `named. Declare designRepo for a separate design repo, or repoUrl + designPath ` +
        `for a design folder inside this project's own repo.`,
    };
  }
  if (!OWNER_NAME_RE.test(repo)) {
    return {
      ok: false,
      errorType: "design_repo_not_configured",
      message:
        `project workspace "${workspace.name}" declares designRepo "${repo}", which is not ` +
        `in owner/name form (e.g. "sarala-ai/apex-design")`,
    };
  }

  return {
    ok: true,
    coordinates: {
      repo,
      // Normalised to no leading/trailing slash so templates can join it with
      // a filename without caring which side carried the separator.
      path: (workspace.designPath ?? "").trim().replace(/^\/+|\/+$/g, ""),
    },
  };
}

export type ContractResolution =
  | { ok: true; target: RunTarget }
  | { ok: false; errorType: string; message: string };

/**
 * Resolve a contract to the concrete target the project declares, or a
 * classified refusal. Every refusal message says what to declare and where —
 * the person reading the hold is the person who can fix it.
 */
export async function resolveContractRunTarget(
  db: Db,
  input: { companyId: string; projectId: string | null; contract: RunContract },
): Promise<ContractResolution> {
  if (!input.projectId) {
    return {
      ok: false,
      errorType: "contract_unresolvable",
      message:
        `the '${input.contract}' contract resolves from project workspace config, ` +
        `but neither this pipeline nor the case's work issue names a project — ` +
        `link one, or declare a concrete target on the stage`,
    };
  }
  const workspace = await db
    .select({
      name: projectWorkspaces.name,
      cwd: projectWorkspaces.cwd,
      checkCommand: projectWorkspaces.checkCommand,
      deployWorkflow: projectWorkspaces.deployWorkflow,
    })
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
      ),
    )
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!workspace) {
    return {
      ok: false,
      errorType: "contract_unresolvable",
      message:
        `the '${input.contract}' contract resolves from project workspace config, ` +
        `but this project has no workspace`,
    };
  }

  if (input.contract === "checks_pass") {
    const command = workspace.checkCommand?.trim();
    if (!command) {
      return {
        ok: false,
        errorType: "check_command_not_configured",
        message:
          `project workspace "${workspace.name}" declares no check command; ` +
          `holding the checks stage instead of guessing a test runner. ` +
          `Declare checkCommand on the project's primary workspace (e.g. "npm test").`,
      };
    }
    return { ok: true, target: { type: "shell", command, cwd: workspace.cwd ?? null } };
  }

  if (input.contract === "security_clean") {
    // The ONE contract that needs no per-project declaration, and the reason
    // is worth stating: "check that this stack passes its tests" and "ship
    // this stack" are stack-specific, so the project has to name the tool.
    // "look for committed secrets" is not — it is the same operation for a
    // Python repo, a Node repo and a Terraform module, with the same rules,
    // because the rules ship inside apex rather than per repo.
    //
    // So this resolves to a COMMAND target, not a shell one. checks_pass
    // resolves to shell because the project's own check command is arbitrary
    // by design; here an arbitrary shell string would let a project define its
    // own idea of "clean" and defeat the gate. A command target pins both the
    // tool and the report shape the gate reads.
    return {
      ok: true,
      target: {
        type: "command",
        tool: "security scan-secrets",
        args: ["--path", workspace.cwd ?? "."],
      },
    };
  }

  const workflow = workspace.deployWorkflow?.trim();
  if (!workflow) {
    return {
      ok: false,
      errorType: "deploy_workflow_not_configured",
      message:
        `project workspace "${workspace.name}" declares no deploy workflow; ` +
        `holding the deploy stage instead of invoking a deploy this project never declared. ` +
        `Declare deployWorkflow on the project's primary workspace to enable it.`,
    };
  }
  return { ok: true, target: { type: "workflow", workflow, params: {} } };
}
