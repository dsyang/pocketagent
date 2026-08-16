#!/usr/bin/env bash
# Deploy the server to the Pi over the tailnet: SIGTERM-safe restart (§7 —
# the worker aborts current steps cleanly before systemd restarts it).
#
# Usage: deploy/deploy.sh <pi-tailnet-name> [remote-path]
set -euo pipefail

PI_HOST="${1:?usage: deploy.sh <pi-tailnet-name> [remote-path]}"
REMOTE_PATH="${2:-/opt/pocket-agent/repo}"
# pocket-agent (the service account) has a nologin shell by design — see
# setup-pi.md §4 — so we SSH in as an admin account and hop to pocket-agent
# via passwordless sudo (setup-pi.md §4a) for the repo-owned steps.
REMOTE_USER="${DEPLOY_USER:-pi}"
SERVICE_USER="${SERVICE_USER:-pocket-agent}"

echo "==> Deploying to ${REMOTE_USER}@${PI_HOST}:${REMOTE_PATH} (as ${SERVICE_USER})"

ssh "${REMOTE_USER}@${PI_HOST}" bash -s <<EOF
set -euo pipefail
echo "==> git pull"
sudo -u ${SERVICE_USER} git -C "${REMOTE_PATH}" pull --ff-only

echo "==> pnpm install (full deps — tsc lives in devDependencies, needed for the build below)"
sudo -u ${SERVICE_USER} bash -c 'cd "${REMOTE_PATH}/server" && pnpm install --frozen-lockfile'

echo "==> build"
sudo -u ${SERVICE_USER} bash -c 'cd "${REMOTE_PATH}/server" && pnpm run build'

echo "==> prune to prod deps"
sudo -u ${SERVICE_USER} bash -c 'cd "${REMOTE_PATH}/server" && pnpm prune --prod'

echo "==> restart service (SIGTERM first, systemd handles the rest)"
sudo systemctl restart pocket-agent

sleep 2
sudo systemctl is-active --quiet pocket-agent && echo "==> pocket-agent is active" || (echo "!! pocket-agent failed to start" && sudo journalctl -u pocket-agent -n 50 --no-pager && exit 1)
EOF

echo "==> Deployed. Tailing logs (Ctrl-C to stop):"
ssh "${REMOTE_USER}@${PI_HOST}" journalctl -u pocket-agent -f
