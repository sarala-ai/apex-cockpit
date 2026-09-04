// Shared launch helper for the desktop Electron test suite.
//
// Every spec gets its own throwaway userData directory via the
// APEX_DESKTOP_USER_DATA_DIR test seam (desktop/src/main.ts) — tests never
// touch the operator's real profile, token, or config. Callers can seed the
// config file into that directory before launching (the app reads it fresh
// on startup; the on-disk shape is documented in main.ts as
// apex-desktop-config.json).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, type ElectronApplication } from "@playwright/test";

export const DESKTOP_ROOT = path.resolve(__dirname, "..", "..");
export const MAIN_JS = path.join(DESKTOP_ROOT, "dist", "main.js");

export interface CockpitConfig {
  mode: "local" | "remote";
  cockpitUrl: string;
}

/** Creates a fresh, isolated userData directory for one test run. */
export function makeUserDataDir(prefix = "apex-desktop-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Writes apex-desktop-config.json into a userData dir before the app reads it. */
export function seedConfig(userDataDir: string, config: CockpitConfig): void {
  fs.writeFileSync(
    path.join(userDataDir, "apex-desktop-config.json"),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}

export interface LaunchOptions {
  userDataDir?: string;
  /** Extra env vars, e.g. the APEX_DESKTOP_TEST_BOARD_TOKEN test seam. */
  env?: Record<string, string>;
}

/**
 * Launches the built desktop app (dist/main.js) against an isolated userData
 * dir. Fails fast with a clear message if `npm run build` hasn't been run.
 */
export async function launchDesktopApp(
  opts: LaunchOptions = {},
): Promise<{ app: ElectronApplication; userDataDir: string }> {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(
      `${MAIN_JS} not found — run "npm run build" in desktop/ before running these tests.`,
    );
  }
  const userDataDir = opts.userDataDir ?? makeUserDataDir();
  const app = await electron.launch({
    args: [MAIN_JS],
    cwd: DESKTOP_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      APEX_DESKTOP_USER_DATA_DIR: userDataDir,
      ...opts.env,
    },
  });
  return { app, userDataDir };
}
