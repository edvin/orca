#!/bin/sh
# Before the start-page scene (script.mjs): the rest of Acme's apps set up and
# running, so the page looks like a real team's, and the website and the Git
# server on their own databases with something in them for the databases
# scene to move.
set -e
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.lima/orca-demo/sock/docker.sock}"
API=http://127.0.0.1:9478/api/v1
CONFIG="$HOME/.orca-demo/Library/Application Support/orca/config.json"
TOKEN=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['api_token'])" "$CONFIG")
api() { curl -sf -X "$1" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' "$API$2" ${3:+-d "$3"}; }

APPS="website git whiteboard passwords files"
for p in $APPS; do api POST "/workspace/projects/$p/setup" '{}' >/dev/null; done

# All of them running.
i=0
until [ "$(api GET /workspace | python3 -c "import sys,json; w=sys.argv[1].split(); print(sum(1 for p in json.load(sys.stdin)['projects'] if p['key'] in w and p['running']))" "$APPS")" = 5 ]; do
  i=$((i + 1)); [ $i -gt 120 ] && { echo "the apps didn't start" >&2; exit 1; }
  sleep 3
done

# WordPress installed, so its database has a site in it.
i=0
# Through the demo gateway, from inside the demo machine (port 443 on this
# Mac may be another gateway's).
gw() { docker run --rm --network container:orca-gateway curlimages/curl -sk --resolve www.acme.localhost:443:127.0.0.1 "$@"; }
until gw -o /dev/null -w '%{http_code}' https://www.acme.localhost/wp-admin/install.php | grep -q 200; do
  i=$((i + 1)); [ $i -gt 60 ] && { echo "WordPress didn't answer" >&2; exit 1; }
  sleep 3
done
gw -o /dev/null \
  --data 'weblog_title=Acme&user_name=admin&admin_password=acme-demo-2026&admin_password2=acme-demo-2026&pw_weak=1&admin_email=web@acme.example&blog_public=0' \
  'https://www.acme.localhost/wp-admin/install.php?step=2'
