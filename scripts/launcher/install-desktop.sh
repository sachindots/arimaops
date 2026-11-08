#!/usr/bin/env bash
# Installs the .hq launcher: app menu entry + Desktop icon (GNOME/KDE/XFCE).
#   bash scripts/launcher/install-desktop.sh            # local only
#   bash scripts/launcher/install-desktop.sh --remote   # adds a second "(Remote)" launcher
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node)" || { echo "node not found on PATH"; exit 1; }
BIN="$HOME/.local/bin"; APPS="$HOME/.local/share/applications"; ICONS="$HOME/.local/share/icons"
DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
mkdir -p "$BIN" "$APPS" "$ICONS" "$DESK"

sed -e "s|__HQ_ROOT__|$ROOT|" -e "s|__NODE__|$NODE|" "$ROOT/scripts/launcher/dothq-launch.sh" > "$BIN/dothq-launch"
chmod +x "$BIN/dothq-launch"

cat > "$ICONS/dothq.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" shape-rendering="crispEdges">
  <rect width="10" height="10" fill="#050609"/>
  <rect x="1" y="1" width="8" height="8" fill="#0a0c12" stroke="#ff1744" stroke-width="1"/>
  <rect x="2" y="6" width="2" height="2" fill="#ff1744"/>
  <rect x="5" y="2" width="3" height="6" fill="#00ff66"/>
  <rect x="6" y="3" width="1" height="4" fill="#0a0c12"/>
</svg>
SVG

entry() { # $1 file  $2 name  $3 exec
  cat > "$1" <<EOF
[Desktop Entry]
Type=Application
Name=$2
Comment=Start .hq (dot hq) agent HQ for a project folder
Exec=$3
Icon=$ICONS/dothq.svg
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

entry "$APPS/dothq.desktop" ".hq" "$BIN/dothq-launch %f"
cp "$APPS/dothq.desktop" "$DESK/dothq.desktop"
if [ "${1:-}" = "--remote" ]; then
  entry "$APPS/dothq-remote.desktop" ".hq (Remote)" "env HQ_LAUNCH_FLAGS=\"--remote ${HQ_NTFY_TOPIC:+--ntfy $HQ_NTFY_TOPIC}\" $BIN/dothq-launch %f"
  cp "$APPS/dothq-remote.desktop" "$DESK/dothq-remote.desktop"
fi
# GNOME: mark desktop icons trusted so they launch on double-click.
for f in "$DESK"/dothq*.desktop; do gio set "$f" metadata::trusted true 2>/dev/null || true; done
update-desktop-database "$APPS" 2>/dev/null || true
echo "Installed: $BIN/dothq-launch, app menu '.hq', Desktop icon(s) in $DESK"
