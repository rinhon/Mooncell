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

. (Join-Path $PSScriptRoot "dev-process.ps1")

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
$env:PYTHONUNBUFFERED = "1"
$env:PYTHONIOENCODING = "utf-8"

$LogDirectory = Join-Path $ProjectRoot (".cache\dev\" + [guid]::NewGuid().ToString("N"))
$null = New-Item -ItemType Directory -Path $LogDirectory -Force
$Services = @()

try {
    Write-Host "Starting Mooncell development services..." -ForegroundColor Cyan

    $BackendService = Start-DevService -Name "backend" `
        -FilePath $PythonPath `
        -Arguments @(
            (Join-Path $PSScriptRoot "dev_backend.py"),
            "--reload-dir", "app", "--reload-delay", "1",
            "--host", $ListenAddress, "--port", $BackendPort
        ) `
        -WorkingDirectory $BackendDirectory `
        -LogDirectory $LogDirectory
    $Services += $BackendService

    $FrontendService = Start-DevService -Name "frontend" `
        -FilePath $PnpmPath `
        -Arguments @(
            "dev", "--host", $ListenAddress, "--port", $FrontendPort, "--strictPort"
        ) `
        -WorkingDirectory $FrontendDirectory `
        -LogDirectory $LogDirectory
    $Services += $FrontendService

    Write-Host ""
    Write-Host "Mooncell is running:" -ForegroundColor Green
    Write-Host "  WebUI:  http://localhost:$FrontendPort"
    Write-Host "  API:    http://localhost:$BackendPort/docs"
    Write-Host "  Logs:   $LogDirectory"
    Write-Host "  Press Ctrl+C to stop both services."
    Write-Host ""

    while ($true) {
        foreach ($Service in $Services) {
            Write-DevOutput -Service $Service
            if ($Service.Process.HasExited) {
                throw "$($Service.Name) process $($Service.Process.Id) exited with code $($Service.Process.ExitCode). See logs: $LogDirectory"
            }
        }

        Start-Sleep -Milliseconds 500
    }
}
finally {
    if ($Services.Count -gt 0) {
        Write-Host "`nStopping Mooncell development services..." -ForegroundColor Yellow
        foreach ($Service in $Services) {
            Stop-ProcessTree -Process $Service.Process
            Write-DevOutput -Service $Service
        }
        Write-Host "Both services have stopped." -ForegroundColor Green
    }
}
