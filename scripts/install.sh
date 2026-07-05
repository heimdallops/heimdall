#!/usr/bin/env bash
# Install heimdall from GitHub releases.
#
# Usage:
#   curl -fsSL https://github.com/heimdallops/heimdall/releases/latest/download/install.sh | bash
#
# Environment variables:
#   VERSION     - Release version to install, with or without a leading v (default: latest)
#   INSTALL_DIR - Installation directory (default: /usr/local/bin)
#
# Examples:
#   # Install latest
#   curl -fsSL .../install.sh | bash
#
#   # Install specific version
#   curl -fsSL .../install.sh | VERSION=0.2.0 bash
#
#   # Install to a custom directory
#   curl -fsSL .../install.sh | INSTALL_DIR=~/.local/bin bash

set -euo pipefail

REPO="heimdallops/heimdall"
BINARY_NAME="heimdall"
VERSION="${VERSION:-latest}"
# Release tags have no v prefix; tolerate callers passing one (VERSION=v0.2.0).
VERSION="${VERSION#v}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# ── helpers ───────────────────────────────────────────────────────────────────

info()    { printf '\033[1;34m[heimdall]\033[0m %s\n' "$*"; }
success() { printf '\033[1;32m[heimdall]\033[0m %s\n' "$*"; }
warn()    { printf '\033[1;33m[heimdall]\033[0m %s\n' "$*"; }
error()   { printf '\033[1;31m[heimdall]\033[0m %s\n' "$*" >&2; }
die()     { error "$*"; exit 1; }

# ── platform detection ────────────────────────────────────────────────────────

detect_platform() {
  local os arch

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    linux)  os="linux" ;;
    darwin) os="macos" ;;
    mingw*|msys*|cygwin*) die "This installer does not support Windows. Options: install WSL2 and re-run this script, or download heimdall-windows-x64.zip directly from https://github.com/${REPO}/releases." ;;
    *) die "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64 | amd64)  arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  echo "${os}-${arch}"
}

# ── download ──────────────────────────────────────────────────────────────────

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --progress-bar -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$dest" "$url"
  else
    die "Neither curl nor wget found. Please install one and retry."
  fi
}

# ── checksum verification ─────────────────────────────────────────────────────

verify_checksum() {
  local binary_path="$1" asset_name="$2" checksums_url="$3"

  info "Verifying checksum..."

  local checksums
  if ! checksums="$(curl -fsSL "$checksums_url" 2>/dev/null || wget -qO- "$checksums_url" 2>/dev/null)"; then
    die "Could not download checksums from $checksums_url — cannot verify binary integrity."
  fi

  local expected
  expected="$(printf '%s' "$checksums" | awk -v asset="$asset_name" '$2 == asset {print $1}')"
  [ -n "$expected" ] || die "No checksum entry found for $asset_name in checksums file."

  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$binary_path" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$binary_path" | awk '{print $1}')"
  else
    die "No sha256sum or shasum available for checksum verification. Please install coreutils."
  fi

  [ "$expected" = "$actual" ] || die "Checksum mismatch! Expected $expected but got $actual. The download may be corrupted."
  success "Checksum verified"
}

# ── main ──────────────────────────────────────────────────────────────────────

main() {
  info "Detecting platform..."
  local platform
  platform="$(detect_platform)"
  success "Platform: $platform"

  local asset_name="heimdall-${platform}.tar.gz"
  local base_url
  if [ "$VERSION" = "latest" ]; then
    base_url="https://github.com/${REPO}/releases/latest/download"
  else
    base_url="https://github.com/${REPO}/releases/download/${VERSION}"
  fi

  info "Version: $VERSION"

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  local archive_path="$tmp_dir/$asset_name"

  info "Downloading $asset_name..."
  download "${base_url}/${asset_name}" "$archive_path"
  success "Downloaded"

  verify_checksum "$archive_path" "$asset_name" "${base_url}/checksums.txt"

  info "Extracting $asset_name..."
  tar -xzf "$archive_path" -C "$tmp_dir"

  local binary_path="$tmp_dir/$BINARY_NAME"

  info "Verifying binary..."
  if ! "$binary_path" --help >/dev/null 2>&1; then
    die "Downloaded binary failed to execute. The release may be incomplete or incompatible with this system."
  fi

  info "Installing to $INSTALL_DIR/$BINARY_NAME..."

  if [ ! -d "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR" 2>/dev/null || sudo mkdir -p "$INSTALL_DIR"
  fi

  if ! mv "$binary_path" "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null; then
    warn "Need elevated permissions to install to $INSTALL_DIR"
    sudo mv "$binary_path" "$INSTALL_DIR/$BINARY_NAME"
    sudo chmod +x "$INSTALL_DIR/$BINARY_NAME"
  fi

  success "Installed to $INSTALL_DIR/$BINARY_NAME"

  if ! command -v "$BINARY_NAME" >/dev/null 2>&1; then
    warn "$INSTALL_DIR is not in your PATH. Add this to your shell config:"
    printf '\n    export PATH="%s:$PATH"\n\n' "$INSTALL_DIR"
  fi
}

main "$@"
