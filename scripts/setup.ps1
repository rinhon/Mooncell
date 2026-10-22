#requires -Version 5.1
<#
.SYNOPSIS
    Install the Windows development environment and project dependencies.
.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -CheckOnly
#>
[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackendDirectory = Join-Path $ProjectRoot "backend"
$FrontendDirectory = Join-Path $ProjectRoot "frontend"
$VenvPython = Join-Path $BackendDirectory ".venv\Scripts\python.exe"
$ToolsDirectory = Join-Path $ProjectRoot ".cache\tools\pnpm"
$Package = Get-Content -LiteralPath (Join-Path $FrontendDirectory "package.json") -Raw | ConvertFrom-Json
if ($Package.packageManager -notmatch '^pnpm@(\d+\.\d+\.\d+)$') {
    throw "frontend\package.json must declare an exact pnpm version."
}
$PnpmVersion = $Matches[1]
$Missing = [System.Collections.Generic.List[string]]::new()

function Find-CommandPath {
    param([string]$Name)
    $Command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $Command) { return $Command.Source }
    return $null
}

function Invoke-Checked {
    param([string]$FilePath, [string[]]$Arguments)
    & $FilePath @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $FilePath $($Arguments -join ' ')"
    }
}

function Get-CommandOutput {
    param([string]$FilePath, [string[]]$Arguments)
    if (-not $FilePath) { return $null }
    try {
        $Output = & $FilePath @Arguments 2>&1
        if ($LASTEXITCODE -eq 0) { return ($Output -join "`n").Trim() }
    }
    catch { }
    return $null
}

function Update-ProcessPath {
    # Preserve version-manager/custom entries while discovering newly installed tools.
    $Entries = @($env:Path -split ';')
    $Entries += [Environment]::GetEnvironmentVariable("Path", "Machine") -split ';'
    $Entries += [Environment]::GetEnvironmentVariable("Path", "User") -split ';'
    $env:Path = ($Entries | Where-Object { $_ } | Select-Object -Unique) -join ';'
}

function Install-WingetPackage {
    param([string]$Id)
    $Winget = Find-CommandPath "winget.exe"
    if (-not $Winget) {
        throw "WinGet is required to install $Id. Install/update Microsoft App Installer: https://aka.ms/getwinget"
    }
    Write-Host "Installing $Id ..." -ForegroundColor Cyan
    Invoke-Checked $Winget @(
        "install", "--id", $Id, "--exact", "--source", "winget", "--silent",
        "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
    )
    Update-ProcessPath
}

function Find-Python312 {
    # An existing project venv is sufficient; the Python launcher is optional.
    $Candidates = @($VenvPython)
    $Launcher = Find-CommandPath "py.exe"
    if ($Launcher) {
        $LaunchedPython = Get-CommandOutput $Launcher @("-3.12", "-c", "import sys; print(sys.executable)")
        if ($LaunchedPython) { $Candidates += $LaunchedPython }
    }
    $Candidates += Find-CommandPath "python.exe"
    $Candidates += Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
    $Candidates += Join-Path $env:ProgramFiles "Python312\python.exe"
    foreach ($Candidate in $Candidates) {
        if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
            $Version = Get-CommandOutput $Candidate @("-c", "import sys; print('%d.%d' % sys.version_info[:2])")
            if ($Version -eq "3.12") { return $Candidate }
        }
    }
    return $null
}

function Find-CompatibleNode {
    $Candidates = @((Find-CommandPath "node.exe"), (Join-Path $env:ProgramFiles "nodejs\node.exe"))
    foreach ($Candidate in $Candidates) {
        $Version = Get-CommandOutput $Candidate @("--version")
        if ($Version -and $Version -match '^v(\d+)\.(\d+)\.(\d+)$') {
            if ([version]$Version.Substring(1) -ge [version]"22.13.0") { return $Candidate }
        }
    }
    return $null
}

function Find-LocalPnpm {
    $ManifestPath = Join-Path $ToolsDirectory "node_modules\pnpm\package.json"
    if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
        $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
        if ($Manifest.version -eq $PnpmVersion) {
            $Entry = Join-Path (Split-Path -Parent $ManifestPath) $Manifest.bin.pnpm
            if (Test-Path -LiteralPath $Entry -PathType Leaf) { return $Entry }
        }
    }
    return $null
}

