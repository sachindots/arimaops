#!/usr/bin/env bash
# .hq desktop launcher: pick a project folder (recent or browse), start .hq on a free port,
# open the browser. Each project runs detached; logs in ~/.hq/logs/<folder>.log.
set -euo pipefail

HQ_ROOT="__HQ_ROOT__"   # filled in by install-desktop.sh
NODE="__NODE__"
REMOTE_FLAGS="${HQ_LAUNCH_FLAGS:-}"   # e.g. "--remote --ntfy my-topic" (set in the .desktop Exec line)

mkdir -p "$HOME/.hq/logs"
LAST="$HOME/.hq/last-folder"
die() { zenity --error --title=".hq" --width=420 --text="$1" 2>/dev/null || echo "$1" >&2; exit 1; }

[ -f "$HQ_ROOT/dist/index.html" ] && [ -f "$HQ_ROOT/dist-server/main.mjs" ] || die "No build found in $HQ_ROOT.\nRun: pnpm build"

# --- pick folder: recent projects (~/.hq/projects.json) + Browse
recent=$("$NODE" -e '
  try {
    const r = JSON.parse(require("fs").readFileSync(require("os").homedir() + "/.hq/projects.json", "utf8"));
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
  choice=$(zenity --list --title=".hq — open project" --width=640 --height=380 \
    --text="Pick a project. Agents run sandboxed in that folder." \
    --column="Project" --column="Folder" --print-column=2 "${args[@]}" 2>/dev/null) || exit 0
  [ "$choice" = "Pick any folder (new project, OSINT, research, …)" ] || dir="$choice"
fi
if [ -z "$dir" ]; then
  start="$(cat "$LAST" 2>/dev/null || echo "$HOME")"
  dir=$(zenity --file-selection --directory --title=".hq — choose project folder" --filename="$start/" 2>/dev/null) || exit 0
fi
[ -d "$dir" ] || die "Folder not found: $dir"
echo "$dir" > "$LAST"
name=$(basename "$dir")

# --- already running (started by this launcher)? just reopen it
pidf="$HOME/.hq/logs/$name.pid"; log="$HOME/.hq/logs/$name.log"
if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
  url=$(grep -oP 'is running → \K\S+' "$log" | tail -1)
  [ -n "$url" ] && xdg-open "$url" >/dev/null 2>&1 && exit 0
fi

# --- free port from 7420
port=7420
while (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; do port=$((port + 1)); [ $port -gt 7520 ] && die "No free port between 7420 and 7520."; done

cd "$HQ_ROOT"
# shellcheck disable=SC2086
setsid nohup "$NODE" bin/dothq.mjs --repo "$dir" --port "$port" $REMOTE_FLAGS > "$log" 2>&1 < /dev/null &
pid=$!
echo $pid > "$pidf"

# --- wait for it (dothq opens the browser itself)
(
  for i in $(seq 1 60); do
    if grep -q "is running →" "$log" 2>/dev/null; then echo 100; exit 0; fi
    kill -0 $pid 2>/dev/null || exit 1
    echo $((i * 100 / 60)); echo "# Starting .hq for $name (setup checks)…"; sleep 0.5
  done
) | zenity --progress --title=".hq" --text="Starting .hq for $name…" --auto-close --no-cancel --width=380 2>/dev/null || true

if grep -q "is running →" "$log"; then
  notify-send -i "$HOME/.local/share/icons/dothq.svg" ".hq running: $name" "http://127.0.0.1:$port  ·  log: $log" 2>/dev/null || true
else
  zenity --text-info --title=".hq failed to start — $name" --width=760 --height=480 --filename="$log" 2>/dev/null || cat "$log"
  exit 1
fi
