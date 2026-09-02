// APEX desktop — Electron main process.
//
// This process owns three responsibilities and nothing else:
//   1. Render the cockpit web UI at a URL read from config (never hardcoded —
//      the same binary must point at a local dev server or a remote deployment
//      depending on where the operator is working).
//   2. Custody of the subscription token via OS-backed encryption
//      (Electron safeStorage). Plaintext-on-disk is never an acceptable
//      fallback for a credential, so encryption unavailability is a hard
//      error, not a degraded mode.
//   3. Supervise a local `apex` CLI child process on behalf of the renderer,
//      so the cockpit can drive a runner without the renderer ever touching
//      Node/child_process directly (contextIsolation stays intact).

import { app, BrowserWindow, ipcMain, safeStorage, session, shell, IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface CockpitConfig {
  mode: "local" | "remote";
  cockpitUrl: string;
}

// Sensible default for the installed app: the deployed cockpit. Still fully
// overridable — the config file (apex-desktop-config.json in userData) is read
// fresh each launch, so an operator can point it at a local dev server instead.
const DEFAULT_CONFIG: CockpitConfig = {
  mode: "remote",
  cockpitUrl: "https://apex-cockpit-5ixbpif2cq-el.a.run.app",
};

const CONFIG_FILENAME = "apex-desktop-config.json";
const TOKEN_FILENAME = "apex-desktop-token.enc";

function configPath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILENAME);
}

function tokenPath(): string {
  return path.join(app.getPath("userData"), TOKEN_FILENAME);
}

