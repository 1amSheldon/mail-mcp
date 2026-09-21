$ErrorActionPreference = 'Stop'
$backupRoot = Join-Path $env:USERPROFILE ('.config\mail-mcp\backups\draft-workflow-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $env:USERPROFILE '.config\mail-mcp\service') -Destination (Join-Path $backupRoot 'service') -Recurse
Copy-Item -LiteralPath (Join-Path $env:USERPROFILE '.codex\config.toml') -Destination (Join-Path $backupRoot 'codex-config.toml')
Copy-Item -LiteralPath (Join-Path $env:USERPROFILE '.codex\skills\mail-mcp\SKILL.md') -Destination (Join-Path $backupRoot 'SKILL.md')
$taskXml = Export-ScheduledTask -TaskName 'Mail MCP Local Service'
[IO.File]::WriteAllText((Join-Path $backupRoot 'task.xml'), $taskXml)
Write-Output $backupRoot
