# Usage: ./chat-send.ps1 <conversationId> "<message>"
# Wraps `pnpm --dir server chat send`, sourcing env vars from pocket-agent.local.ps1.
$ErrorActionPreference = "Stop"

$serverDir = Split-Path $PSScriptRoot -Parent

$envFile = Join-Path $PSScriptRoot "pocket-agent.local.ps1"
if (-not (Test-Path $envFile)) {
    throw "Missing $envFile — copy pocket-agent.local.ps1.example to pocket-agent.local.ps1 (in this same folder) and fill in your values."
}
. $envFile

if ($args.Count -lt 2) {
    throw "usage: chat-send.ps1 <conversationId> <message>"
}

$conversationId = $args[0]
$message = $args[1..($args.Count - 1)] -join " "

& pnpm --dir $serverDir chat send $conversationId $message
