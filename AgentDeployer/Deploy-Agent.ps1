<#
.SYNOPSIS
  Deploys WeldingCsvAgent to one or more inspection PCs over SMB, and
  optionally registers/starts it as a Windows Service.

.DESCRIPTION
  Everything happens over SMB (file copy to \\<ip>\C\...) and sc.exe's
  remote service control (which itself rides over the same SMB/RPC named
  pipe channel, port 445 - no WinRM/PsExec needed).

  Target PCs are resolved from pcs.json by line + vision_type. Only
  Welding (+/-) is implemented today - Lead/Lead Align/Pouch Align/Pinhole
  will need their own payload/<VisionType>/ folder and
  templates/<visiontype>.personality.template.json before they can be
  deployed here; see the "Adding a new vision type" note in README.md.

  Registering a Windows Service is optional (-InstallService). Without it,
  files are copied but nothing is started - SMB alone cannot launch a
  remote process; only sc.exe's remote *service* control can, which is why
  Windows Service registration is the only way this script can start an
  agent on a remote PC.

  sc.exe's remote service control needs an *admin* token on the target,
  which plain "Everyone" SMB share access does not grant - these are two
  separate permission systems. Each inspection PC needs a local admin
  account (default name in config.json: AgentDeploy) with
  LocalAccountTokenFilterPolicy=1 set in the registry, otherwise a local
  account gets a filtered (non-admin) token over the network and sc.exe
  fails with "Access is denied" even though the account really is an
  admin. Before touching each target, this script runs
  `net use \\<ip>\IPC$ /user:<ip>\<account> <password>` to establish an
  authenticated session - Windows then reuses that same session for the
  file share and for sc.exe's RPC calls to that same server, no need to
  pass credentials again per-command.

.PARAMETER Lines
  Line numbers to target, e.g. "5-2","5-3". Default: all lines in pcs.json.

.PARAMETER Sides
  Cathode and/or Anode. Default: both.

.PARAMETER InstallService
  Register (if not already registered) and start the agent as a Windows
  Service (auto-start on boot). Without this, files are copied only.

.PARAMETER NoStart
  Combined with -InstallService: register the service but don't start it
  yet.

.PARAMETER DryRun
  Print what would be deployed (targets + rendered personality.json) and
  exit without touching anything. No credentials needed for this.

.PARAMETER Force
  Skip the confirmation prompt.

.PARAMETER DeployAccount
  Local admin account on each inspection PC used for the remote SMB/sc.exe
  session. Default: config.json's deployAccount (AgentDeploy).

.PARAMETER Credential
  PSCredential for -DeployAccount. If not supplied (and not -DryRun),
  prompted for interactively - the password is never written to disk by
  this script, since it's a shared admin credential across every
  inspection PC.

.EXAMPLE
  .\Deploy-Agent.ps1 -Lines 5-2 -Sides Cathode -DryRun

.EXAMPLE
  .\Deploy-Agent.ps1 -Lines 5-2 -Sides Cathode -InstallService

.EXAMPLE
  .\Deploy-Agent.ps1 -InstallService -Force
    Deploys to every Welding PC in pcs.json, no confirmation prompt.
