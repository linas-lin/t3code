#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = if ($env:CT_REPO) { $env:CT_REPO } else { 'linas-lin/t3code' }
$RequestedVersion = $env:CT_VERSION

function Write-Info([string]$Message) {
  Write-Host "[ct-code] $Message"
}

if ([Environment]::Is64BitOperatingSystem -eq $false) {
  throw "This installer supports 64-bit Windows (x64) only."
}

$Headers = @{
  'Accept'     = 'application/vnd.github+json'
  'User-Agent' = 'ct-code-installer'
}

if ($RequestedVersion) {
  $ApiUrl = "https://api.github.com/repos/$Repo/releases/tags/$RequestedVersion"
  Write-Info "Looking up release $RequestedVersion from $Repo..."
  $Releases = @(Invoke-RestMethod -Uri $ApiUrl -Headers $Headers)
} else {
  $ApiUrl = "https://api.github.com/repos/$Repo/releases?per_page=20"
  Write-Info "Looking up latest CT Code release from $Repo..."
  $Releases = @(Invoke-RestMethod -Uri $ApiUrl -Headers $Headers)
}

$SelectedRelease = $null
$SelectedAsset = $null
foreach ($Rel in $Releases) {
  if ($Rel.draft) { continue }
  if (-not $Rel.tag_name -or -not $Rel.tag_name.StartsWith('ct-v')) { continue }
  $Asset = $Rel.assets | Where-Object { $_.name -match '^CT-Code-.*-x64\.exe$' } | Select-Object -First 1
  if ($Asset) {
    $SelectedRelease = $Rel
    $SelectedAsset = $Asset
    break
  }
}

if (-not $SelectedAsset) {
  throw "No Windows x64 installer (CT-Code-*-x64.exe) found in $Repo releases."
}

$TagName = $SelectedRelease.tag_name
$FileName = $SelectedAsset.name
$DownloadUrl = $SelectedAsset.browser_download_url

$WorkDir = Join-Path ([IO.Path]::GetTempPath()) ("ct-code-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$InstallerPath = Join-Path $WorkDir $FileName

try {
  Write-Info "Downloading $FileName ($TagName)..."
  $PreviousProgress = $ProgressPreference
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $InstallerPath -Headers $Headers -UseBasicParsing
  } finally {
    $ProgressPreference = $PreviousProgress
  }

  try {
    Unblock-File -Path $InstallerPath -ErrorAction SilentlyContinue
  } catch {
    # Non-fatal if stream does not exist.
  }

  Write-Info "Launching installer..."
  Write-Info "Note: Because this build is unsigned, if Windows SmartScreen prompts, click 'More info' -> 'Run anyway'."
  $Process = Start-Process -FilePath $InstallerPath -PassThru -Wait
  if ($Process.ExitCode -ne 0) {
    throw "Installer exited with code $($Process.ExitCode)."
  }
  Write-Info "CT Code ($TagName) installation finished."
  Write-Info "If upgrading from an older 'T3 Code (CT)' build, you can uninstall it in Windows Settings -> Installed apps."
} finally {
  if (Test-Path $WorkDir) {
    Remove-Item -Path $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
