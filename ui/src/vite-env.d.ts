/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * OTLP/HTTP traces endpoint for browser OTel (e.g. http://localhost:4318/v1/traces).
   * Unset (default) → ui/src/observe/telemetry.ts is a complete no-op.
   */
  readonly VITE_APEX_OTLP_ENDPOINT?: string;
  /** apex.env spine value stamped on browser telemetry resources. Defaults to "local". */
  readonly VITE_APEX_ENV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
