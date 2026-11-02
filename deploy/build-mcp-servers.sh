#!/bin/sh
# Build the Veeam MCP servers from the veeam-ai monorepo into /opt/veeam-mcp,
# which the portal container mounts read-only at /servers.
#
#   sudo sh ~/veeam-assistant/deploy/build-mcp-servers.sh [path-to-clone]
#
# Node servers (package.json) and Python servers (pyproject.toml) are both
# handled. Python servers are built into a virtual environment using the same
# image as the portal, so the result runs inside the portal container.
#
# Nothing is installed on the host: every build runs in a throwaway container.
set -eu

# $HOME is root's under sudo, so prefer the invoking user's home folder.
if [ -n "${SUDO_USER:-}" ] && [ -z "${1:-}" ]; then
  HOME_DIR=$(getent passwd "$SUDO_USER" | cut -d: -f6)
else
  HOME_DIR="$HOME"
fi
SRC="${1:-$HOME_DIR/veeam-mcp-server}"
OUT=/opt/veeam-mcp
NODE_IMAGE=node:24-alpine
PORTAL_IMAGE="${VA_PORTAL_IMAGE:-veeam-assistant:1.0.0}"

[ -d "$SRC/servers" ] || { echo "No $SRC/servers folder. Clone the repository first, or pass its path."; exit 1; }

echo "Source:      $SRC"
echo "Destination: $OUT"
echo "Servers:     $(ls "$SRC/servers" | tr '\n' ' ')"
echo

# ---- Node servers --------------------------------------------------------
if ls "$SRC"/servers/*/package.json >/dev/null 2>&1; then
  echo "=== Node servers"
  docker run --rm -v "$SRC:/src" -w /src "$NODE_IMAGE" sh -c '
    set -e
    for d in servers/*/; do
      [ -f "$d/package.json" ] || continue
      echo "--- building $d"
      cd "/src/$d"
      npm ci --no-audit --fund=false 2>/dev/null || npm install --no-audit --fund=false
      npm run build --if-present
      cd /src
    done
  '
fi

# ---- Python servers ------------------------------------------------------
# Built with the portal image so the virtual environment matches the
# interpreter that will run it inside the container.
if ls "$SRC"/servers/*/pyproject.toml >/dev/null 2>&1; then
  echo
  echo "=== Python servers"
  if ! docker image inspect "$PORTAL_IMAGE" >/dev/null 2>&1; then
    echo "The portal image $PORTAL_IMAGE is not built yet."
    echo "Build it first:  cd ~/veeam-assistant/web && sudo docker build -t $PORTAL_IMAGE ."
    echo "Then run this script again. (Node servers above are already built.)"
    exit 1
  fi
  echo "Python in the portal image: $(docker run --rm "$PORTAL_IMAGE" python3 --version)"
  docker run --rm --user root -v "$SRC:/src" -w /src "$PORTAL_IMAGE" sh -c '
    set -e
    # Compilers, in case a dependency ships no ready-made wheel.
    apt-get update >/dev/null 2>&1 && \
      apt-get install -y --no-install-recommends build-essential libffi-dev libssl-dev >/dev/null 2>&1 || \
      echo "(could not install compilers; continuing, most packages do not need them)"
    for d in servers/*/; do
      [ -f "$d/pyproject.toml" ] || continue
      echo "--- building $d"
      cd "/src/$d"
      rm -rf .venv
      python3 -m venv .venv
      .venv/bin/pip install --quiet --upgrade pip wheel
      .venv/bin/pip install . || { echo "!!! $d failed to install. See the error above."; exit 1; }
      cd /src
    done
  '
fi

# ---- Copy the results ----------------------------------------------------
mkdir -p "$OUT"
for d in "$SRC"/servers/*/; do
  name=$(basename "$d")
  echo "--- copying $name"
  rm -rf "$OUT/$name.new"
  mkdir -p "$OUT/$name.new"
  tar -C "$d" -cf - . | tar -C "$OUT/$name.new" -xf -
  rm -rf "$OUT/$name.old"
  [ -d "$OUT/$name" ] && mv "$OUT/$name" "$OUT/$name.old"
  mv "$OUT/$name.new" "$OUT/$name"
done
chmod -R a+rX "$OUT"

# ---- Report ---------------------------------------------------------------
# One line per server built from Veeam's repository. The names and paths printed
# here are the ones backends.json (README step 24) already uses.
echo
echo "Built servers in $OUT:"
problems=0
for srcdir in "$SRC"/servers/*/; do
  name=$(basename "$srcdir")
  d="$OUT/$name/"
  if [ ! -d "$d" ]; then
    echo "  $name  PROBLEM  was not copied to $OUT"; problems=1; continue
  fi
  if [ -d "${d}.venv/bin" ]; then
    # A Python server is started through its own interpreter. Its python3 is a
    # link to the interpreter inside the website image, so on this host the link
    # can look broken: check that the files exist, then that Python really starts
    # inside the image, which is where the website runs it.
    py="${d}.venv/bin/python3"
    if { [ -e "${d}.venv/bin/$name" ] || [ -L "${d}.venv/bin/$name" ]; } && { [ -e "$py" ] || [ -L "$py" ]; }; then
      if docker run --rm -v "$OUT:/servers:ro" --entrypoint "/servers/$name/.venv/bin/python3" "$PORTAL_IMAGE" -c "import sys" >/dev/null 2>&1; then
        echo "  $name  OK  Python  /servers/$name/.venv/bin/$name"
      else
        echo "  $name  PROBLEM  built, but its Python does not start inside $PORTAL_IMAGE. Check step 15, then rebuild with step 16."
        problems=1
      fi
    else
      echo "  $name  PROBLEM  built, but .venv/bin/$name or .venv/bin/python3 is missing. Found:"
      ls "${d}.venv/bin" | sed 's/^/        /'
      problems=1
    fi
    continue
  fi
  entry=""
  for cand in build/index.js dist/index.js lib/index.js index.js src/index.js; do
    [ -f "$d$cand" ] && { entry="$cand"; break; }
  done
  if [ -n "$entry" ]; then
    echo "  $name  OK  Node    /servers/$name/$entry"
  else
    echo "  $name  PROBLEM  no start file found. Index files present:"
    find "$d" -maxdepth 2 -name 'index.*' -not -path '*/node_modules/*' | sed 's/^/        /'
    problems=1
  fi
done
echo
if [ "$problems" -eq 0 ]; then
  echo "All servers are in place. Next: README step 18."
else
  echo "At least one server has a PROBLEM. Share the lines above when you ask for help."
  exit 1
fi
