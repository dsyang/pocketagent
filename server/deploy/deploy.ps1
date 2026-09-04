<#
.SYNOPSIS
    Deploy the server to the Pi over the tailnet (Windows/PowerShell port of deploy.sh).
.DESCRIPTION
    SIGTERM-safe restart (see setup-pi.md §7 — the worker aborts current
    steps cleanly before systemd restarts it). Requires the Windows OpenSSH
    client (ssh.exe) on PATH — bundled with Windows 10 1809+/11; if missing:
    Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
.PARAMETER PiHost
    The Pi's tailnet hostname, e.g. mypi.tailxxxx.ts.net
.PARAMETER RemotePath
    Path to the repo on the Pi. Defaults to /opt/pocket-agent/repo.
.EXAMPLE
    .\deploy.ps1 mypi.tailxxxx.ts.net
.EXAMPLE
    $env:DEPLOY_USER = "myadminuser"; .\deploy.ps1 mypi.tailxxxx.ts.net
#>
param(
    [string]$PiHost,
    [string]$RemotePath = "/opt/pocket-agent/repo"
)

$ErrorActionPreference = "Stop"

if (-not $PiHost) {
    Write-Error "usage: deploy.ps1 <pi-tailnet-name> [remote-path]"
    exit 1
}

# pocket-agent (the service account) has a nologin shell by design — see
# setup-pi.md §4 — so we SSH in as an admin account and hop to pocket-agent
# via passwordless sudo (setup-pi.md §4a) for the repo-owned steps.
$RemoteUser = if ($env:DEPLOY_USER) { $env:DEPLOY_USER } else { "pi" }
$ServiceUser = if ($env:SERVICE_USER) { $env:SERVICE_USER } else { "pocket-agent" }

Write-Host "==> Deploying to ${RemoteUser}@${PiHost}:${RemotePath} (as ${ServiceUser})"

$remoteScript = @"
set -euo pipefail
echo "==> git pull"
sudo -u $ServiceUser git -C "$RemotePath" pull --ff-only

echo "==> pnpm install (full deps — tsc lives in devDependencies, needed for the build below)"
sudo -u $ServiceUser bash -c 'cd "$RemotePath/server" && pnpm install --frozen-lockfile'

echo "==> build"
sudo -u $ServiceUser bash -c 'cd "$RemotePath/server" && pnpm run build'

echo "==> prune to prod deps"
sudo -u $ServiceUser bash -c 'cd "$RemotePath/server" && pnpm prune --prod'

echo "==> restart service (SIGTERM first, systemd handles the rest)"
sudo systemctl restart pocket-agent

sleep 2
sudo systemctl is-active --quiet pocket-agent && echo "==> pocket-agent is active" || (echo "!! pocket-agent failed to start" && sudo journalctl -u pocket-agent -n 50 --no-pager && exit 1)
"@

$remoteScript | & ssh "$RemoteUser@$PiHost" bash -s
if ($LASTEXITCODE -ne 0) {
    Write-Error "Deploy failed (ssh exited $LASTEXITCODE)"
    exit $LASTEXITCODE
}

Write-Host "==> Deployed. Tailing logs (Ctrl-C to stop):"
& ssh "$RemoteUser@$PiHost" journalctl -u pocket-agent -f
