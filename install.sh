#!/usr/bin/env bash
#
# pi-rad installer
#
#   curl -fsSL https://raw.githubusercontent.com/ithrael/pi-rad/master/install.sh | bash
#
# Options:
#   --dev            install the current checkout in place (no copy)
#   --dir DIR        install directory (default: $PI_RAD_HOME or ~/.pi-rad)
#   --bin DIR        directory for the `pi-rad` launcher (default: ~/.local/bin)
#   --no-settings    do not touch ~/.pi/agent/settings.json
#   --uninstall      unregister pi-rad and remove the launcher
#   --purge          with --uninstall, also delete the install directory
#   --help
#
# Environment:
#   PI_RAD_HOME      install directory
#   PI_RAD_REPO      repository URL for remote installs
#   PI_AGENT_DIR     pi agent dir (default: ~/.pi/agent)

set -euo pipefail

PI_RAD_REPO_DEFAULT="https://github.com/ithrael/pi-rad"
PI_AGENT_DIR="${PI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"
SETTINGS="$PI_AGENT_DIR/settings.json"

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
fi

MODE="install"
DEV=0
TOUCH_SETTINGS=1
PURGE=0
INSTALL_DIR="${PI_RAD_HOME:-$HOME/.pi-rad}"
BIN_DIR="${PI_RAD_BIN_DIR:-$HOME/.local/bin}"

if [[ -t 1 ]]; then
	BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RED="$(printf '\033[31m')"
	GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"; RESET="$(printf '\033[0m')"
else
	BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

info() { printf '%s\n' "${BOLD}pi-rad${RESET} $*"; }
warn() { printf '%s\n' "${YELLOW}warning:${RESET} $*" >&2; }
die() { printf '%s\n' "${RED}error:${RESET} $*" >&2; exit 1; }

usage() {
	sed -n '2,20p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--dev) DEV=1; shift ;;
		--dir) INSTALL_DIR="$2"; shift 2 ;;
		--bin) BIN_DIR="$2"; shift 2 ;;
		--no-settings) TOUCH_SETTINGS=0; shift ;;
		--uninstall) MODE="uninstall"; shift ;;
		--purge) PURGE=1; shift ;;
		--help|-h) usage; exit 0 ;;
		*) die "unknown argument: $1" ;;
	esac
done

command -v pi >/dev/null 2>&1 || die "pi is not installed or not on PATH. See https://pi.dev/docs/latest/quickstart"

# ── uninstall ────────────────────────────────────────────────────────
if [[ "$MODE" == "uninstall" ]]; then
	info "uninstalling"
	if [[ -f "$SETTINGS" ]]; then
		pi remove "$INSTALL_DIR" >/dev/null 2>&1 || warn "could not remove $INSTALL_DIR from pi settings (may not be registered)"
	fi
	if [[ -f "$BIN_DIR/pi-rad" ]]; then
		rm -f "$BIN_DIR/pi-rad"
		info "removed launcher $BIN_DIR/pi-rad"
	fi
	if [[ "$PURGE" == "1" && -d "$INSTALL_DIR" && "$INSTALL_DIR" != "$SCRIPT_DIR" ]]; then
		rm -rf "$INSTALL_DIR"
		info "removed $INSTALL_DIR"
	fi
	info "done. Restart pi (or run /reload) for changes to take effect."
	exit 0
fi

# ── resolve package source ───────────────────────────────────────────
TMP_DIR=""
cleanup() {
	if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then rm -rf "$TMP_DIR"; fi
	return 0
}
trap cleanup EXIT

if [[ "$DEV" == "0" ]]; then
	if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/package.json" ]] && grep -q '"name": "pi-rad"' "$SCRIPT_DIR/package.json"; then
		SOURCE_DIR="$SCRIPT_DIR"
	else
		REPO="${PI_RAD_REPO:-$PI_RAD_REPO_DEFAULT}"
		info "downloading from $REPO"
		TMP_DIR="$(mktemp -d)"
		ARCHIVE="$TMP_DIR/pi-rad.tar.gz"
		URL="$REPO/archive/HEAD.tar.gz"
		if ! curl -fsSL "$URL" -o "$ARCHIVE"; then
			die "download failed: $URL (set PI_RAD_REPO to override)"
		fi
		tar -xzf "$ARCHIVE" -C "$TMP_DIR"
		SOURCE_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'pi-rad-*' | head -n 1)"
		[[ -n "$SOURCE_DIR" ]] || die "unexpected archive layout"
	fi

	if [[ "$SOURCE_DIR" != "$INSTALL_DIR" ]]; then
		info "installing to $INSTALL_DIR"
		mkdir -p "$INSTALL_DIR"
		if command -v rsync >/dev/null 2>&1; then
			rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude 'patches.json' \
				"$SOURCE_DIR/" "$INSTALL_DIR/"
		else
			(cd "$SOURCE_DIR" && tar --exclude='.git' --exclude='node_modules' --exclude='patches.json' -cf - .) \
				| (cd "$INSTALL_DIR" && tar -xf -)
		fi
	else
		info "already installed at $INSTALL_DIR"
	fi
else
	[[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/package.json" ]] || die "--dev must be run from the pi-rad checkout"
	INSTALL_DIR="$SCRIPT_DIR"
	info "dev mode: registering $INSTALL_DIR in place"
fi

# Where patches.json lives. The launcher exports PI_RAD_HOME accordingly.
CONFIG_HOME="${PI_RAD_HOME:-$INSTALL_DIR}"

# ── register with pi ─────────────────────────────────────────────────
info "registering package with pi"
pi install "$INSTALL_DIR" >/dev/null 2>&1 || warn "pi install returned non-zero; check 'pi list'"

# ── seed config ──────────────────────────────────────────────────────
mkdir -p "$CONFIG_HOME"
if [[ ! -f "$CONFIG_HOME/patches.json" ]]; then
	cat > "$CONFIG_HOME/patches.json" <<'JSON'
{
  "sec-research": true,
  "armor": true,
  "auto-trust": true,
  "attribution-off": true,
  "subagents": true,
  "plan-mode": true,
  "goal": true,
  "statusline": true,
  "theme": true,
  "lean": false,
  "lean-max": false,
  "guard": false
}
JSON
	info "seeded $CONFIG_HOME/patches.json"
fi

# ── settings preferences ─────────────────────────────────────────────
if [[ "$TOUCH_SETTINGS" == "1" && -f "$INSTALL_DIR/scripts/patch-settings.mjs" ]]; then
	if command -v node >/dev/null 2>&1; then
		node "$INSTALL_DIR/scripts/patch-settings.mjs" "$SETTINGS" \
			--set-if-absent defaultProjectTrust=always \
			--set-if-absent enableInstallTelemetry=false \
			--set-if-absent theme=pi-rad \
			|| warn "could not update $SETTINGS"
	else
		warn "node not found; skipping settings tweaks (defaultProjectTrust, telemetry, theme)"
	fi
fi

# ── launcher ─────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/pi-rad"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Generated by the pi-rad installer.
set -euo pipefail
export PI_RAD=1
export PI_RAD_HOME="$CONFIG_HOME"
exec pi "\$@"
EOF
chmod +x "$LAUNCHER"
info "installed launcher $LAUNCHER"

case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) warn "$BIN_DIR is not on PATH; add it to use the \`pi-rad\` command" ;;
esac

info "${GREEN}done${RESET}"
cat <<'EOF'

Next steps:
  pi-rad                 # launch pi with pi-rad enabled
  /rad                   # interactive feature control panel
  /rad-doctor            # diagnostics
  /plan                  # toggle read-only plan mode
  /agents                # list subagents

EOF
