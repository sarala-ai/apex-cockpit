import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

type PackageJson = {
  version?: string;
};

type GitDescribeCommand = () => string;
type DebugLog = (fields: Record<string, unknown>, message: string) => void;

const requirePackage = createRequire(import.meta.url);
const pkg = requirePackage("../package.json") as PackageJson;

const GIT_DESCRIBE_RE =
  /^v(?<publicVersion>\d+\.\d+\.\d+)-(?<commitsSinceTag>\d+)-g(?<sha>[0-9a-f]{7,40})(?<dirty>-dirty)?$/i;

function defaultDebugLog(fields: Record<string, unknown>, message: string): void {
  console.debug(message, fields);
}

function defaultGitDescribeCommand(): string {
  return execFileSync(
    "git",
    ["describe", "--tags", "--match", "v*", "--long", "--dirty"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    },
  );
}

export function parseGitDescribeVersion(output: string): string | null {
  const match = output.trim().match(GIT_DESCRIBE_RE);
  if (!match?.groups) return null;

  const publicVersion = match.groups.publicVersion;
  const commitsSinceTag = match.groups.commitsSinceTag;
  const sha = match.groups.sha;
  const isDirty = Boolean(match.groups.dirty);

  if (commitsSinceTag === "0" && !isDirty) {
    return publicVersion;
  }

  return `${publicVersion}+${commitsSinceTag}.git.${sha}${isDirty ? ".dirty" : ""}`;
}

export function resolveServerVersion(
  opts: {
    gitDescribeCommand?: GitDescribeCommand;
    packageVersion?: string;
    releaseSha?: string;
    debugLog?: DebugLog;
  } = {},
): string {
  const packageVersion = opts.packageVersion ?? pkg.version ?? "0.0.0";
  const releaseSha = opts.releaseSha ?? process.env.APEX_RELEASE_SHA;
  const gitDescribeCommand = opts.gitDescribeCommand ?? defaultGitDescribeCommand;
  const debugLog = opts.debugLog ?? defaultDebugLog;

  // A hosted image ships without .git (.dockerignore excludes it), so `git
  // describe` can't work there; the build passes the release sha as an env
  // var instead. Local/dev checkouts have no APEX_RELEASE_SHA and fall
  // through to the git-describe path below.
  if (releaseSha) {
    return `${packageVersion}+git.${releaseSha.slice(0, 12)}`;
  }

  try {
    const parsedVersion = parseGitDescribeVersion(gitDescribeCommand());
    if (parsedVersion) return parsedVersion;

    debugLog(
      { reason: "invalid_git_describe" },
      "falling back to package version for server version",
    );
  } catch (err) {
    debugLog(
      { err, reason: "git_describe_unavailable" },
      "falling back to package version for server version",
    );
  }

  return packageVersion;
}

export const serverVersion = resolveServerVersion();
