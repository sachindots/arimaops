#!/usr/bin/env bash
# ArimaOps desktop launcher: pick a project folder (recent or browse) and open it in the one ArimaOps server.
# The server (all registered projects) runs detached; log in ~/.arima/logs/server.log. If it's already
# running, the folder is registered with it and opened; otherwise the server starts with it.
set -euo pipefail

HQ_ROOT="__HQ_ROOT__"   # filled in by install-desktop.sh
NODE="__NODE__"
REMOTE_FLAGS="${HQ_LAUNCH_FLAGS:-}"   # e.g. "--remote --ntfy my-topic" (set in the .desktop Exec line)

mkdir -p "$HOME/.arima/logs"
LAST="$HOME/.arima/last-folder"
die() { zenity --error --title="ArimaOps" --width=420 --text="$1" 2>/dev/null || echo "$1" >&2; exit 1; }

[ -f "$HQ_ROOT/dist/index.html" ] && [ -f "$HQ_ROOT/dist-server/main.mjs" ] || die "No build found in $HQ_ROOT.\nRun: pnpm build"

# --- pick folder: recent projects (~/.arima/projects.json) + Browse
recent=$("$NODE" -e '
  try {
    const r = JSON.parse(require("fs").readFileSync(require("os").homedir() + "/.arima/projects.json", "utf8"));
    const list = Array.isArray(r) ? r : r.projects ?? [];
    for (const p of list) if (p.path && require("fs").existsSync(p.path)) console.log(p.name + "\t" + p.path);
  } catch {}
' 2>/dev/null || true)

dir=""
if [ "${1:-}" != "" ] && [ -d "$1" ]; then
  dir="$1"
elif [ -n "$recent" ]; then
  args=()
  while IFS=$'\t' read -r name path; do args+=("$name" "$path"); done <<< "$recent"
  args+=("📁 Browse…" "Pick any folder (new project, OSINT, research, …)")
  choice=$(zenity --list --title="ArimaOps — open project" --width=640 --height=380 \
    --text="Pick a project. Agents run sandboxed in that folder." \
    --column="Project" --column="Folder" --print-column=2 "${args[@]}" 2>/dev/null) || exit 0
  [ "$choice" = "Pick any folder (new project, OSINT, research, …)" ] || dir="$choice"
fi
if [ -z "$dir" ]; then
  start="$(cat "$LAST" 2>/dev/null || echo "$HOME")"
  dir=$(zenity --file-selection --directory --title="ArimaOps — choose project folder" --filename="$start/" 2>/dev/null) || exit 0
fi
[ -d "$dir" ] || die "Folder not found: $dir"
echo "$dir" > "$LAST"
name=$(basename "$dir")

pidf="$HOME/.arima/logs/server.pid"; log="$HOME/.arima/logs/server.log"

# --- server already running? register the folder with it and open that project
if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
  url=$(grep -oP 'is running → \K\S+' "$log" | tail -1)
  [ -n "$url" ] || die "The ArimaOps server is running but its log has no URL: $log"
  base="${url%%/\?*}"; token="${url##*token=}"
  # Local Origin from loopback: the server treats this as this machine's own browser.
  reply=$(curl -sf -X POST -H "Authorization: Bearer $token" -H "Origin: $base" -H "Content-Type: application/json" \
    --data "$("$NODE" -e 'console.log(JSON.stringify({ path: process.argv[1] }))' "$dir")" "$base/api/projects/register") \
    || die "Couldn't add $dir to the running ArimaOps server. See $log"
  id=$(printf '%s' "$reply" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).project?.id ?? ""))')
  xdg-open "$url&project=$id" >/dev/null 2>&1
  exit 0
fi

# --- free port from 7420
port=7420
while (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; do port=$((port + 1)); [ $port -gt 7520 ] && die "No free port between 7420 and 7520."; done

cd "$HQ_ROOT"
# shellcheck disable=SC2086
setsid nohup "$NODE" bin/arimaops.mjs --repo "$dir" --port "$port" $REMOTE_FLAGS > "$log" 2>&1 < /dev/null &
pid=$!
echo $pid > "$pidf"

# --- wait for it (arimaops opens the browser itself)
(
  for i in $(seq 1 60); do
    if grep -q "is running →" "$log" 2>/dev/null; then echo 100; exit 0; fi
    kill -0 $pid 2>/dev/null || exit 1
    echo $((i * 100 / 60)); echo "# Starting ArimaOps (setup checks for every project)…"; sleep 0.5
  done
) | zenity --progress --title="ArimaOps" --text="Starting ArimaOps for $name…" --auto-close --no-cancel --width=380 2>/dev/null || true

if grep -q "is running →" "$log"; then
  notify-send -i "$HOME/.local/share/icons/arimaops.svg" "ArimaOps running: $name" "http://127.0.0.1:$port  ·  log: $log" 2>/dev/null || true
else
  zenity --text-info --title="ArimaOps failed to start — $name" --width=760 --height=480 --filename="$log" 2>/dev/null || cat "$log"
  exit 1
fi
