#!/bin/sh
# install.sh — install the Proofbench CLI (pb) from a GitHub release.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/0prodigy/proofbench/main/install.sh | sh
#
# Env overrides:
#   PB_VERSION   pin a release tag (e.g. v0.1.0); default = latest release
#   BINDIR       install dir; default /usr/local/bin, else $HOME/.local/bin
set -eu

REPO="0prodigy/proofbench"
PROJECT="proofbench"
BIN="pb"

# --- detect platform (must match .goreleaser.yaml archive name_template) ---
os=$(uname -s)
case "$os" in
    Linux)  OS=linux ;;
    Darwin) OS=darwin ;;
    *) echo "error: unsupported OS: $os" >&2; exit 1 ;;
esac

arch=$(uname -m)
case "$arch" in
    x86_64|amd64)  ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "error: unsupported architecture: $arch" >&2; exit 1 ;;
esac

# --- pick a downloader ---
if command -v curl >/dev/null 2>&1; then
    dl() { curl -fsSL "$1" -o "$2"; }
    fetch() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
    dl() { wget -qO "$2" "$1"; }
    fetch() { wget -qO - "$1"; }
else
    echo "error: need curl or wget to download" >&2
    exit 1
fi

# --- resolve the release tag ---
if [ -n "${PB_VERSION:-}" ]; then
    TAG="$PB_VERSION"
else
    # ponytail: parse tag_name from the GitHub API with grep/sed to avoid a jq dependency.
    TAG=$(fetch "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name"' \
        | head -n1 \
        | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
fi

if [ -z "${TAG:-}" ]; then
    echo "error: could not resolve latest release tag; set PB_VERSION to pin one" >&2
    exit 1
fi

# goreleaser strips the leading 'v' from the archive version.
VERSION=$(printf '%s' "$TAG" | sed 's/^v//')
ASSET="${PROJECT}_${VERSION}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

# --- download + extract in a temp dir ---
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ${ASSET} (${TAG})..."
dl "$URL" "$TMP/$ASSET"
tar -xzf "$TMP/$ASSET" -C "$TMP"

if [ ! -f "$TMP/$BIN" ]; then
    echo "error: '$BIN' not found in archive $ASSET" >&2
    exit 1
fi

# --- choose an install dir ---
BINDIR="${BINDIR:-/usr/local/bin}"
NOTE=""
if ! { [ -d "$BINDIR" ] && [ -w "$BINDIR" ]; }; then
    # Fall back to a user-writable dir if the default is not writable.
    if [ -d "$BINDIR" ] || mkdir -p "$BINDIR" 2>/dev/null && [ -w "$BINDIR" ]; then
        :
    else
        BINDIR="$HOME/.local/bin"
        mkdir -p "$BINDIR"
        NOTE="note: $BINDIR may not be on your PATH — add it, e.g. export PATH=\"$BINDIR:\$PATH\""
    fi
fi

install -m 0755 "$TMP/$BIN" "$BINDIR/$BIN" 2>/dev/null || {
    cp "$TMP/$BIN" "$BINDIR/$BIN"
    chmod +x "$BINDIR/$BIN"
}

echo "Installed $BIN to $BINDIR/$BIN"
[ -n "$NOTE" ] && echo "$NOTE"

# --- report version if the binary is reachable on PATH, else print the path ---
if command -v "$BIN" >/dev/null 2>&1 && [ "$(command -v "$BIN")" = "$BINDIR/$BIN" ]; then
    "$BIN" version
else
    echo "Run it with: $BINDIR/$BIN version"
fi
