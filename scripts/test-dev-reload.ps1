param([string]$PythonPath)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $PythonPath) { $PythonPath = Join-Path $ProjectRoot "backend\.venv\Scripts\python.exe" }

# Exercise the shared launcher without running Mooncell's database or downloaders.
. (Join-Path $PSScriptRoot "dev-process.ps1")

$RunDirectory = Join-Path $ProjectRoot (".cache\dev-reload-tests\" + [guid]::NewGuid().ToString("N"))
$AppDirectory = Join-Path $RunDirectory "app"
$TestsDirectory = Join-Path $RunDirectory "tests"
$null = New-Item -ItemType Directory -Path $AppDirectory, $TestsDirectory -Force
$AppPath = Join-Path $AppDirectory "main.py"
Set-Content -LiteralPath (Join-Path $AppDirectory "__init__.py") -Value "" -Encoding UTF8
Set-Content -LiteralPath $AppPath -Encoding UTF8 -Value @'
import os
from fastapi import FastAPI
app = FastAPI()
@app.get("/")
def root():
    return {"pid": os.getpid()}
'@

# Use a batch path with spaces, like pnpm.cmd installed under Program Files.
$FrontendPath = Join-Path $RunDirectory "frontend helper.cmd"
Set-Content -LiteralPath $FrontendPath -Encoding ASCII -Value @"
@echo off
"$PythonPath" -u -c "import time; print('frontend-alive', flush=True); time.sleep(120)"
"@
$PortListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$PortListener.Start()
$TestPort = $PortListener.LocalEndpoint.Port
$PortListener.Stop()
$TestUrl = "http://127.0.0.1:$TestPort/"

function Wait-BackendPid {
    param([int]$PreviousPid = 0)
    $Deadline = [datetime]::UtcNow.AddSeconds(20)
    while ([datetime]::UtcNow -lt $Deadline) {
        try {
            $Response = Invoke-RestMethod -Uri $TestUrl -TimeoutSec 1
            if ($Response.pid -ne $PreviousPid) { return [int]$Response.pid }
        }
        catch { }
        Start-Sleep -Milliseconds 200
    }
    throw "Backend did not become available with a new worker PID. Logs: $RunDirectory"
}

$Services = @()
try {
    $Backend = Start-DevService -Name "backend" -FilePath $PythonPath `
        -Arguments @((Join-Path $PSScriptRoot "dev_backend.py"), "--reload-dir", "app",
                     "--reload-delay", "1", "--host", "127.0.0.1", "--port", $TestPort) `
        -WorkingDirectory $RunDirectory -LogDirectory $RunDirectory
    $Services += $Backend
    $Frontend = Start-DevService -Name "frontend" -FilePath $FrontendPath -Arguments @("dev") `
        -WorkingDirectory $RunDirectory -LogDirectory $RunDirectory
    $Services += $Frontend
    $WorkerPid = Wait-BackendPid
    if ($Frontend.Process.HasExited) { throw "Batch frontend launcher exited unexpectedly." }

    Set-Content -LiteralPath (Join-Path $TestsDirectory "ignored.py") -Value "# test edit"
    Start-Sleep -Seconds 3
    if ((Wait-BackendPid) -ne $WorkerPid) { throw "A test edit incorrectly reloaded the backend." }
    for ($Iteration = 1; $Iteration -le 3; $Iteration++) {
        Add-Content -LiteralPath $AppPath -Value "# reload $Iteration" -Encoding UTF8
        $WorkerPid = Wait-BackendPid -PreviousPid $WorkerPid
        if ($Backend.Process.HasExited -or $Frontend.Process.HasExited) {
            throw "Hot reload stopped a service launcher."
        }
        Write-Host "Reload $Iteration passed; launcher, frontend and new worker are alive."
    }
    foreach ($Service in $Services) { Write-DevOutput -Service $Service }
    if ((Get-Content -LiteralPath $Frontend.Output[0].Path -Raw) -notmatch "frontend-alive") {
        throw "Frontend log redirection failed."
    }
    Write-Host "Development reload regression test passed. Logs: $RunDirectory"
}
finally {
    foreach ($Service in $Services) { Stop-ProcessTree -Process $Service.Process }
}
