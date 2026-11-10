# Isolate Windows console control events while forwarding service logs.
function Get-DevInstanceRoots {
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Processes,
        [int]$CurrentProcessId = $PID
    )

    $ById = @{}
    foreach ($Item in $Processes) { $ById[[int]$Item.ProcessId] = $Item }
    # Never terminate this invocation or the terminal/agent that launched it.
    $ProtectedIds = @{}
    $AncestorId = $CurrentProcessId
    while ($AncestorId -gt 0 -and -not $ProtectedIds.ContainsKey($AncestorId)) {
        $ProtectedIds[$AncestorId] = $true
        if (-not $ById.ContainsKey($AncestorId)) { break }
        $AncestorId = [int]$ById[$AncestorId].ParentProcessId
    }

    $Root = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
    $ScriptPatterns = @{}
    foreach ($RelativePath in @('scripts\dev.ps1', 'scripts\dev_launch.py',
                                'scripts\dev_backend.py', 'frontend\node_modules\vite\bin\vite.js')) {
        # Require a whole argument, not a substring or a path from another clone.
        $PathPattern = [regex]::Escape((Join-Path $Root $RelativePath)).Replace('\\', '[\\/]')
        $ScriptPatterns[$RelativePath] = '(?:"' + $PathPattern + '"|' + $PathPattern + ')(?=\s|$)'
    }
    $Executable = '^\s*(?:"[^"]+"|\S+)\s+'
    $MatchesById = @{}
    foreach ($Item in $Processes) {
        $ProcessId = [int]$Item.ProcessId
        if ($ProtectedIds.ContainsKey($ProcessId) -or -not $Item.CommandLine) { continue }
        $CommandLine = [string]$Item.CommandLine
        $IsInstance = switch -Regex ([string]$Item.Name) {
            '^(powershell|pwsh)\.exe$' {
                # Only a script-mode host is ours; never match text inside -Command.
                $CommandLine -match ($Executable + '(?:(?:-NoProfile|-NoLogo|-NonInteractive)\s+)*-File\s+' + $ScriptPatterns['scripts\dev.ps1'])
                break
            }
            '^python(?:w|[0-9.]+)?\.exe$' {
                $CommandLine -match ($Executable + '(?:' + $ScriptPatterns['scripts\dev_launch.py'] + '|' + $ScriptPatterns['scripts\dev_backend.py'] + ')')
                break
            }
            '^node\.exe$' {
                $CommandLine -match ($Executable + $ScriptPatterns['frontend\node_modules\vite\bin\vite.js'])
                break
            }
            default { $false }
        }
        if ($IsInstance) { $MatchesById[$ProcessId] = $Item }
    }
    foreach ($Item in $MatchesById.Values) {
        $AncestorId = [int]$Item.ParentProcessId
        $Seen = @{}
        while ($ById.ContainsKey($AncestorId) -and -not $Seen.ContainsKey($AncestorId)) {
            if ($MatchesById.ContainsKey($AncestorId)) { break }
            $Seen[$AncestorId] = $true
            $AncestorId = [int]$ById[$AncestorId].ParentProcessId
        }
        if (-not $MatchesById.ContainsKey($AncestorId)) { $Item }
    }
}

function Stop-ExistingDevInstances {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    # Fail closed if process inspection is unavailable: do not silently start duplicates.
    $Processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $Roots = @(Get-DevInstanceRoots -ProjectRoot $ProjectRoot -Processes $Processes)
    foreach ($Root in $Roots) {
        $Live = Get-CimInstance Win32_Process -Filter "ProcessId = $($Root.ProcessId)" -ErrorAction Stop
        if ($null -eq $Live -or $Live.CreationDate -ne $Root.CreationDate) { continue }
        $TreeIds = @{ ([int]$Root.ProcessId) = $true }
        do {
            $Added = $false
            foreach ($Item in $Processes) {
                if ($TreeIds.ContainsKey([int]$Item.ParentProcessId) -and -not $TreeIds.ContainsKey([int]$Item.ProcessId)) {
                    $TreeIds[[int]$Item.ProcessId] = $true
                    $Added = $true
                }
            }
        } while ($Added)
        if ($TreeIds.ContainsKey($PID)) { throw "Refusing to stop the current launcher process tree." }

        Write-Host "Stopping previous Mooncell instance: $($Root.Name) (PID $($Root.ProcessId))" -ForegroundColor Yellow
        $KillOutput = & "$env:SystemRoot\System32\taskkill.exe" /PID $Root.ProcessId /T /F 2>&1
        $KillExitCode = $LASTEXITCODE
        # Verify identities as well as PIDs, which Windows can reuse after exit.
        $Remaining = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $Candidate = $_
            $TreeIds.ContainsKey([int]$Candidate.ProcessId) -and @($Processes | Where-Object {
                $_.ProcessId -eq $Candidate.ProcessId -and $_.CreationDate -eq $Candidate.CreationDate
            }).Count -gt 0
        })
        if ($Remaining.Count -gt 0) {
            throw "Could not stop previous Mooncell instance (taskkill exit $KillExitCode; remaining PIDs: $($Remaining.ProcessId -join ', ')). $KillOutput"
        }
    }
}

