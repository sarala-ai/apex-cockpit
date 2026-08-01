#!/bin/bash
# apex-cockpit-service.sh — run the NATIVE cockpit as a supervised service.
#
# Topology (apex-docs architecture/identity.md): local APEX is a native
# install — local_trusted, no login, ambient shell credential inheritance
# (gcloud/gh/git just work because it is your process). The recurring
# fragility of the dev cockpit was never the topology; it was that a
# foregrounded dev process had no supervisor and died with the shell that
# started it. This installs a per-user launchd agent so the cockpit starts
# at login, restarts on crash, and survives terminal/session ends.
#
#   ./scripts/apex-cockpit-service.sh install     # (re)install + start
#   ./scripts/apex-cockpit-service.sh uninstall   # stop + remove
#   ./scripts/apex-cockpit-service.sh status      # supervised? healthy?
#   ./scripts/apex-cockpit-service.sh logs        # tail the service logs
set -euo pipefail

LABEL="ai.sarala.apex.cockpit"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/.paperclip/instances/default/logs"
GUI="gui/$(id -u)"
PORT=3100

install() {
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

  # One instance only: stop anything already on the port (a stray foreground
  # dev server) and any previous agent before (re)installing.
  launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
  lsof -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | while read -r p; do kill "$p" 2>/dev/null || true; done
  sleep 1

  # dev:watch is deliberate: this machine is where APEX is developed, so the
  # supervised service hot-reloads server code. The UI is served from ui/dist
  # (rebuild with: pnpm --filter @paperclipai/ui build).
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/pnpm</string>
    <string>--filter</string>
    <string>@paperclipai/server</string>
    <string>dev:watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/share/google-cloud-sdk/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.rd/bin</string>
    <key>HOME</key><string>$HOME</string>
    <!-- Backing services, provided by the umbrella compose (docker compose up
         in apex/ = db + eval; gateway/penpot behind their profiles). Declared
         here rather than relying on in-code defaults so the native-cockpit ↔
         compose-services contract is visible and swappable in ONE place. -->
    <key>APEX_EVAL_URL</key><string>http://localhost:8000</string>
    <key>APEX_OTLP_ENDPOINT</key><string>http://localhost:8000</string>
    <key>APEX_GATEWAY_URL</key><string>http://localhost:4444</string>
    <key>APEX_PENPOT_URL</key><string>http://localhost:9001</string>
    <!-- Attribution registry stage: the apex CLI the cockpit shells out to
         resolves its env from APEX_ENV; without it the inventory classifier
         skips the state-DAG registry lookup and the "by registry" column
         stays inert. Single-operator dev machine ⇒ everything is env dev. -->
    <key>APEX_ENV</key><string>dev</string>
    <!-- Attribution refresh scans local checkouts of bound repos; the default
         became empty (review finding 14 — no hardcoded operator paths in
         code), so the operator's parent dir is declared HERE, where operator
         config belongs. -->
    <key>APEX_REPO_ROOTS</key><string>/Users/srinivas/Dev/repos/sarala_org</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/cockpit.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/cockpit.err.log</string>
</dict>
</plist>
PLIST_EOF

  launchctl bootstrap "$GUI" "$PLIST"
  echo "installed $LABEL — waiting for health on :$PORT"
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/api/health"; then
      echo "healthy: http://localhost:$PORT"
      return 0
    fi
    sleep 3
  done
  echo "did not become healthy in time — check: $0 logs" >&2
  return 1
}

uninstall() {
  launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
}

status() {
  if launchctl print "$GUI/$LABEL" >/dev/null 2>&1; then
    echo "supervised: yes ($LABEL)"
    launchctl print "$GUI/$LABEL" | grep -E "state|pid" | head -3
  else
    echo "supervised: no"
  fi
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://localhost:$PORT/api/health" || true)
  echo "health: ${code:-000}"
}

logs() {
  tail -n 40 -f "$LOG_DIR/cockpit.err.log"
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  logs) logs ;;
  *) echo "usage: $0 install|uninstall|status|logs" >&2; exit 2 ;;
esac
