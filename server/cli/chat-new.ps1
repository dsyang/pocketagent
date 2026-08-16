# Usage: ./chat-new.ps1 [--model <model>] [--follow] "<message>"
# Wraps `pnpm --dir server chat new`, sourcing env vars from pocket-agent.local.ps1.
# --follow immediately sends the same text as the first message too, so streaming starts right away.
$ErrorActionPreference = "Stop"

$serverDir = Split-Path $PSScriptRoot -Parent

$envFile = Join-Path $PSScriptRoot "pocket-agent.local.ps1"
if (-not (Test-Path $envFile)) {
    throw "Missing $envFile — copy pocket-agent.local.ps1.example to pocket-agent.local.ps1 (in this same folder) and fill in your values."
}
. $envFile

$model = $env:POCKET_AGENT_MODEL
$follow = $false
$rest = @()
$i = 0
while ($i -lt $args.Count) {
    if ($args[$i] -eq "--model") {
        $model = $args[$i + 1]
        $i += 2
    } elseif ($args[$i] -eq "--follow") {
        $follow = $true
        $i += 1
    } else {
        $rest += $args[$i]
        $i += 1
    }
}

if (-not $model) {
    throw "No model given. Pass --model <model> or set POCKET_AGENT_MODEL in pocket-agent.local.ps1."
}

$title = $rest -join " "
$id = (& pnpm --dir $serverDir chat new $model $title | Select-Object -Last 1).Trim()
Write-Output $id

if ($follow) {
    & (Join-Path $PSScriptRoot "chat-send.ps1") $id $title
}
