# Usage: ./chat-history.ps1 <conversationId>
# Wraps `pnpm --dir server chat history`, sourcing env vars from pocket-agent.local.ps1.
$ErrorActionPreference = "Stop"

$serverDir = Split-Path $PSScriptRoot -Parent

$envFile = Join-Path $PSScriptRoot "pocket-agent.local.ps1"
if (-not (Test-Path $envFile)) {
    throw "Missing $envFile — copy pocket-agent.local.ps1.example to pocket-agent.local.ps1 (in this same folder) and fill in your values."
}
. $envFile

if ($args.Count -lt 1) {
    throw "usage: chat-history.ps1 <conversationId>"
}

& pnpm --dir $serverDir chat history $args[0]
