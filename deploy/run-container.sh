#!/bin/sh
# (Re)create the Veeam Assistant web container.
#
#   sudo sh ~/veeam-assistant/deploy/run-container.sh               # uses veeam-assistant:1.0.0
#   sudo sh ~/veeam-assistant/deploy/run-container.sh veeam-assistant:1.0.0
#
# Run it again after any change to /etc/veeam-assistant/app.env: Docker only
# reads the env file when a container is created, so a restart is not enough.
# Accounts, history and approvals live in the veeam-assistant-data volume and
# are kept.
set -eu

IMAGE="${1:-veeam-assistant:1.0.0}"
NAME=veeam-assistant
ENV_FILE=/etc/veeam-assistant/app.env
CERT_DIR=/etc/veeam-assistant/certs
SERVERS_DIR=${VA_SERVERS_DIR:-/opt/veeam-mcp}
BACKENDS=/etc/veeam-assistant/backends.json
HOSTS_FILE=/etc/veeam-assistant/add-hosts

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE. Create it first (see SETUP_GUIDE.md)."; exit 1; }
[ -f "$BACKENDS" ] || { echo "Missing $BACKENDS. Create it first (see SETUP_GUIDE.md)."; exit 1; }
[ -d "$SERVERS_DIR" ] || { echo "Missing $SERVERS_DIR. Run build-mcp-servers.sh first."; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "Image $IMAGE not found. Build it first (step 6)."; exit 1; }

set -- --env-file "$ENV_FILE" -p 127.0.0.1:3000:3000 -v veeam-assistant-data:/data \
    -v /etc/veeam-assistant:/etc/veeam-assistant:ro -v "$SERVERS_DIR:/servers:ro"
[ -d "$CERT_DIR" ] && set -- "$@" -v "$CERT_DIR:/certs:ro"
if [ -f "$HOSTS_FILE" ]; then
  # one "name:ip" per line, e.g. vbr01.corp.example.com:10.0.20.15
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    set -- "$@" --add-host "$line"
  done < "$HOSTS_FILE"
fi

if docker container inspect "$NAME" >/dev/null 2>&1; then
  echo "Replacing the existing $NAME container."
  docker rm -f "$NAME" >/dev/null
fi

docker run -d --name "$NAME" --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges \
  "$@" "$IMAGE" >/dev/null

echo "Started $NAME from $IMAGE. Waiting for it to answer..."
i=0
while [ $i -lt 20 ]; do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "OK: http://127.0.0.1:3000/healthz responds."
    exit 0
  fi
  i=$((i+1)); sleep 1
done
echo "It did not answer within 20 seconds. Check: sudo docker logs $NAME"
exit 1