// Config is read fresh from disk (not cached in memory) so an operator can
// hand-edit the file between local and remote mode without rebuilding.
function loadConfig(): CockpitConfig {
  const p = configPath();
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      mode: raw.mode === "remote" ? "remote" : "local",
      cockpitUrl: typeof raw.cockpitUrl === "string" && raw.cockpitUrl.length > 0
        ? raw.cockpitUrl
        : DEFAULT_CONFIG.cockpitUrl,
    };
  } catch {
    // A corrupt config file must not crash the app or silently point at an
    // unexpected URL — fall back to the known-safe local default.
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: CockpitConfig): void {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

let mainWindow: BrowserWindow | null = null;
let runnerProcess: ChildProcessWithoutNullStreams | null = null;

// In-memory mirror of the stored board token, so the per-request Bearer injector
// never has to hit disk/decrypt on every asset load. Kept in sync by storeToken/
// clearToken and seeded once at startup.
let cachedBoardToken: string | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Surface load/render failures instead of silently showing a white screen,
  // and open DevTools in dev so the renderer console is visible.
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[desktop] did-fail-load ${code} ${desc} — ${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[desktop] render-process-gone: ${details.reason}`);
  });
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  loadAppropriateView();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Route by auth state: with a stored board token, load the cockpit (the Bearer
// injector authenticates it); without one, show the native sign-in screen so the
// operator can authenticate via the system-browser cli-auth handoff. Google
// OAuth never runs inside this Electron window (embedded webviews are blocked by
// Google) — it happens in the real browser during approval.
function loadAppropriateView(): void {
  if (!mainWindow) return;
  const hasToken = readToken().token !== null;
  if (hasToken) {
    mainWindow
      .loadURL(loadConfig().cockpitUrl)
      .catch((err) => console.error(`[desktop] cockpit load failed: ${(err as Error).message}`));
  } else {
    mainWindow
      .loadFile(path.join(__dirname, "signin.html"))
      .catch((err) => console.error(`[desktop] sign-in view load failed: ${(err as Error).message}`));
  }
}

// ---- Token custody -----------------------------------------------------
// safeStorage is backed by Keychain (macOS) / DPAPI (Windows) / libsecret
// (Linux). Only the ciphertext ever touches disk; the key never leaves the
// OS keystore. If the platform cannot provide encryption we refuse to
// store the token at all rather than degrade to a plaintext file.
//
// The stored credential is the board API token obtained via the cockpit's
// cli-auth challenge flow (see auth:login). These helpers are the single
// custody point — the IPC handlers, the auth flow, and the Bearer injector all
// go through them, and the raw token is never returned to the renderer.

function storeToken(token: string): { ok: boolean; error?: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "OS-level encryption is unavailable; refusing to store token." };
  }
  fs.writeFileSync(tokenPath(), safeStorage.encryptString(token));
  cachedBoardToken = token;
  return { ok: true };
}

function readToken(): { ok: boolean; token: string | null; error?: string } {
  const p = tokenPath();
  if (!fs.existsSync(p)) {
    return { ok: true, token: null };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, token: null, error: "OS-level encryption is unavailable; cannot decrypt stored token." };
  }
  try {
    return { ok: true, token: safeStorage.decryptString(fs.readFileSync(p)) };
  } catch (err) {
    return { ok: false, token: null, error: `Failed to decrypt stored token: ${(err as Error).message}` };
  }
}

function clearToken(): void {
  const p = tokenPath();
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
  cachedBoardToken = null;
}

ipcMain.handle("token:set", (_event: IpcMainInvokeEvent, token: string) => storeToken(token));

// token:get intentionally still returns the token — it predates the auth flow
// and is the renderer's explicit request for a token it set itself. The auth
// flow's board token is never surfaced this way (auth:status returns presence
// only).
ipcMain.handle("token:get", () => readToken());

ipcMain.handle("token:clear", () => {
  clearToken();
  return { ok: true };
});

// ---- Config --------------------------------------------------------------

ipcMain.handle("config:get", () => loadConfig());

ipcMain.handle("config:set", (_event: IpcMainInvokeEvent, config: CockpitConfig) => {
  saveConfig(config);
  return { ok: true };
});

// ---- Board authentication (cli-auth challenge browser handoff) -----------
// Desktop sign-in reuses the cockpit's cli-auth challenge flow: create a
// challenge, open the approval URL in the SYSTEM browser (so Google SSO runs in
// a real browser — Google rejects OAuth inside an embedded webview), poll until
// approved, then store the returned board API token. The rendered cockpit is
// then authenticated by injecting that token as a Bearer for the cockpit origin
// only (installCockpitBearerInjector). Mirrors cli/src/client/board-auth.ts.

interface CreateChallengeResponse {
  id: string;
  token: string; // challenge secret used for polling
  boardApiToken: string; // the board API key to store + use
  approvalPath: string;
  approvalUrl: string | null;
  pollPath: string;
  expiresAt: string;
  suggestedPollIntervalMs: number;
}

interface ChallengeStatusResponse {
  status: "pending" | "approved" | "cancelled" | "expired";
  approvedByUser: { id: string; name: string; email: string } | null;
}

function normalizeApiBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message = body && typeof body.error === "string" ? body.error : `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

let authLoginInFlight = false;

ipcMain.handle("auth:login", async () => {
  if (authLoginInFlight) {
    return { ok: false, error: "A sign-in is already in progress." };
  }
  authLoginInFlight = true;
  const emitProgress = (message: string) => mainWindow?.webContents.send("auth:progress", message);
  try {
    const apiBase = normalizeApiBase(loadConfig().cockpitUrl);
    emitProgress("Requesting sign-in challenge…");
    const challenge = await requestJson<CreateChallengeResponse>(`${apiBase}/api/cli-auth/challenges`, {
      method: "POST",
      body: JSON.stringify({
        command: "apex desktop login",
        clientName: "APEX Desktop",
        requestedAccess: "board",
        requestedCompanyId: null,
      }),
    });

    const approvalUrl = challenge.approvalUrl ?? `${apiBase}${challenge.approvalPath}`;
    emitProgress("Opening your browser to approve sign-in…");
    await shell.openExternal(approvalUrl);
    emitProgress("Waiting for approval in your browser…");

    const expiresAtMs = Date.parse(challenge.expiresAt);
    const pollMs = Math.max(500, challenge.suggestedPollIntervalMs || 1000);
    while (Number.isFinite(expiresAtMs) ? Date.now() < expiresAtMs : true) {
      const status = await requestJson<ChallengeStatusResponse>(
        `${apiBase}/api${challenge.pollPath}?token=${encodeURIComponent(challenge.token)}`,
      );
      if (status.status === "approved") {
        const stored = storeToken(challenge.boardApiToken);
        if (!stored.ok) return { ok: false, error: stored.error };
        // Now authenticated — leave the sign-in screen and load the cockpit (the
        // Bearer injector attaches the token the injector now reads).
        loadAppropriateView();
        return { ok: true, userId: status.approvedByUser?.id ?? null };
      }
      if (status.status === "cancelled") return { ok: false, error: "Sign-in was cancelled." };
      if (status.status === "expired") return { ok: false, error: "Sign-in expired before approval." };
      await sleep(pollMs);
    }
    return { ok: false, error: "Sign-in expired before approval." };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    authLoginInFlight = false;
  }
});

// Presence only — never returns the token itself.
ipcMain.handle("auth:status", () => {
  const r = readToken();
  if (!r.ok) return { ok: false, authenticated: false, error: r.error };
  return { ok: true, authenticated: r.token !== null };
});

ipcMain.handle("auth:logout", async () => {
  const r = readToken();
  const token = r.ok ? r.token : null;
  clearToken();
  if (token) {
    try {
      const apiBase = normalizeApiBase(loadConfig().cockpitUrl);
      await requestJson(`${apiBase}/api/cli-auth/revoke-current`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
    } catch {
      // Local credential is already cleared; a failed server revoke must not block logout.
    }
  }
  // Token cleared → route back to the native sign-in screen.
  loadAppropriateView();
  return { ok: true };
});

// Attaches the board token as a Bearer header ONLY to requests bound for the
// configured cockpit origin — never to any other host. This is what makes the
// rendered cockpit web UI authenticate as the board user.
function installCockpitBearerInjector(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    let cockpitOrigin: string | null = null;
    try {
      cockpitOrigin = new URL(loadConfig().cockpitUrl).origin;
    } catch {
      cockpitOrigin = null;
    }
    let requestOrigin: string | null = null;
    try {
      requestOrigin = new URL(details.url).origin;
    } catch {
      requestOrigin = null;
    }
    if (cockpitOrigin && requestOrigin === cockpitOrigin && cachedBoardToken) {
      details.requestHeaders["Authorization"] = `Bearer ${cachedBoardToken}`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

// ---- Claude session ceremony --------------------------------------------
// Triggered from the cockpit's setup wizard when it runs inside the desktop:
// spawns `apex claude connect` (the browser-completion flow) and opens its
// localhost page in an in-app window. Cockpit-origin links inside that page
// stay in-app (this session injects the board Bearer, so the CLI-access
// approval is a signed-in one-click); Anthropic links go to the system
// browser where the operator's claude.ai session lives. The two consent acts
// stay human — this only removes every step around them.
let claudeConnectProcess: ChildProcessWithoutNullStreams | null = null;

ipcMain.handle(
  "claude:connect",
  (_event: IpcMainInvokeEvent, opts: { companyId: string; definitionKey?: string }) => {
    if (claudeConnectProcess) {
      return { ok: false, error: "A connect ceremony is already in progress." };
    }
    if (!opts?.companyId) {
      return { ok: false, error: "companyId is required." };
    }
    const cfg = loadConfig();
    const args = [
      "claude",
      "connect",
      "--cockpit-url",
      cfg.cockpitUrl,
      "--company-id",
      opts.companyId,
      ...(opts.definitionKey ? ["--definition-key", opts.definitionKey] : []),
    ];
    try {
      const child = spawn("apex", args, { stdio: "pipe" });
      claudeConnectProcess = child;
      let opened = false;
      const watch = (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        mainWindow?.webContents.send("claude:connect:output", text);
        const m = text.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (m && !opened) {
          opened = true;
          const flowWindow = new BrowserWindow({
            width: 760,
            height: 640,
            title: "Connect Claude subscription",
            webPreferences: { contextIsolation: true, nodeIntegration: false },
          });
          const cockpitOrigin = new URL(cfg.cockpitUrl).origin;
          flowWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (new URL(url).origin === cockpitOrigin) {
              return { action: "allow" }; // in-app: session carries the board Bearer
            }
            void shell.openExternal(url); // Anthropic → system browser (claude.ai session)
            return { action: "deny" };
          });
          void flowWindow.loadURL(m[0]);
        }
      };
      child.stdout.on("data", watch);
      child.stderr.on("data", watch);
      child.on("exit", (code: number | null) => {
        mainWindow?.webContents.send("claude:connect:exit", { code });
        claudeConnectProcess = null;
      });
      return { ok: true, pid: child.pid };
    } catch (err) {
      claudeConnectProcess = null;
      return { ok: false, error: `Failed to start ceremony: ${(err as Error).message}` };
    }
  }
);

// ---- Runner supervision --------------------------------------------------
// The runner is a single supervised child process. Only one instance is
// tracked at a time; starting a new one while a previous one is alive is
// rejected rather than silently orphaning the old process.

ipcMain.handle(
  "runner:start",
  (_event: IpcMainInvokeEvent, opts: { command?: string; args?: string[] } | undefined) => {
    if (runnerProcess) {
      return { ok: false, error: "Runner is already running." };
    }
    const command = opts?.command && opts.command.length > 0 ? opts.command : "apex";
    const args = opts?.args ?? [];

    try {
      const child = spawn(command, args, { stdio: "pipe" });
      runnerProcess = child;

      child.stdout.on("data", (chunk: Buffer) => {
        mainWindow?.webContents.send("runner:stdout", chunk.toString("utf-8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        mainWindow?.webContents.send("runner:stderr", chunk.toString("utf-8"));
      });
      child.on("exit", (code: number | null, signal: string | null) => {
        mainWindow?.webContents.send("runner:exit", { code, signal });
        runnerProcess = null;
      });

      return { ok: true, pid: child.pid };
    } catch (err) {
      runnerProcess = null;
      return { ok: false, error: `Failed to spawn runner: ${(err as Error).message}` };
    }
  }
);

ipcMain.handle("runner:stop", () => {
  if (!runnerProcess) {
    return { ok: true };
  }
  runnerProcess.kill();
  runnerProcess = null;
  return { ok: true };
});

function stopRunner(): void {
  if (runnerProcess) {
    runnerProcess.kill();
    runnerProcess = null;
  }
}

// ---- Cloud auth broker (GCP) ---------------------------------------------
// The local observability pane runs gcloud + apex-core under the OPERATOR's own
// Google identity — no service-account keys, no baked secrets. This process
// brokers that identity: it checks whether Application Default Credentials are
// usable and, when they are not, runs the interactive
// `gcloud auth application-default login`, which opens the browser for the user
// to complete sign-in (MCP-OAuth-style). Day-to-day access-token refresh is
// handled by gcloud/google-auth from the stored refresh token; this broker only
// re-runs login when ADC is absent or its refresh token is revoked.

// Captures output WITHOUT broadcasting to the renderer — used for commands whose
// output may contain a credential (e.g. print-access-token). The token is never
// returned to callers or the renderer; only the exit code / non-secret fields.
function runCaptured(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { stdio: "pipe" });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.on("error", (err) => reject(err));
    child.on("exit", (code: number | null) => resolve({ code, stdout, stderr }));
  });
}

// Streams output to the renderer — safe ONLY for commands that do not print
// secrets. `application-default login` prints a consent URL and a
// "Credentials saved to file" notice; the token itself is written by gcloud to
// the ADC file, never to stdout.
function runStreamed(command: string, args: string[]): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { stdio: "pipe" });
    } catch (err) {
      reject(err);
      return;
    }
    child.stdout.on("data", (c: Buffer) => mainWindow?.webContents.send("cloudauth:output", c.toString("utf-8")));
    child.stderr.on("data", (c: Buffer) => mainWindow?.webContents.send("cloudauth:output", c.toString("utf-8")));
    child.on("error", (err) => reject(err));
    child.on("exit", (code: number | null) => resolve({ code }));
  });
}

