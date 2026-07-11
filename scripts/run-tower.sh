#!/usr/bin/env bash
#
# run-tower.sh — install the APEX platform CLI locally, then start apex-tower.
#
# apex-tower dispatches workflows through the `apex` CLI (LocalRunner). Until APEX
# is published to a public index, the CLI lives in the private Sarala Python package
# registry (a GCP Artifact Registry). This script pulls + installs it the same way
# CI does — via the `keyrings.google-artifactregistry-auth` backend, which
# authenticates through your LOCAL gcloud credentials (ADC). No token is ever passed
# on the command line.
#
# The registry is hardcoded to the published Sarala AR below: pre-go-live the CLI is
# only pullable with Sarala gcloud auth, so config indirection buys nothing yet. When
# APEX ships publicly this becomes a normal index and can be made org-configurable.
# (An env override is honored for convenience but no config file is required.)
#
# Usage:
#   scripts/run-tower.sh              # install (if needed) + start the tower
#   scripts/run-tower.sh --reinstall  # force reinstall of the apex package
#   scripts/run-tower.sh --install    # install only; do not start the tower
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# --- Config ---------------------------------------------------------------------
# Package to install, e.g. "apex-platform" or "apex-platform==0.4.1".
APEX_PACKAGE_SPEC="${APEX_PACKAGE_SPEC:-apex-platform}"
# Published Sarala AR "simple" index (hardcoded pre-go-live; env override honored).
APEX_PACKAGE_INDEX_URL="${APEX_PACKAGE_INDEX_URL:-https://asia-south1-python.pkg.dev/sarala-cicd/sarala-packages/simple/}"
# Where the apex CLI is installed so it lands on PATH for the tower's runner.
APEX_VENV="${APEX_VENV:-$repo_root/.venv-apex}"

reinstall=0
start_tower=1
for arg in "$@"; do
  case "$arg" in
    --reinstall) reinstall=1 ;;
    --install)   start_tower=0 ;;
    *) echo "run-tower: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

die() { echo "run-tower: $*" >&2; exit 1; }

# --- Preconditions: gcloud present + authenticated (local ADC) ------------------
command -v gcloud >/dev/null 2>&1 || die "gcloud not found on PATH. Install the Google Cloud SDK."
command -v python3 >/dev/null 2>&1 || die "python3 not found on PATH."

# The keyring backend authenticates to the AR using Application Default Credentials,
# so both the user login AND ADC must hold a live (unexpired) token. If either is
# missing or expired, trigger the matching interactive gcloud login and retry.
ensure_auth() {
  local label="$1"; shift          # human label
  local check_cmd="$1"; shift       # command that succeeds only with a live token
  local login_cmd="$1"; shift       # interactive login to run if the check fails
  if eval "$check_cmd" >/dev/null 2>&1; then
    return 0
  fi
  echo "run-tower: $label token missing or expired — launching '$login_cmd'…" >&2
  eval "$login_cmd" || die "$label login failed or was cancelled."
  eval "$check_cmd" >/dev/null 2>&1 || die "$label token still unavailable after login."
}

ensure_auth "gcloud user"       "gcloud auth print-access-token" \
                                "gcloud auth login"
ensure_auth "application-default" "gcloud auth application-default print-access-token" \
                                "gcloud auth application-default login"

# --- Ensure the apex venv exists -------------------------------------------------
if [[ ! -x "$APEX_VENV/bin/apex" || "$reinstall" == "1" ]]; then
  echo "run-tower: installing $APEX_PACKAGE_SPEC into $APEX_VENV (via local gcloud auth)…"
  [[ -d "$APEX_VENV" ]] || python3 -m venv "$APEX_VENV"
  # Keyring backend authenticates to the AR using local gcloud ADC — exactly as CI does.
  "$APEX_VENV/bin/pip" install --quiet --upgrade pip keyrings.google-artifactregistry-auth
  "$APEX_VENV/bin/pip" install --quiet --upgrade "$APEX_PACKAGE_SPEC" \
    --index-url "$APEX_PACKAGE_INDEX_URL" \
    --extra-index-url "https://pypi.org/simple/"
else
  echo "run-tower: apex already installed in $APEX_VENV (use --reinstall to refresh)."
fi

echo "run-tower: apex CLI → $("$APEX_VENV/bin/apex" --version 2>/dev/null || echo 'version unknown')"

# --- Put apex on PATH and start the tower ---------------------------------------
export PATH="$APEX_VENV/bin:$PATH"

if [[ "$start_tower" == "1" ]]; then
  echo "run-tower: starting apex-tower (apex on PATH: $(command -v apex))…"
  exec pnpm dev
fi
