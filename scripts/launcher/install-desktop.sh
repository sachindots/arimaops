#!/usr/bin/env bash
# Installs the ArimaOps launcher: app menu entry + Desktop icon (GNOME/KDE/XFCE).
#   bash scripts/launcher/install-desktop.sh            # local only
#   bash scripts/launcher/install-desktop.sh --remote   # adds a second "(Remote)" launcher
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
BIN="$HOME/.local/bin"; APPS="$HOME/.local/share/applications"; ICONS="$HOME/.local/share/icons"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
mkdir -p "$BIN" "$APPS" "$ICONS" "$DESK"

sed -e "s|__HQ_ROOT__|$ROOT|" -e "s|__NODE__|$NODE|" "$ROOT/scripts/launcher/arimaops-launch.sh" > "$BIN/arimaops-launch"
chmod +x "$BIN/arimaops-launch"

cp "$ROOT/public/arima-mascot.svg" "$ICONS/arimaops.svg"

entry() { # $1 file  $2 name  $3 exec
  cat > "$1" <<EOF
[Desktop Entry]
Type=Application
Name=$2
Comment=Start ArimaOps for a project folder
Exec=$3
Icon=$ICONS/arimaops.svg
Terminal=false
Categories=Development;
StartupNotify=true
Actions=Pick;

[Desktop Action Pick]
Name=Choose another folder…
Exec=$3
EOF
  chmod +x "$1"
}

entry "$APPS/arimaops.desktop" "ArimaOps" "$BIN/arimaops-launch %f"
cp "$APPS/arimaops.desktop" "$DESK/arimaops.desktop"
if [ "${1:-}" = "--remote" ]; then
  entry "$APPS/arimaops-remote.desktop" "ArimaOps (Remote)" "env HQ_LAUNCH_FLAGS=\"--remote ${HQ_NTFY_TOPIC:+--ntfy $HQ_NTFY_TOPIC}\" $BIN/arimaops-launch %f"
  cp "$APPS/arimaops-remote.desktop" "$DESK/arimaops-remote.desktop"
fi
# GNOME: mark desktop icons trusted so they launch on double-click.
for f in "$DESK"/arimaops*.desktop; do gio set "$f" metadata::trusted true 2>/dev/null || true; done
update-desktop-database "$APPS" 2>/dev/null || true
echo "Installed: $BIN/arimaops-launch, app menu 'ArimaOps', Desktop icon(s) in $DESK"