// Reports GCP setup completeness AND auth state, so the renderer can gate the
// whole cloud/observability pane conditionally: it is only relevant when the GCP
// plane is actually configured (gcloud installed + a project set). Auth is only
// checked when configured. The printed access token is deliberately discarded —
// only the exit code and non-secret fields (project, account) are surfaced.
ipcMain.handle("cloudauth:status", async () => {
  // 1. Is gcloud installed at all? A failed spawn means the GCP plane isn't set
  //    up on this machine — the cloud pane is not applicable, not "broken".
  let project: string | null;
  try {
    const proj = await runCaptured("gcloud", ["config", "get-value", "project", "--quiet"]);
    project = proj.stdout.trim();
    if (project === "" || project === "(unset)") project = null;
  } catch {
    return { ok: true, gcloudInstalled: false, configured: false, authenticated: false, project: null, account: null };
  }

  // 2. Configured = org/GCP setup is complete enough to use (a project is set).
  const configured = project !== null;
  if (!configured) {
    return { ok: true, gcloudInstalled: true, configured: false, authenticated: false, project: null, account: null };
  }

  // 3. Auth (ADC) — only meaningful once configured. Discard the token; keep the
  //    exit code only.
  const { code } = await runCaptured("gcloud", ["auth", "application-default", "print-access-token", "--quiet"]);
  let account: string | null = null;
  try {
    const r = await runCaptured("gcloud", ["config", "get-value", "account", "--quiet"]);
    account = r.stdout.trim() || null;
    if (account === "(unset)" || account === "") account = null;
  } catch {
    // Active-account lookup is best-effort; absence doesn't change auth state.
  }
  return { ok: true, gcloudInstalled: true, configured: true, authenticated: code === 0, project, account };
});

