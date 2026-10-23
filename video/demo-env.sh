#!/bin/sh
# The demo machine for Orca's showcase video: its own Lima VM (orca-demo),
# its own Orca daemon (port 9478, its own config under ~/.orca-demo) and the
# made-up "acme" workspace of real open-source apps (demo/). Nothing here
# touches your own Orca, its daemon or its containers.
#
#   ./demo-env.sh up       VM, demo repos, images and daemon, ready to record
#   ./demo-env.sh reset    back to a fresh machine: no workspace, no containers
#   ./demo-env.sh down     stop the daemon and the VM
#   ./demo-env.sh env      print the variables the recorder uses
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$ROOT/.." && pwd)
VM=orca-demo
PORT=9478
DEMO_HOME="$HOME/.orca-demo"
SOCK="$HOME/.lima/$VM/sock/docker.sock"
CONFIG="$DEMO_HOME/Library/Application Support/orca/config.json"
PIDFILE="$DEMO_HOME/daemon.pid"
DAEMON="$REPO/target/debug/orca-daemon"
export DOCKER_HOST="unix://$SOCK"

vm_up() {
  if ! limactl list --format '{{.Name}}' 2>/dev/null | grep -qx "$VM"; then
    mkdir -p "$DEMO_HOME"
    # The gateway keeps its certificates in the demo daemon's folder, so
    # that one is writable in the VM; the rest of your home isn't.
    limactl create --name "$VM" --cpus 4 --memory 8 --disk 40 --tty=false \
      --set '.mounts = [{"location": "~"}, {"location": "~/.orca-demo", "writable": true}]' template://docker
  fi
  limactl list --format '{{.Name}} {{.Status}}' | grep -qx "$VM Running" || limactl start "$VM"
}

# Each demo project and the workspace become a git repo in ~/.orca-demo/git,
# cloned as https://git.acme.dev/acme/<name>.git (the demo's own git config
# points that at the local copies).
repos() {
  rm -rf "$DEMO_HOME/git"
  mkdir -p "$DEMO_HOME/git/acme"
  cat >"$DEMO_HOME/.gitconfig" <<GIT
[url "file://$DEMO_HOME/git/acme/"]
	insteadOf = https://git.acme.dev/acme/
[init]
	defaultBranch = main
GIT
  for dir in "$ROOT/demo/projects/"* "$ROOT/demo/workspace"; do
    name=$(basename "$dir")
    tmp=$(mktemp -d)
    cp -R "$dir/." "$tmp/"
    git -C "$tmp" init -q -b main
    git -C "$tmp" -c user.name=Acme -c user.email=dev@acme.example add -A
    git -C "$tmp" -c user.name=Acme -c user.email=dev@acme.example commit -qm "Initial commit"
    git clone -q --bare "$tmp" "$DEMO_HOME/git/acme/$name.git"
    rm -rf "$tmp"
  done
}

# Folders a developer has on disk and opens in Orca, outside the workspace.
folders() {
  mkdir -p "$DEMO_HOME/code"
  for dir in "$ROOT/demo/folders/"*; do
    rm -rf "$DEMO_HOME/code/$(basename "$dir")"
    cp -R "$dir" "$DEMO_HOME/code/"
  done
}

images() {
  cat "$ROOT"/demo/projects/*/compose.yaml "$ROOT"/demo/folders/*/compose.yaml "$ROOT/demo/workspace/compose.yaml" |
    awk '/image:/ {print $2}' | sort -u | while read -r img; do
      docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img"
    done
  docker image inspect caddy:2-alpine >/dev/null 2>&1 || docker pull -q caddy:2-alpine
}

daemon_up() {
  [ -x "$DAEMON" ] || (cd "$REPO" && cargo build --bin orca-daemon --bin orca)
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then return; fi
  mkdir -p "$DEMO_HOME/.docker"
  # Its own HOME, but your Docker CLI plugins (compose, buildx).
  [ -e "$DEMO_HOME/.docker/cli-plugins" ] || ln -s "$HOME/.docker/cli-plugins" "$DEMO_HOME/.docker/cli-plugins"
  HOME="$DEMO_HOME" nohup "$DAEMON" --port "$PORT" >"$DEMO_HOME/daemon.log" 2>&1 &
  echo $! >"$PIDFILE"
  i=0
  until curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null; do
    i=$((i + 1)); [ $i -gt 60 ] && { echo "daemon didn't start; see $DEMO_HOME/daemon.log"; exit 1; }
    sleep 1
  done
}

daemon_down() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

api() { curl -sf -X "$1" -H "Authorization: Bearer $(token)" -H "Content-Type: application/json" ${3:+-d "$3"} "http://127.0.0.1:$PORT/api/v1$2"; }

token() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['api_token'])" "$CONFIG"; }

case "${1:-}" in
  up)
    vm_up
    repos
    folders
    images
    daemon_up
    echo "Demo daemon on http://127.0.0.1:$PORT (HOME=$DEMO_HOME)"
    ;;
  reset)
    daemon_down
    vm_up
    docker ps -aq | xargs -r docker rm -f >/dev/null
    docker volume ls -q | xargs -r docker volume rm >/dev/null
    docker network prune -f >/dev/null
    rm -rf "$DEMO_HOME/code" "$DEMO_HOME/Library" "$DEMO_HOME/.local" "$DEMO_HOME/.config"
    repos
    folders
    daemon_up
    # The gateway already serves the team's domain, as it would on a
    # developer's machine that has run Orca for a while.
    api PUT /gateway/config '{"domain":"acme.localhost","http_port":80,"https_port":443,"tls_mode":"orca_ca"}' >/dev/null
    api POST /gateway/start >/dev/null
    api PUT /gateway/landing '{"title":"Acme dev","show_status":true,"show_targets":true,"search":true}' >/dev/null
    echo "Fresh demo machine on http://127.0.0.1:$PORT"
    ;;
  down)
    daemon_down
    limactl stop "$VM"
    ;;
  env)
    echo "ORCA_DEMO_URL=http://127.0.0.1:$PORT"
    echo "ORCA_DEMO_TOKEN=$(token)"
    echo "ORCA_DEMO_HOME=$DEMO_HOME"
    echo "ORCA_DEMO_REPO=https://git.acme.dev/acme/workspace.git"
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 1
    ;;
esac