Write-Host "Mooncell Windows environment setup" -ForegroundColor Cyan
if ($CheckOnly) { Write-Host "Check only: no installations or file changes." }

$Python = Find-Python312
if (-not $Python -and -not $CheckOnly) {
    Install-WingetPackage "Python.Python.3.12"
    $Python = Find-Python312
    if (-not $Python) { throw "Python 3.12 is still unavailable. Open a new PowerShell and retry." }
}
if ($Python) { Write-Host "[OK] Python 3.12: $Python" }
else { $Missing.Add("Python 3.12") }

$Node = Find-CompatibleNode
if (-not $Node -and -not $CheckOnly) {
    Install-WingetPackage "OpenJS.NodeJS.LTS"
    $Node = Find-CompatibleNode
    if (-not $Node) { throw "Node.js >= 22.13 is still unavailable. Open a new PowerShell and retry." }
}
if ($Node) {
    # Ensure npm/pnpm subprocesses use the same Node installation.
    if (-not $CheckOnly) { $env:Path = (Split-Path -Parent $Node) + ";" + $env:Path }
    Write-Host "[OK] Node.js $(Get-CommandOutput $Node @('--version')): $Node"
}
else { $Missing.Add("Node.js >= 22.13") }

foreach ($Tool in @(
    @{ Name = "ffmpeg.exe"; Package = "Gyan.FFmpeg"; Flag = "-version"; Pattern = '^ffmpeg version ' },
    @{ Name = "ffprobe.exe"; Package = "Gyan.FFmpeg"; Flag = "-version"; Pattern = '^ffprobe version ' },
    @{ Name = "magick.exe"; Package = "ImageMagick.Q16-HDRI"; Flag = "-version"; Pattern = '^Version: ImageMagick 7\.' }
)) {
    $Executable = Find-CommandPath $Tool.Name
    $Version = Get-CommandOutput $Executable @($Tool.Flag)
    if ((-not $Version -or $Version -notmatch $Tool.Pattern) -and -not $CheckOnly) {
        Install-WingetPackage $Tool.Package
        $Executable = Find-CommandPath $Tool.Name
        $Version = Get-CommandOutput $Executable @($Tool.Flag)
        if (-not $Version -or $Version -notmatch $Tool.Pattern) {
            throw "$($Tool.Name) is still unavailable or incompatible. Check PATH in a new PowerShell and retry."
        }
    }
    if ($Version -and $Version -match $Tool.Pattern) { Write-Host "[OK] $($Tool.Name): $(($Version -split '\r?\n')[0])" }
    else { $Missing.Add($Tool.Name) }
}

$PnpmEntry = Find-LocalPnpm
$Pnpm = Find-CommandPath "pnpm.cmd"
if (-not $Pnpm) { $Pnpm = Find-CommandPath "pnpm.exe" }
$GlobalPnpmVersion = Get-CommandOutput $Pnpm @("--version")
if ($GlobalPnpmVersion -ne $PnpmVersion) { $Pnpm = $null }
if (-not $PnpmEntry -and -not $Pnpm -and -not $CheckOnly) {
    # Project-local pnpm avoids changing global npm/Corepack/version-manager shims.
    $Npm = Join-Path (Split-Path -Parent $Node) "npm.cmd"
    if (-not (Test-Path -LiteralPath $Npm -PathType Leaf)) { $Npm = Find-CommandPath "npm.cmd" }
    if (-not $Npm) { throw "npm.cmd is unavailable. Repair the Node.js installation and retry." }
    Write-Host "Installing project-local pnpm $PnpmVersion ..." -ForegroundColor Cyan
    Invoke-Checked $Npm @(
        "install", "--prefix", $ToolsDirectory, "--cache", (Join-Path $ProjectRoot ".cache\npm"),
        "--no-audit", "--no-fund", "--package-lock=false", "pnpm@$PnpmVersion"
    )
    $PnpmEntry = Find-LocalPnpm
    if (-not $PnpmEntry) { throw "Project-local pnpm installation failed." }
}
if (($PnpmEntry -and $Node) -or $Pnpm) { Write-Host "[OK] pnpm $PnpmVersion" }
else { $Missing.Add("pnpm $PnpmVersion") }

