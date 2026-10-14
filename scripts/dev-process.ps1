# Isolate Windows console control events while forwarding service logs.
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
