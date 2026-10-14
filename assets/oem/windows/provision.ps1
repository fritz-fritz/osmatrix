# osmatrix Windows guest provisioning. sshd is enabled LAST, so "ssh reachable" means "provisioned".
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tmp = 'C:\OEM\downloads'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Log($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format s), $m) }

function Retry([scriptblock]$Block, [int]$Times = 5) {
  for ($i = 1; $i -le $Times; $i++) {
    try { & $Block; return $true } catch { Log "attempt $i failed: $_"; Start-Sleep -Seconds (10 * $i) }
  }
  return $false
}

function Get-LatestAsset([string]$Repo, [string]$Pattern) {
  $rel = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'osmatrix' } "https://api.github.com/repos/$Repo/releases/latest"
  ($rel.assets | Where-Object { $_.name -match $Pattern } | Select-Object -First 1).browser_download_url
}

function Download([string]$Url, [string]$Name) {
  $out = Join-Path $tmp $Name
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $out
  return $out
}

Log 'waiting for network'
Retry { Invoke-WebRequest -UseBasicParsing -Uri 'https://api.github.com' -TimeoutSec 15 | Out-Null } 30 | Out-Null

# --- OS tuning for a CI box ---
Log 'tuning OS'
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /hibernate off
New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -PropertyType DWord -Force | Out-Null
$wu = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
New-Item -Path $wu -Force | Out-Null
New-ItemProperty -Path $wu -Name NoAutoUpdate -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $wu -Name NoAutoRebootWithLoggedOnUsers -Value 1 -PropertyType DWord -Force | Out-Null
try { Add-MpPreference -ExclusionPath "$env:SystemDrive\Users" -ErrorAction Stop } catch { Log "defender exclusion skipped: $_" }

# --- toolchain (what a GitHub windows runner step most often assumes) ---
# Native builds on Windows on ARM (x64 ones would only run emulated).
$arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'
Log "architecture: $env:PROCESSOR_ARCHITECTURE"
Log 'installing PowerShell 7'
Retry {
  $u = Get-LatestAsset 'PowerShell/PowerShell' $(if ($arm) { '^PowerShell-[\d.]+-win-arm64\.msi$' } else { '^PowerShell-[\d.]+-win-x64\.msi$' })
  $f = Download $u 'pwsh.msi'
  $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$f`" /qn ADD_PATH=1 ENABLE_PSREMOTING=0 REGISTER_MANIFEST=1"
  if ($p.ExitCode -ne 0) { throw "msiexec exit $($p.ExitCode)" }
} | Out-Null

Log 'installing Git'
Retry {
  $u = Get-LatestAsset 'git-for-windows/git' $(if ($arm) { '^Git-[\d.]+-arm64\.exe$' } else { '^Git-[\d.]+-64-bit\.exe$' })
  $f = Download $u 'git.exe'
  # As GitHub's image (runner-images Install-Git.ps1): symlinks on, line endings left at the installer's
  # default (core.autocrlf=true), so checkouts in the guest match actions/checkout.
  $p = Start-Process $f -Wait -PassThru -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES /COMPONENTS="gitlfs,assoc,autoupdate" /o:PathOption=CmdTools /o:EnableSymlinks=Enabled'
  if ($p.ExitCode -ne 0) { throw "git installer exit $($p.ExitCode)" }
} | Out-Null

Log 'installing Node.js LTS'
Retry {
  $idx = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
  $v = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version
  $f = Download "https://nodejs.org/dist/$v/node-$v-$(if ($arm) { 'arm64' } else { 'x64' }).msi" 'node.msi'
  $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$f`" /qn"
  if ($p.ExitCode -ne 0) { throw "msiexec exit $($p.ExitCode)" }
} | Out-Null

Log 'installing act'
Retry {
  $u = Get-LatestAsset 'nektos/act' $(if ($arm) { '^act_Windows_arm64\.zip$' } else { '^act_Windows_x86_64\.zip$' })
  $f = Download $u 'act.zip'
  $dest = 'C:\Program Files\act'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Expand-Archive -Force -Path $f -DestinationPath $dest
  $mp = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if ($mp -notlike "*$dest*") { [Environment]::SetEnvironmentVariable('Path', "$mp;$dest", 'Machine') }
} | Out-Null

# Python via the official installer (setup-python also works on self-hosted, but a default python helps scripts).
Log 'installing Python'
Retry {
  $html = Invoke-WebRequest -UseBasicParsing 'https://www.python.org/downloads/windows/'
  $m = [regex]::Match($html.Content, 'python-(3\.\d+\.\d+)-amd64\.exe')
  $v = $m.Groups[1].Value
  $f = Download "https://www.python.org/ftp/python/$v/python-$v-$(if ($arm) { 'arm64' } else { 'amd64' }).exe" 'python.exe'
  $p = Start-Process $f -Wait -PassThru -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0'
  if ($p.ExitCode -ne 0) { throw "python installer exit $($p.ExitCode)" }
} | Out-Null

& 'C:\Program Files\Git\cmd\git.exe' config --system core.longpaths true
& 'C:\Program Files\Git\cmd\git.exe' config --system core.symlinks true

# Developer Mode lets non-elevated processes create symlinks, which Git needs for core.symlinks
# (runner-images Configure-DeveloperMode.ps1 does the same on GitHub's Windows image).
$devMode = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
if (-not (Test-Path $devMode)) { New-Item -Path $devMode -Force | Out-Null }
New-ItemProperty -Path $devMode -Name AllowDevelopmentWithoutDevLicense -Value 1 -PropertyType DWord -Force | Out-Null

# --- sshd (last) ---
Log 'enabling OpenSSH server'
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  Retry { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction Stop | Out-Null } | Out-Null
}
$sshDir = 'C:\ProgramData\ssh'
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
Copy-Item -Force 'C:\OEM\authorized_keys' "$sshDir\administrators_authorized_keys"
icacls.exe "$sshDir\administrators_authorized_keys" /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
$shell = if (Test-Path $pwsh) { $pwsh } else { 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' }
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $shell -PropertyType String -Force | Out-Null
if (-not (Get-NetFirewallRule -Name 'osmatrix-sshd' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'osmatrix-sshd' -DisplayName 'osmatrix sshd' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
}
Set-Service sshd -StartupType Automatic
Start-Service sshd
Set-Content -Path 'C:\OEM\provisioned.txt' -Value (Get-Date -Format s)
Log 'done'