if (-not $CheckOnly) {
    if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
        Invoke-Checked $Python @("-m", "venv", (Join-Path $BackendDirectory ".venv"))
    }
    # Never delete or silently replace an incompatible existing virtual environment.
    $VenvVersion = Get-CommandOutput $VenvPython @("-c", "import sys; print('%d.%d' % sys.version_info[:2])")
    if ($VenvVersion -ne "3.12") {
        throw "backend\.venv is incompatible. Move it aside and rerun setup to create a Python 3.12 environment."
    }
    Write-Host "Installing backend dependencies ..." -ForegroundColor Cyan
    # Use a writable project temp directory, including inside the Windows sandbox.
    $PreviousTemp = $env:TEMP
    $PreviousTmp = $env:TMP
    $SetupTemp = Join-Path $ProjectRoot (".cache\setup\" + [guid]::NewGuid().ToString("N"))
    $null = New-Item -ItemType Directory -Path $SetupTemp -Force
    try {
        $env:TEMP = $SetupTemp
        $env:TMP = $SetupTemp
        Invoke-Checked $VenvPython @(
            "-m", "pip", "--cache-dir", (Join-Path $ProjectRoot ".cache\pip"),
            "install", "-e", ($BackendDirectory + "[dev]")
        )
    }
    finally {
        $env:TEMP = $PreviousTemp
        $env:TMP = $PreviousTmp
    }
    Write-Host "Installing frontend dependencies from the lockfile ..." -ForegroundColor Cyan
    $InstallArguments = @("--dir", $FrontendDirectory, "install", "--frozen-lockfile", "--store-dir", (Join-Path $ProjectRoot ".pnpm-store"))
    if ($PnpmEntry) { Invoke-Checked $Node (@($PnpmEntry) + $InstallArguments) }
    else { Invoke-Checked $Pnpm $InstallArguments }
}

if (Test-Path -LiteralPath $VenvPython -PathType Leaf) {
    $DependencyCheck = @'
import importlib.metadata as m
import pathlib, sys, tomllib
assert sys.version_info[:2] == (3, 12), 'backend venv must use Python 3.12'
project = tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))['project']
for requirement in project['dependencies'] + project['optional-dependencies']['dev']:
    name = requirement.split('[')[0].split('>=')[0]
    m.version(name)
print('Backend dependencies present')
'@
    $BackendCheck = Get-CommandOutput $VenvPython @("-c", $DependencyCheck, (Join-Path $BackendDirectory "pyproject.toml"))
    if ($BackendCheck) {
        Invoke-Checked $VenvPython @("-m", "pip", "check")
        Write-Host "[OK] Backend virtual environment and dependencies"
    }
    else { $Missing.Add("backend virtual environment / dependencies (including dev tools)") }
}
else { $Missing.Add("backend\.venv") }

$Vite = Join-Path $FrontendDirectory "node_modules\vite\bin\vite.js"
$Modules = Join-Path $FrontendDirectory "node_modules\.modules.yaml"
if ((Test-Path -LiteralPath $Vite -PathType Leaf) -and (Test-Path -LiteralPath $Modules -PathType Leaf)) {
    Write-Host "[OK] Frontend pnpm dependencies present"
}
else { $Missing.Add("frontend dependencies") }

if ($Missing.Count -gt 0) {
    foreach ($Item in $Missing) { Write-Warning "Missing or incompatible: $Item" }
    throw "Environment is incomplete. Run scripts\setup.ps1 without -CheckOnly to install dependencies."
}
if ($CheckOnly) { Write-Host "Environment checks passed." -ForegroundColor Green }
else {
    Write-Host "Setup complete. Open a new PowerShell and start services from the project root:" -ForegroundColor Green
    Write-Host "  powershell.exe -NoProfile -File `"$(Join-Path $PSScriptRoot 'dev.ps1')`""
}
