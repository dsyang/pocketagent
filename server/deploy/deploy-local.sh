#!/usr/bin/env bash
# Deploy the server from the Pi itself: same SIGTERM-safe restart as
# deploy.sh (§7 — the worker aborts current steps cleanly before systemd
# restarts it), just without the SSH hop.
#
# Run this as your admin user (the one with passwordless sudo to
# pocket-agent, per setup-pi.md §4a) while logged into the Pi directly —
# e.g. over a local console or SSH session already on the box.
#
# Usage: deploy/deploy-local.sh [remote-path]
set -euo pipefail

REMOTE_PATH="${1:-/opt/pocket-agent/repo}"
SERVICE_USER="${SERVICE_USER:-pocket-agent}"

echo "==> Deploying ${REMOTE_PATH} (as ${SERVICE_USER})"

echo "==> git pull"
sudo -u "${SERVICE_USER}" git -C "${REMOTE_PATH}" pull --ff-only

echo "==> pnpm install (full deps — tsc lives in devDependencies, needed for the build below)"
sudo -u "${SERVICE_USER}" bash -c "cd '${REMOTE_PATH}/server' && pnpm install --frozen-lockfile"

echo "==> build"
sudo -u "${SERVICE_USER}" bash -c "cd '${REMOTE_PATH}/server' && pnpm run build"

echo "==> prune to prod deps"
sudo -u "${SERVICE_USER}" bash -c "cd '${REMOTE_PATH}/server' && pnpm prune --prod"

echo "==> restart service (SIGTERM first, systemd handles the rest)"
sudo systemctl restart pocket-agent

sleep 2
sudo systemctl is-active --quiet pocket-agent && echo "==> pocket-agent is active" || (echo "!! pocket-agent failed to start" && sudo journalctl -u pocket-agent -n 50 --no-pager && exit 1)

echo "==> Deployed. Tailing logs (Ctrl-C to stop):"
sudo journalctl -u pocket-agent -f
