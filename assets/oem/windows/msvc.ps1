# osmatrix: install the Visual Studio 2022 Build Tools C++ workload (MSVC + Windows SDK), as on GitHub's
# windows-latest image. Rust's default *-pc-windows-msvc targets and cc/cmake builds link with them; without
# them rustc picks up Git's coreutils link.exe. Run by provision.ps1 at install and by `osmatrix provision`
# for guests set up before this existed. Idempotent: does nothing when the C++ tools and a Windows SDK are there.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Log($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format s), $m) }

$arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'
# Build Tools only show up in vswhere with -products *.
$tools = if ($arm) { 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' } else { 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
function Get-VCTools {
  if (-not (Test-Path -LiteralPath $vswhere)) { return $null }
  & $vswhere -products * -requires $tools -property installationPath | Select-Object -First 1
}

# The Windows SDK version that has this architecture's import libraries. vswhere's SDK component ids change
# with every SDK version, so look for kernel32.lib under the registered Windows Kits root instead.
function Get-WindowsSdk {
  $roots = @('HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots') |
    ForEach-Object { (Get-ItemProperty -LiteralPath $_ -Name KitsRoot10 -ErrorAction SilentlyContinue).KitsRoot10 } | Where-Object { $_ }
  $root = @($roots)[0]
  if (-not $root) { $root = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10' }
  $a = if ($arm) { 'arm64' } else { 'x64' }
  Get-ChildItem -LiteralPath (Join-Path $root 'Lib') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "um\$a\kernel32.lib") } |
    Select-Object -First 1 -ExpandProperty Name
}

$have = Get-VCTools
$sdk = Get-WindowsSdk
if ($have -and $sdk) { Log "MSVC Build Tools already installed: $have (Windows SDK $sdk)"; exit 0 }
if ($have) { Log "MSVC C++ tools found at $have, but no Windows SDK; adding the workload's recommended components" }

$dir = Join-Path $env:TEMP 'osmatrix-msvc'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'vs_BuildTools.exe'
Log 'downloading the Visual Studio 2022 Build Tools bootstrapper'
$ok = $false
for ($i = 1; $i -le 5 -and -not $ok; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile $exe; $ok = $true }
  catch { Log "attempt $i failed: $_"; Start-Sleep -Seconds (10 * $i) }
}
if (-not $ok) { Log 'MSVC Build Tools: download failed'; exit 1 }

# Only run what Microsoft signed.
$sig = Get-AuthenticodeSignature -FilePath $exe
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') {
  Log "MSVC Build Tools: refusing to run the bootstrapper (signature $($sig.Status), signer '$($sig.SignerCertificate.Subject)')"
  Remove-Item -Force -LiteralPath $exe -ErrorAction SilentlyContinue
  exit 1
}

# VCTools with its recommended components: the MSVC toolset for this architecture, the Windows SDK and CMake.
$installArgs = @('--quiet', '--wait', '--norestart', '--nocache', '--add', 'Microsoft.VisualStudio.Workload.VCTools', '--includeRecommended')
if ($arm) { $installArgs += @('--add', 'Microsoft.VisualStudio.Component.VC.Tools.ARM64') }
# An existing Build Tools instance (e.g. MSVC picked without the SDK) is modified in place; otherwise this
# installs one, side by side with any other Visual Studio product (whose workloads differ from VCTools).
$bt = if (Test-Path -LiteralPath $vswhere) { & $vswhere -products Microsoft.VisualStudio.Product.BuildTools -property installationPath | Select-Object -First 1 }
# Start-Process joins arguments with spaces and doesn't quote them; the path has spaces.
if ($bt) { $installArgs = @('modify', '--installPath', ('"{0}"' -f $bt)) + $installArgs }
Log $(if ($bt) { "adding the C++ workload and Windows SDK to $bt (several GB, ~10-20 min)" } else { 'installing MSVC Build Tools and the Windows SDK (several GB, ~10-20 min)' })
$p = Start-Process -FilePath $exe -Wait -PassThru -ArgumentList $installArgs
Remove-Item -Recurse -Force -LiteralPath $dir -ErrorAction SilentlyContinue
# 3010: installed, a reboot is pending. The tools work without it.
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Log "MSVC Build Tools: installer exit $($p.ExitCode) (logs: $env:TEMP\dd_*.log)"; exit 1 }
$have = Get-VCTools
$sdk = Get-WindowsSdk
if (-not $have) { Log "MSVC Build Tools: installer exit $($p.ExitCode), but vswhere finds no C++ tools"; exit 1 }
if (-not $sdk) { Log "MSVC Build Tools: installer exit $($p.ExitCode), but no Windows SDK has the import libraries"; exit 1 }
Log "MSVC Build Tools installed (exit $($p.ExitCode)): $have (Windows SDK $sdk)"
exit 0
