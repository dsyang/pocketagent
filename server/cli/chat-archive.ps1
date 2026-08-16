# Usage: ./chat-archive.ps1 [--unarchive] <conversationId>
# Wraps `pnpm --dir server chat archive|unarchive`, sourcing env vars from pocket-agent.local.ps1.
$ErrorActionPreference = "Stop"

$serverDir = Split-Path $PSScriptRoot -Parent

$envFile = Join-Path $PSScriptRoot "pocket-agent.local.ps1"
if (-not (Test-Path $envFile)) {
    throw "Missing $envFile — copy pocket-agent.local.ps1.example to pocket-agent.local.ps1 (in this same folder) and fill in your values."
}
. $envFile

$command = "archive"
$rest = @()
foreach ($a in $args) {
    if ($a -eq "--unarchive") {
        $command = "unarchive"
    } else {
        $rest += $a
    }
}

if ($rest.Count -lt 1) {
    throw "usage: chat-archive.ps1 [--unarchive] <conversationId>"
}

& pnpm --dir $serverDir chat $command $rest[0]
