# osmatrix: install the Visual Studio 2022 Build Tools C++ workload (MSVC + Windows SDK), as on GitHub's
# windows-latest image. Rust's default *-pc-windows-msvc targets and cc/cmake builds link with them; without
# them rustc picks up Git's coreutils link.exe. Run by provision.ps1 at install and by `osmatrix provision`
# for guests set up before this existed. Idempotent: does nothing when the C++ tools are already there.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Log($m) { Write-Output ("[{0}] {1}" -f (Get-Date -Format s), $m) }

$arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'
# Build Tools only show up in vswhere with -products *.
$tools = if ($arm) { 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' } else { 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' }
function Get-VCTools {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere)) { return $null }
  & $vswhere -products * -requires $tools -property installationPath | Select-Object -First 1
}

$have = Get-VCTools
if ($have) { Log "MSVC Build Tools already installed: $have"; exit 0 }

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
Log 'installing MSVC Build Tools and the Windows SDK (several GB, ~10-20 min)'
$p = Start-Process -FilePath $exe -Wait -PassThru -ArgumentList $installArgs
Remove-Item -Recurse -Force -LiteralPath $dir -ErrorAction SilentlyContinue
# 3010: installed, a reboot is pending. The tools work without it.
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Log "MSVC Build Tools: installer exit $($p.ExitCode) (logs: $env:TEMP\dd_*.log)"; exit 1 }
$have = Get-VCTools
if (-not $have) { Log "MSVC Build Tools: installer exit $($p.ExitCode), but vswhere finds no C++ tools"; exit 1 }
Log "MSVC Build Tools installed (exit $($p.ExitCode)): $have"
exit 0
