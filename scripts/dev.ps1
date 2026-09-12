$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackendDirectory = Join-Path $ProjectRoot "backend"
$FrontendDirectory = Join-Path $ProjectRoot "frontend"
$PythonPath = Join-Path $BackendDirectory ".venv\Scripts\python.exe"
$ListenAddress = "0.0.0.0"
$BackendPort = 8000
$FrontendPort = 5173

function Test-TcpPortAvailable {
    param(
        [Parameter(Mandatory)]
        [int]$Port
    )

    $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
    try {
        $Listener.Start()
        return $true
    }
    catch [System.Net.Sockets.SocketException] {
        return $false
    }
    finally {
        $Listener.Stop()
    }
}

function Find-AvailableTcpPort {
    param(
        [Parameter(Mandatory)]
        [int]$PreferredPort,
        [Parameter(Mandatory)]
        [int]$FallbackStartPort
    )

    if (Test-TcpPortAvailable -Port $PreferredPort) {
        return $PreferredPort
    }

    for ($CandidatePort = $FallbackStartPort; $CandidatePort -le 65535; $CandidatePort++) {
        if (Test-TcpPortAvailable -Port $CandidatePort) {
            return $CandidatePort
        }
    }

    throw "No available TCP port was found."
}

function Resolve-Executable {
    param(
        [Parameter(Mandatory)]
        [string[]]$Names
    )

    foreach ($Name in $Names) {
        $Command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $Command) {
            return $Command.Source
        }
    }

    return $null
}

function Stop-ProcessTree {
    param(
        [Parameter(Mandatory)]
        [System.Diagnostics.Process]$Process
    )

    if ($Process.HasExited) {
        return
    }

    # Both uvicorn --reload and pnpm create child processes.
    & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F 2>$null | Out-Null
}

if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw @"
Backend virtual environment not found: $PythonPath
Run these commands from the project root first:
  py -3.12 -m venv backend\.venv
  & backend\.venv\Scripts\python.exe -m pip install -e "backend[dev]"
"@
}

$PnpmPath = Resolve-Executable -Names @("pnpm.cmd", "pnpm.exe", "pnpm")
if ($null -eq $PnpmPath) {
    throw "pnpm was not found. Install pnpm or enable it with: corepack enable pnpm"
}

if (-not (Test-Path -LiteralPath (Join-Path $FrontendDirectory "node_modules") -PathType Container)) {
    throw "Frontend dependencies are missing. Run: pnpm --dir frontend install"
}

$SelectedBackendPort = Find-AvailableTcpPort -PreferredPort $BackendPort -FallbackStartPort 8100
$SelectedFrontendPort = Find-AvailableTcpPort -PreferredPort $FrontendPort -FallbackStartPort 5174

if ($SelectedBackendPort -ne $BackendPort) {
    Write-Warning "Backend port $BackendPort is unavailable; using $SelectedBackendPort instead."
    $BackendPort = $SelectedBackendPort
}

if ($SelectedFrontendPort -ne $FrontendPort) {
    Write-Warning "Frontend port $FrontendPort is unavailable; using $SelectedFrontendPort instead."
    $FrontendPort = $SelectedFrontendPort
}

# Child processes inherit these values. Vite uses the first value for its proxy,
# while FastAPI uses the second value for its development CORS allowlist.
$env:MOONCELL_DEV_BACKEND_URL = "http://127.0.0.1:$BackendPort"
$env:MOONCELL_ALLOWED_ORIGINS = "http://localhost:$FrontendPort,http://127.0.0.1:$FrontendPort"

$Processes = @()

try {
    Write-Host "Starting Mooncell development services..." -ForegroundColor Cyan

    $BackendProcess = Start-Process `
        -FilePath $PythonPath `
        -ArgumentList @(
            "-m", "uvicorn", "app.main:app", "--reload",
            "--host", $ListenAddress, "--port", $BackendPort
        ) `
        -WorkingDirectory $BackendDirectory `
        -NoNewWindow `
        -PassThru
    $Processes += $BackendProcess

    $FrontendProcess = Start-Process `
        -FilePath $PnpmPath `
        -ArgumentList @(
            "dev", "--host", $ListenAddress, "--port", $FrontendPort, "--strictPort"
        ) `
        -WorkingDirectory $FrontendDirectory `
        -NoNewWindow `
        -PassThru
    $Processes += $FrontendProcess

    Write-Host ""
    Write-Host "Mooncell is running:" -ForegroundColor Green
    Write-Host "  WebUI:  http://localhost:$FrontendPort"
    Write-Host "  API:    http://localhost:$BackendPort/docs"
    Write-Host "  Press Ctrl+C to stop both services."
    Write-Host ""

    while ($true) {
        foreach ($Process in $Processes) {
            if ($Process.HasExited) {
                throw "Service process $($Process.Id) exited with code $($Process.ExitCode)."
            }
        }

        Start-Sleep -Milliseconds 500
    }
}
finally {
    if ($Processes.Count -gt 0) {
        Write-Host "`nStopping Mooncell development services..." -ForegroundColor Yellow
        foreach ($Process in $Processes) {
            Stop-ProcessTree -Process $Process
        }
        Write-Host "Both services have stopped." -ForegroundColor Green
    }
}
