# Aegis emergency restore (Windows). Works without Aegis installed.
# Restores one backup from this drive into a NEW folder; never overwrites existing files.

function Pause-Close { Read-Host "`nPress Enter to close this window" | Out-Null }
function Fail($msg) { Write-Host "`n$msg" -ForegroundColor Red; Pause-Close; exit 1 }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$drive = Split-Path -Parent $here

$zip = Get-ChildItem -Path (Join-Path $here 'restic') -Filter 'restic_*_windows_amd64.zip' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $zip) { Fail 'The restore program for Windows is missing from the drive.' }

$tmp = Join-Path $env:TEMP ('aegis-restore-' + [guid]::NewGuid())
try {
    Expand-Archive -Path $zip.FullName -DestinationPath $tmp -ErrorAction Stop
} catch { Fail "Couldn't unpack the restore program." }
$restic = (Get-ChildItem -Path $tmp -Filter 'restic*.exe' | Select-Object -First 1).FullName

$candidates = @(Join-Path $drive '.aegis\repo')
$candidates += Get-ChildItem -Path (Join-Path $drive '.aegis\instances') -Directory -Force -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'repo' }
$repos = @($candidates | Where-Object { Test-Path (Join-Path $_ 'config') })
if ($repos.Count -eq 0) { Fail 'No Aegis backups were found on this drive.' }

Write-Host "Aegis emergency restore`n"
$secure = Read-Host 'Type your backup passphrase, then press Enter' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:RESTIC_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

try {
    $repo = $null
    foreach ($r in $repos) {
        & $restic -r $r cat config *> $null
        if ($LASTEXITCODE -eq 0) { $repo = $r; break }
    }
    if (-not $repo) { Fail "That passphrase doesn't open any backup on this drive. Check it and try again." }

    Write-Host "`nBackups on this drive (newest at the bottom):"
    & $restic -r $repo snapshots --compact
    if ($LASTEXITCODE -ne 0) { Fail "Couldn't read the list of backups." }

    $snap = Read-Host "`nType the ID of the backup to restore, or just press Enter for the newest"
    if ([string]::IsNullOrWhiteSpace($snap)) { $snap = 'latest' }
    if ($snap -ne 'latest' -and $snap -notmatch '^[0-9a-fA-F]{4,64}$') {
        Fail "That doesn't look like a backup ID (letters a-f and numbers only)."
    }

    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { $desktop = $env:USERPROFILE }
    $target = Join-Path $desktop ('Aegis restore ' + (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'))
    New-Item -ItemType Directory -Path $target -Force | Out-Null

    Write-Host "`nRestoring into: $target"
    & $restic -r $repo restore $snap --target $target
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`nDone. Your files are in: $target" -ForegroundColor Green
        Start-Process explorer.exe $target
        Pause-Close
    } else {
        Fail "The restore did not finish. Files restored so far are in: $target"
    }
} finally {
    $env:RESTIC_PASSWORD = $null
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
