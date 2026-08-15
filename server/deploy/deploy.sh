#!/usr/bin/env bash
# Deploy the server to the Pi over the tailnet: SIGTERM-safe restart (§7 —
# the worker aborts current steps cleanly before systemd restarts it).
#
# Usage: deploy/deploy.sh <pi-tailnet-name> [remote-path]
set -euo pipefail

PI_HOST="${1:?usage: deploy.sh <pi-tailnet-name> [remote-path]}"
REMOTE_PATH="${2:-/opt/pocket-agent/repo}"
REMOTE_USER="${DEPLOY_USER:-pocket-agent}"

echo "==> Deploying to ${REMOTE_USER}@${PI_HOST}:${REMOTE_PATH}"

ssh "${REMOTE_USER}@${PI_HOST}" bash -s <<EOF
set -euo pipefail
cd "${REMOTE_PATH}"
echo "==> git pull"
git pull --ff-only

cd server
echo "==> pnpm install --prod"
pnpm install --prod --frozen-lockfile

echo "==> build"
pnpm run build

echo "==> restart service (SIGTERM first, systemd handles the rest)"
sudo systemctl restart pocket-agent

sleep 2
sudo systemctl is-active --quiet pocket-agent && echo "==> pocket-agent is active" || (echo "!! pocket-agent failed to start" && sudo journalctl -u pocket-agent -n 50 --no-pager && exit 1)
EOF

echo "==> Deployed. Tailing logs (Ctrl-C to stop):"
ssh "${REMOTE_USER}@${PI_HOST}" journalctl -u pocket-agent -f
