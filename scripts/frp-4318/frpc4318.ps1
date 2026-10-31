# Tunnel helper: local 4318 -> hkcn2-1 frps (mTLS). Usage: frpc4318.ps1 [status|stop|check|probe]
$ErrorActionPreference = 'Stop'

$needle = 'frpc-hkcn2-4318.toml'
$entry = 'https://hkcn2-1.5913286.cc:14318/'

function Get-FrpcPids {
  Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" |
    Where-Object { $_.CommandLine -like "*$needle*" } |
    Select-Object -ExpandProperty ProcessId
}

$action = 'status'
if ($args.Count -ge 1) { $action = [string]$args[0] }
$action = $action.ToLower()

$running = @(Get-FrpcPids)

if ($action -eq 'check') {
  if ($running.Count -gt 0) { exit 0 }
  exit 1
}

if ($action -eq 'stop') {
  if ($running.Count -eq 0) {
    Write-Output 'NOT-RUNNING'
    exit 0
  }
  foreach ($procId in $running) { Stop-Process -Id $procId -Force }
  Start-Sleep -Seconds 1
  Write-Output ("STOPPED " + ($running -join ','))
  exit 0
}

if ($action -eq 'probe') {
  try {
    $response = Invoke-WebRequest -Uri $entry -UseBasicParsing -TimeoutSec 8
    Write-Output ("PUBLIC-OK " + $response.StatusCode)
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 403) {
      Write-Output 'PUBLIC-403 console process is missing YUNMOMO_PUBLIC_ORIGINS, restart npm run app'
    } else {
      Write-Output ('PUBLIC-FAIL ' + $_.Exception.Message)
    }
  }
  exit 0
}

if ($running.Count -gt 0) {
  Write-Output ("RUNNING " + $running[0])
} else {
  Write-Output 'STOPPED'
}