// Brokers the interactive login — opens the browser via gcloud for the user to
// complete sign-in, then ADC/google-auth own refresh from there.
ipcMain.handle("cloudauth:login", async () => {
  try {
    const { code } = await runStreamed("gcloud", ["auth", "application-default", "login"]);
    return code === 0 ? { ok: true } : { ok: false, error: `gcloud login exited with code ${code}` };
  } catch (err) {
    return { ok: false, error: `Failed to start gcloud login: ${(err as Error).message}` };
  }
});

// Single-instance: a second launch focuses the existing window instead of
// spawning a duplicate app instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("ready", () => {
  // Seed the in-memory token mirror and start injecting the Bearer for the
  // cockpit origin before the window loads, so the very first page request is
  // already authenticated when a credential exists.
  const seeded = readToken();
  cachedBoardToken = seeded.ok ? seeded.token : null;
  installCockpitBearerInjector();

  createWindow();

  // Update checks require a packaged, signed build with a configured feed;
  // running it against an unpackaged dev build would just error noisily.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // Update-check failures must not block the app from being usable.
    });
  }
});

app.on("window-all-closed", () => {
  stopRunner();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// The child process must never outlive the app — an orphaned runner keeps
// running indefinitely with no supervisor to report or stop it.
app.on("before-quit", () => {
  stopRunner();
});
