# APEX Desktop

Electron desktop client for the APEX cockpit. Renders the cockpit web UI,
holds the subscription token in the OS keychain, and can supervise a local
`apex` CLI runner process.

## Dev

```bash
npm install
npm start
```

`npm start` builds the TypeScript (`tsc`) and launches Electron against the
compiled output.

## Build a distributable

```bash
npm run dist
```

Runs `electron-builder` against `electron-builder.yml`, producing:
- macOS: `.dmg` (universal build: arm64 + x64)
- Windows: NSIS installer (`.exe`)
- Linux: `AppImage` and `.deb`

## Configuration

On first launch the app reads `apex-desktop-config.json` from Electron's
`userData` directory:

- macOS: `~/Library/Application Support/apex-desktop/apex-desktop-config.json`
- Windows: `%APPDATA%\apex-desktop\apex-desktop-config.json`
- Linux: `~/.config/apex-desktop/apex-desktop-config.json`

If the file doesn't exist, it's created with the default:

```json
{
  "mode": "local",
  "cockpitUrl": "http://localhost:3100"
}
```

### Mode switch

`mode` is `"local"` or `"remote"`; `cockpitUrl` is the address the app
points its `BrowserWindow` at. The cockpit server the app talks to is never
baked into the binary — the same build works against a developer's local
cockpit server (`mode: "local"`) or an operator's remote deployment
(`mode: "remote"`, `cockpitUrl` pointed at the remote host) purely by
editing this file. Restart the app after editing it.

## Token custody

The subscription token is never written to disk in plaintext. `token:set`
encrypts it via Electron's `safeStorage` (backed by macOS Keychain,
Windows DPAPI, or Linux libsecret) and writes only the ciphertext to
`apex-desktop-token.enc` in the same `userData` directory. If the OS
encryption backend is unavailable, storage is refused outright rather than
falling back to plaintext.

## Signing and notarization — NOT included in this scaffold

- **macOS**: builds produced by `npm run dist` are **unsigned**. Distributing
  a signed, notarized `.dmg` requires an Apple Developer ID Application
  certificate and notarization credentials (`APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, plus `CSC_LINK` /
  `CSC_KEY_PASSWORD` for the cert), supplied by the operator in CI.
- **Windows**: builds are similarly unsigned. A code-signing certificate
  (`CSC_LINK` / `CSC_KEY_PASSWORD`) must be supplied by the operator in CI
  for a signed installer.

Nothing in this repo holds those credentials or identities.
