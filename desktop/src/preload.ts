// Preload script — the only bridge between the sandboxed cockpit renderer
// and the main process. contextIsolation is on and nodeIntegration is off,
// so the renderer gets exactly this typed surface and nothing else (no
// direct fs/child_process/ipcRenderer access).

import { contextBridge, ipcRenderer } from "electron";

interface CockpitConfig {
  mode: "local" | "remote";
  cockpitUrl: string;
}

interface TokenResult {
  ok: boolean;
  token?: string | null;
  error?: string;
}

interface OkResult {
  ok: boolean;
  error?: string;
}

interface RunnerStartResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

interface AuthLoginResult {
  ok: boolean;
  userId?: string | null;
  error?: string;
}

interface AuthStatusResult {
  ok: boolean;
  authenticated: boolean;
  error?: string;
}

interface CloudAuthStatus {
  ok: boolean;
  gcloudInstalled: boolean;
  configured: boolean;      // gcloud installed AND a GCP project is set
  authenticated: boolean;   // ADC can currently mint an access token
  project: string | null;
  account: string | null;
  error?: string;
}

const apexDesktop = {
  getConfig: (): Promise<CockpitConfig> => ipcRenderer.invoke("config:get"),
  setConfig: (config: CockpitConfig): Promise<OkResult> => ipcRenderer.invoke("config:set", config),

  // GCP credential broker. The cloud/observability pane should render only when
  // `configured` is true (org/GCP setup complete); prompt `login()` when
  // `authenticated` is false. Access tokens never cross this bridge.
  cloudAuth: {
    status: (): Promise<CloudAuthStatus> => ipcRenderer.invoke("cloudauth:status"),
    login: (): Promise<OkResult> => ipcRenderer.invoke("cloudauth:login"),
    onOutput: (listener: (chunk: string) => void): void => {
      ipcRenderer.on("cloudauth:output", (_event, chunk: string) => listener(chunk));
    },
  },

  token: {
    set: (token: string): Promise<OkResult> => ipcRenderer.invoke("token:set", token),
    get: (): Promise<TokenResult> => ipcRenderer.invoke("token:get"),
    clear: (): Promise<OkResult> => ipcRenderer.invoke("token:clear"),
  },

  // Board sign-in via the cockpit's cli-auth challenge flow. login() opens the
  // system browser for approval (Google SSO runs there) and resolves once
  // approved; the board token stays in the main process and is injected as a
  // Bearer for the cockpit origin — it never crosses this bridge.
  auth: {
    login: (): Promise<AuthLoginResult> => ipcRenderer.invoke("auth:login"),
    status: (): Promise<AuthStatusResult> => ipcRenderer.invoke("auth:status"),
    logout: (): Promise<OkResult> => ipcRenderer.invoke("auth:logout"),
    onProgress: (listener: (message: string) => void): void => {
      ipcRenderer.on("auth:progress", (_event, message: string) => listener(message));
    },
  },

  // The annual Claude subscription ceremony, desktop-triggered: main spawns
  // `apex claude connect` and opens its guided page in-app. Consents stay
  // with the human; everything around them is choreography.
  claudeConnect: {
    start: (opts: { companyId: string; definitionKey?: string }): Promise<RunnerStartResult> =>
      ipcRenderer.invoke("claude:connect", opts),
    onOutput: (listener: (chunk: string) => void): void => {
      ipcRenderer.on("claude:connect:output", (_event, chunk: string) => listener(chunk));
    },
    onExit: (listener: (info: { code: number | null }) => void): void => {
      ipcRenderer.on("claude:connect:exit", (_event, info: { code: number | null }) => listener(info));
    },
  },

  runner: {
    start: (opts?: { command?: string; args?: string[] }): Promise<RunnerStartResult> =>
      ipcRenderer.invoke("runner:start", opts),
    stop: (): Promise<OkResult> => ipcRenderer.invoke("runner:stop"),
    onStdout: (listener: (chunk: string) => void): void => {
      ipcRenderer.on("runner:stdout", (_event, chunk: string) => listener(chunk));
    },
    onStderr: (listener: (chunk: string) => void): void => {
      ipcRenderer.on("runner:stderr", (_event, chunk: string) => listener(chunk));
    },
    onExit: (listener: (info: { code: number | null; signal: string | null }) => void): void => {
      ipcRenderer.on("runner:exit", (_event, info: { code: number | null; signal: string | null }) =>
        listener(info)
      );
    },
  },
};

export type ApexDesktopApi = typeof apexDesktop;

contextBridge.exposeInMainWorld("apexDesktop", apexDesktop);
