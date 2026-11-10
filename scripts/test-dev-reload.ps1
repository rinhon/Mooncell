param([string]$PythonPath)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $PythonPath) { $PythonPath = Join-Path $ProjectRoot "backend\.venv\Scripts\python.exe" }

# Exercise the shared launcher without running Mooncell's database or downloaders.
. (Join-Path $PSScriptRoot "dev-process.ps1")

# Process discovery is pure so unrelated applications and PID ancestry can be
# checked without killing any real development session.
$FixtureRoot = 'C:\Mooncell Test'
$FixtureProcesses = @(
    [pscustomobject]@{ ProcessId = 10; ParentProcessId = 1; Name = 'pwsh.exe'; CommandLine = 'pwsh.exe -NoProfile -File "C:\Mooncell Test\scripts\dev.ps1"' },
    [pscustomobject]@{ ProcessId = 11; ParentProcessId = 10; Name = 'python.exe'; CommandLine = 'python.exe "C:\Mooncell Test\scripts\dev_launch.py" --command abc' },
    [pscustomobject]@{ ProcessId = 12; ParentProcessId = 11; Name = 'python.exe'; CommandLine = 'python.exe "C:\Mooncell Test\scripts\dev_backend.py" --port 8100' },
    [pscustomobject]@{ ProcessId = 13; ParentProcessId = 12; Name = 'python.exe'; CommandLine = 'python.exe -c "from multiprocessing.spawn import spawn_main"' },
    [pscustomobject]@{ ProcessId = 20; ParentProcessId = 1; Name = 'python.exe'; CommandLine = 'python.exe "C:/Mooncell Test/scripts/dev_backend.py" --port 8101' },
    [pscustomobject]@{ ProcessId = 30; ParentProcessId = 1; Name = 'node.exe'; CommandLine = 'node.exe "C:\Mooncell Test\frontend\node_modules\vite\bin\vite.js" --port 5506' },
    [pscustomobject]@{ ProcessId = 40; ParentProcessId = 1; Name = 'python.exe'; CommandLine = 'python.exe "C:\Other\scripts\dev_launch.py" --command abc' },
    [pscustomobject]@{ ProcessId = 41; ParentProcessId = 1; Name = 'python.exe'; CommandLine = 'python.exe "C:\Mooncell Test\scripts\dev_backend.py.bak"' },
    [pscustomobject]@{ ProcessId = 42; ParentProcessId = 1; Name = 'pwsh.exe'; CommandLine = 'pwsh.exe -Command "Get-Content C:\Mooncell Test\scripts\dev.ps1"' },
    [pscustomobject]@{ ProcessId = 43; ParentProcessId = 1; Name = 'python.exe'; CommandLine = 'python.exe -c "print(123)" "C:\Mooncell Test\scripts\dev_backend.py"' },
    [pscustomobject]@{ ProcessId = 44; ParentProcessId = 1; Name = 'python.exe'; CommandLine = $null },
    [pscustomobject]@{ ProcessId = 90; ParentProcessId = 1; Name = 'pwsh.exe'; CommandLine = 'pwsh.exe -File "C:\Mooncell Test\scripts\dev.ps1"' },
    [pscustomobject]@{ ProcessId = 99; ParentProcessId = 90; Name = 'pwsh.exe'; CommandLine = 'pwsh.exe -File "C:\Mooncell Test\scripts\dev.ps1"' }
)
$DiscoveredIds = @(Get-DevInstanceRoots -ProjectRoot $FixtureRoot -Processes $FixtureProcesses -CurrentProcessId 99 |
    ForEach-Object { [int]$_.ProcessId } | Sort-Object)
if (($DiscoveredIds -join ',') -ne '10,20,30') {
    throw "Instance discovery matched incorrect process roots: $($DiscoveredIds -join ',')"
}
if (@(Get-DevInstanceRoots -ProjectRoot $FixtureRoot -Processes @() -CurrentProcessId 99).Count -ne 0) {
    throw 'Empty process discovery must return no instances.'
}
Write-Host 'Instance discovery passed: old trees, orphan services, alternate ports, path boundaries and current ancestors.'

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
    Wait-DevServicesReady -Services $Services -Urls @($TestUrl) -TimeoutSeconds 20
    # A live launcher is insufficient: an unavailable HTTP endpoint must fail.
    $ReadinessTimedOut = $false
    try {
        Wait-DevServicesReady -Services $Services -Urls @("${TestUrl}missing") -TimeoutSeconds 1
    }
    catch {
        if ($_.Exception.Message -notlike "Development services did not become ready*") { throw }
        $ReadinessTimedOut = $true
    }
    if (-not $ReadinessTimedOut) { throw "Readiness accepted an unavailable HTTP endpoint." }
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
    # Use a disposable project root so cleanup never touches the user's server.
    $FixtureScripts = Join-Path $RunDirectory 'scripts'
    $null = New-Item -ItemType Directory -Path $FixtureScripts -Force
    $FixtureScript = Join-Path $FixtureScripts 'dev.ps1'
    $PortListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $PortListener.Start()
    $FixturePort = $PortListener.LocalEndpoint.Port
    $PortListener.Stop()
    Set-Content -LiteralPath $FixtureScript -Encoding ASCII -Value @'
param([string]$PythonPath, [int]$Port)
& $PythonPath -m http.server $Port --bind 127.0.0.1
'@
    for ($Iteration = 1; $Iteration -le 2; $Iteration++) {
        Stop-ExistingDevInstances -ProjectRoot $RunDirectory
        $Fixture = Start-DevService -Name "instance-$Iteration" `
            -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
            -Arguments @('-NoProfile', '-File', $FixtureScript, '-PythonPath', $PythonPath, '-Port', $FixturePort) `
            -WorkingDirectory $RunDirectory -LogDirectory $RunDirectory
        $Services += $Fixture
        Wait-DevServicesReady -Services @($Fixture) -Urls @("http://127.0.0.1:$FixturePort/") -TimeoutSeconds 20
        Stop-ExistingDevInstances -ProjectRoot $RunDirectory
        if (-not $Fixture.Process.WaitForExit(10000)) { throw 'Old instance wrapper did not exit.' }
        if ($Backend.Process.HasExited -or $Frontend.Process.HasExited) {
            throw 'Cleanup incorrectly stopped services from another project root.'
        }
        Write-Host "Instance replacement $Iteration passed; previous process tree stopped and unrelated services survived."
    }
    Stop-ExistingDevInstances -ProjectRoot $RunDirectory
    Write-Host "Development reload and instance cleanup regression tests passed. Logs: $RunDirectory"
}
finally {
    foreach ($Service in $Services) { Stop-ProcessTree -Process $Service.Process }
}
