#!/usr/bin/env bash
set -euo pipefail

REPO="${CT_REPO:-linas-lin/t3code}"
APP_NAME="CT Code.app"
LEGACY_APP_NAME="T3 Code (CT).app"
APP_DIR="${CT_APP_DIR:-/Applications}"
DEST_APP="${APP_DIR}/${APP_NAME}"
LEGACY_DEST_APP="${APP_DIR}/${LEGACY_APP_NAME}"
REQUESTED_VERSION="${CT_VERSION:-}"

info() {
  printf '[ct-code] %s\n' "$*"
}

die() {
  printf '[ct-code] Error: %s\n' "$*" >&2
  exit 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "This installer is for macOS only. On Windows, run scripts/install-ct.ps1 in PowerShell."
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  die "This build currently supports macOS Apple Silicon (arm64) only (detected: ${ARCH})."
fi

for cmd in curl hdiutil ditto xattr; do
  command -v "$cmd" >/dev/null 2>&1 || die "Required command not found: ${cmd}"
done

if [[ -n "$REQUESTED_VERSION" ]]; then
  API_URL="https://api.github.com/repos/${REPO}/releases/tags/${REQUESTED_VERSION}"
  info "Looking up release ${REQUESTED_VERSION} from ${REPO}..."
else
  API_URL="https://api.github.com/repos/${REPO}/releases?per_page=20"
  info "Looking up latest CT Code release from ${REPO}..."
fi

RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: ct-code-installer" "$API_URL")" \
  || die "Failed to query GitHub Releases (${API_URL})."

DOWNLOAD_URL="$({ printf '%s\n' "$RELEASE_JSON" \
  | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://[^"]+/releases/download/ct-v[^"]+/CT-Code-[^"]*-arm64\.dmg"' \
  | head -n 1 \
  | sed -E 's/^"browser_download_url"[[:space:]]*:[[:space:]]*"([^"]+)"$/\1/'; } || true)"

if [[ -z "$DOWNLOAD_URL" ]]; then
  die "No macOS arm64 DMG found in ${REPO} releases (expected CT-Code-*-arm64.dmg under a ct-v* tag)."
fi

FILE_NAME="${DOWNLOAD_URL##*/}"
TAG_NAME="$(printf '%s' "$DOWNLOAD_URL" | sed -E 's#.*/releases/download/([^/]+)/.*#\1#')"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ct-code-install.XXXXXX")"
MOUNT_DIR="${WORK_DIR}/mnt"
DMG_PATH="${WORK_DIR}/${FILE_NAME}"
MOUNTED=0

cleanup() {
  if [[ "$MOUNTED" -eq 1 ]]; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || hdiutil detach "$MOUNT_DIR" -force -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

info "Downloading ${FILE_NAME} (${TAG_NAME})..."
curl -fL --progress-bar -o "$DMG_PATH" "$DOWNLOAD_URL" || die "Failed to download ${DOWNLOAD_URL}."

mkdir -p "$MOUNT_DIR"
info "Mounting ${FILE_NAME}..."
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_DIR" "$DMG_PATH" -quiet || die "Failed to mount DMG."
MOUNTED=1

SRC_APP="${MOUNT_DIR}/${APP_NAME}"
[[ -d "$SRC_APP" ]] || die "Expected '${APP_NAME}' inside mounted DMG, but it was not found."

quit_app_if_running() {
  local app_label="$1"
  local pattern="$2"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    info "Closing running ${app_label}..."
    osascript -e "tell application \"${app_label}\" to quit" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pgrep -f "$pattern" >/dev/null 2>&1 || break
      sleep 0.5
    done
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      die "${app_label} is still running. Please quit it manually and re-run this command."
    fi
  fi
}

quit_app_if_running "CT Code" "/CT Code\.app/"
quit_app_if_running "T3 Code (CT)" "/T3 Code \(CT\)\.app/"

USE_SUDO=0
mkdir -p "$APP_DIR" 2>/dev/null || true
if [[ ! -w "$APP_DIR" ]]; then
  info "Administrator permission is required to write into ${APP_DIR}."
  USE_SUDO=1
fi

run_install_cmd() {
  if [[ "$USE_SUDO" -eq 1 ]]; then
    sudo "$@"
  else
    "$@"
  fi
}

info "Installing to ${DEST_APP}..."
run_install_cmd rm -rf "$DEST_APP"
run_install_cmd ditto "$SRC_APP" "$DEST_APP"
run_install_cmd xattr -cr "$DEST_APP"

if [[ -d "$LEGACY_DEST_APP" ]]; then
  info "Removing legacy ${LEGACY_DEST_APP}..."
  run_install_cmd rm -rf "$LEGACY_DEST_APP"
fi

info "Installed CT Code (${TAG_NAME}) to ${DEST_APP}."
info "You can open it now from Applications or run: open -a \"CT Code\""