#>
param(
    [string[]]$Lines,
    [ValidateSet("Cathode", "Anode")]
    [string[]]$Sides = @("Cathode", "Anode"),
    [switch]$InstallService,
    [switch]$NoStart,
    [switch]$DryRun,
    [switch]$Force,
    [string]$DeployAccount,
    [System.Management.Automation.PSCredential]$Credential
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$config = Get-Content (Join-Path $root "config.json") -Raw | ConvertFrom-Json
$pcs = (Get-Content (Join-Path $root "pcs.json") -Raw | ConvertFrom-Json).pcs
$template = Get-Content (Join-Path $root "templates\welding.personality.template.json") -Raw
$payloadDir = Join-Path $root "payload\Welding"

if (-not $DeployAccount) { $DeployAccount = $config.deployAccount }

function Get-WeldingTargets {
    $sideMap = @{ "Welding (+)" = "Cathode"; "Welding (-)" = "Anode" }
    $fileSymbolMap = @{ "Cathode" = "+"; "Anode" = "-" }

    $targets = foreach ($pc in $pcs) {
        if (-not $sideMap.ContainsKey($pc.vision_type)) { continue }
        $side = $sideMap[$pc.vision_type]
        if ($Sides -notcontains $side) { continue }
        if ($Lines -and ($Lines -notcontains $pc.line)) { continue }

        [PSCustomObject]@{
            Line        = $pc.line
            Side        = $side
            Ip          = $pc.ip
            VisionName  = "Welding $side Vision"
            AgentId     = "$($pc.line)_WELDING_$($side.ToUpper())"
            FilePattern = "#$($pc.line) WELDING VISION($($fileSymbolMap[$side]))_$($config.modelToken)_{yyyyMMdd}*.csv"
        }
    }
    return $targets
}

function Get-RenderedPersonality($target) {
    $receiverUrl = "http://$($config.centralHost):$($config.receiverPort)/events"
    return $template `
        -replace '\{\{AGENT_ID\}\}', $target.AgentId `
        -replace '\{\{LINE\}\}', $target.Line `
        -replace '\{\{VISION_NAME\}\}', $target.VisionName `
        -replace '\{\{FILE_PATTERN\}\}', $target.FilePattern `
        -replace '\{\{RECEIVER_URL\}\}', $receiverUrl `
        -replace '\{\{HEARTBEAT_HOST\}\}', $config.centralHost `
        -replace '\{\{HEARTBEAT_PORT\}\}', $config.heartbeatPort
}

function Connect-RemoteAdmin([string]$ip, [System.Management.Automation.PSCredential]$cred) {
    # NOTE: native commands here are deliberately never run with `2>&1` -
    # in Windows PowerShell 5.1 that merge turns any stderr line into a
    # NativeCommandError, which becomes a *terminating* error under this
    # script's ErrorActionPreference=Stop even on routine, expected stderr
    # output (e.g. "nothing to delete"). Plain `| Out-Null` only touches
    # stdout, so stderr (the actual error text, if any) still prints
    # normally without being escalated.

    # A stale/anonymous session to this server (e.g. from a previous run,
    # or Windows' own auto-connect) blocks a fresh authenticated one -
    # Windows won't hold two different credentials to the same server at
    # once. Clear it first, same as the manual fix this was modeled on.
    net use "\\$ip\IPC$" /delete /y | Out-Null

    $plainPassword = $cred.GetNetworkCredential().Password
    $userArg = "$ip\$($cred.UserName)"
    net use "\\$ip\IPC$" /user:$userArg $plainPassword | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not authenticate to $ip as $userArg (see the net.exe error above)."
        return $false
    }

    # Cheap smoke test: query a service that exists on every Windows PC.
    # sc.exe gives no useful distinction between "PC unreachable" and
    # "connected but token was filtered to non-admin" other than this -
    # catching it here means a clear, specific error instead of a
    # confusing failure three steps later.
    sc.exe "\\$ip" query LanmanServer | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Connected to $ip but sc.exe was denied - LocalAccountTokenFilterPolicy is probably not set to 1 on that PC yet (see script header)."
        net use "\\$ip\IPC$" /delete /y | Out-Null
        return $false
    }

    return $true
}

function Disconnect-RemoteAdmin([string]$ip) {
    net use "\\$ip\IPC$" /delete /y | Out-Null
}

function Deploy-ToTarget($target, [bool]$installService, [bool]$startService, [System.Management.Automation.PSCredential]$cred) {
    $ip = $target.Ip
    Write-Host "`n=== $($target.AgentId) ($ip) ===" -ForegroundColor Cyan

    if (-not (Connect-RemoteAdmin $ip $cred)) {
        return $false
    }

    try {
        $sharePath = "\\$ip\C"
        if (-not (Test-Path $sharePath)) {
            Write-Warning "Cannot reach $sharePath - is the SMB share up and the PC online? Skipping."
            return $false
        }

        $remoteAgentDir = Join-Path $sharePath ($config.deployPath -replace '^C:\\', '')

        # Stop the existing service first (if any) so its exe isn't locked when we overwrite it.
        if (Get-RemoteServiceExists $ip) {
            Write-Host "Existing service found, stopping it before copying files..."
            sc.exe "\\$ip" stop $config.serviceName | Out-Null
            Start-Sleep -Seconds 2
        }

        New-Item -ItemType Directory -Path $remoteAgentDir -Force | Out-Null

        Write-Host "Copying agent binary..."
        Copy-Item -Path (Join-Path $payloadDir "*") -Destination $remoteAgentDir -Force

        Write-Host "Writing personality.json..."
        $personality = Get-RenderedPersonality $target
        # UTF8 no-BOM: a BOM in this file has bitten us before with other tools
        # silently misparsing config; keep it plain.
        [System.IO.File]::WriteAllText((Join-Path $remoteAgentDir "personality.json"), $personality, [System.Text.UTF8Encoding]::new($false))

        if ($installService) {
            $exePath = Join-Path $config.deployPath "WeldingCsvAgent.exe"
            $cfgPath = Join-Path $config.deployPath "personality.json"
            $binPath = "`"$exePath`" `"$cfgPath`""

            if (Get-RemoteServiceExists $ip) {
                Write-Host "Service already registered, leaving registration as-is."
            }
            else {
                Write-Host "Registering Windows Service..."
                sc.exe "\\$ip" create $config.serviceName binPath= $binPath start= auto obj= LocalSystem | Out-Null
            }

            if ($startService) {
                Write-Host "Starting service..."
                sc.exe "\\$ip" start $config.serviceName | Out-Null
            }
            else {
                Write-Host "Service registered but not started (-NoStart)."
            }
        }
        else {
            Write-Host "Files copied. No service installed - start the agent manually on this PC (or re-run with -InstallService)." -ForegroundColor Yellow
        }

        Write-Host "Done." -ForegroundColor Green
        return $true
    }
    finally {
        Disconnect-RemoteAdmin $ip
    }
}

function Get-RemoteServiceExists([string]$ip) {
    sc.exe "\\$ip" query $config.serviceName | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# ---- main ----

$targets = Get-WeldingTargets
if (-not $targets -or $targets.Count -eq 0) {
    Write-Warning "No targets matched -Lines/-Sides. Nothing to do."
    exit 1
}

Write-Host "Targets ($($targets.Count)):" -ForegroundColor Cyan
$targets | Format-Table Line, Side, Ip, AgentId, FilePattern -AutoSize

if ($DryRun) {
    Write-Host "`n--- DRY RUN: rendered personality.json for $($targets[0].AgentId) ---" -ForegroundColor Yellow
    Get-RenderedPersonality $targets[0]
    Write-Host "`n(dry run only - nothing was copied or started)" -ForegroundColor Yellow
    exit 0
}

if ($InstallService) {
    Write-Host "`nMode: copy files + register as Windows Service" -ForegroundColor Cyan -NoNewline
    if ($NoStart) { Write-Host " (registered, not started)" } else { Write-Host " (registered and started)" }
}
else {
    Write-Host "`nMode: copy files only (no service - start manually on each PC)" -ForegroundColor Cyan
}

if (-not $Force) {
    $answer = Read-Host "`nProceed with deployment to these $($targets.Count) PC(s)? Type YES to continue"
    if ($answer -ne "YES") {
        Write-Host "Aborted."
        exit 1
    }
}

if (-not $Credential) {
    $Credential = Get-Credential -UserName $DeployAccount -Message "Local admin account on the inspection PCs (same account/password on all of them)"
}

$results = foreach ($target in $targets) {
    $ok = Deploy-ToTarget -target $target -installService:$InstallService -startService:(-not $NoStart) -cred $Credential
    [PSCustomObject]@{ AgentId = $target.AgentId; Ip = $target.Ip; Success = $ok }
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize
$failed = $results | Where-Object { -not $_.Success }
if ($failed) {
    Write-Warning "$($failed.Count) target(s) failed. See above."
    exit 1
}