function Stop-ProcessTree {
    param([Parameter(Mandatory)][System.Diagnostics.Process]$Process)

    if ($Process.HasExited) { return }
    try {
        Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" `
            -ArgumentList @("/PID", $Process.Id, "/T", "/F") `
            -WindowStyle Hidden -Wait | Out-Null
    }
    catch { Write-Warning "Could not stop service process $($Process.Id): $_" }
}

function Start-DevService {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$LogDirectory,
        [string]$LauncherPython = $PythonPath
    )

    $StdoutPath = Join-Path $LogDirectory "$Name.stdout.log"
    $StderrPath = Join-Path $LogDirectory "$Name.stderr.log"
    # PowerShell 5 and 7 differ in console creation with redirected output. A
    # Python wrapper explicitly sets CREATE_NEW_CONSOLE and hides the window.
    $CommandJson = ConvertTo-Json -InputObject (@($FilePath) + $Arguments) -Compress
    $CommandData = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($CommandJson))
    $LauncherPath = Join-Path $PSScriptRoot "dev_launch.py"
    $ServiceProcess = Start-Process -FilePath $LauncherPython `
        -ArgumentList @(('"' + $LauncherPath + '"'), "--command", $CommandData) `
        -WorkingDirectory $WorkingDirectory -WindowStyle Hidden `
        -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -PassThru
    return [pscustomobject]@{
        Name = $Name
        Process = $ServiceProcess
        Output = @(
            [pscustomobject]@{ Path = $StdoutPath; Position = [long]0 },
            [pscustomobject]@{ Path = $StderrPath; Position = [long]0 }
        )
    }
}

function Write-DevOutput {
    param([Parameter(Mandatory)]$Service)

    foreach ($Output in $Service.Output) {
        if (-not (Test-Path -LiteralPath $Output.Path -PathType Leaf)) { continue }
        $Stream = [System.IO.File]::Open(
            $Output.Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        try {
            if ($Stream.Length -lt $Output.Position) { $Output.Position = [long]0 }
            $null = $Stream.Seek($Output.Position, [System.IO.SeekOrigin]::Begin)
            $Reader = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::UTF8)
            try {
                $Text = $Reader.ReadToEnd()
                $Output.Position = $Stream.Position
                if ($Text) { Write-Host $Text -NoNewline }
            }
            finally { $Reader.Dispose() }
        }
        finally { $Stream.Dispose() }
    }
}

function Wait-DevServicesReady {
    param(
        [Parameter(Mandatory)][object[]]$Services,
        [Parameter(Mandatory)][string[]]$Urls,
        [int]$TimeoutSeconds = 60
    )

    $Deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    $PendingUrls = [System.Collections.Generic.List[string]]::new()
    foreach ($Url in $Urls) { $PendingUrls.Add($Url) }
    while ([datetime]::UtcNow -lt $Deadline) {
        foreach ($Service in $Services) {
            Write-DevOutput -Service $Service
            $Service.Process.Refresh()
            if ($Service.Process.HasExited) {
                throw "$($Service.Name) exited with code $($Service.Process.ExitCode) before startup completed. See service logs."
            }
        }
        foreach ($Url in $PendingUrls.ToArray()) {
            try {
                $Response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1
                if ($Response.StatusCode -eq 200) { $null = $PendingUrls.Remove($Url) }
            }
            catch { }
        }
        if ($PendingUrls.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    }
    throw "Development services did not become ready within $TimeoutSeconds seconds: $($PendingUrls -join ', '). Check service logs; Windows sandbox restrictions can prevent dependency access or reload-worker communication."
}
