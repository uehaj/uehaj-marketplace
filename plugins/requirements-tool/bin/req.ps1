# req — 統一 CLI の起動ラッパ（Windows PowerShell / pwsh 用。ADR-009・SOL-33）。
# node を起動して実体のディスパッチャ（bin/req.ts）へ引数を透過する。
# 使い方: bin\req.ps1 <サブコマンド> [引数...]   （例: bin\req.ps1 lint）
$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "req: node が見つかりません（Node 23.6+ が必要）"
}
& node (Join-Path $PSScriptRoot "req.ts") @args
exit $LASTEXITCODE
