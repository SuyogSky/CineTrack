$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$zipName = "CineTrack-Final-Backup-Decryption-Remediated.zip"
$zipPath = Join-Path $projectRoot $zipName
$stagingDir = Join-Path $projectRoot "staging_archive"
$testExtractDir = Join-Path $projectRoot "test_extract_verify"

Write-Host "🚀 Starting standards-compliant archive packager for CineTrack..."

# 1. Clean previous artifacts
if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
}
if (Test-Path $stagingDir) {
    Remove-Item -Recurse -Force $stagingDir
}
if (Test-Path $testExtractDir) {
    Remove-Item -Recurse -Force $testExtractDir
}
New-Item -ItemType Directory -Path $stagingDir | Out-Null

# 2. Excluded directory and file patterns
$excludedDirs = @(
    '.git',
    'node_modules',
    'dist',
    'build',
    'coverage',
    'test-results',
    'playwright-report',
    'staging_archive',
    'test_extract_verify',
    '.gemini',
    'backups'
)

$prohibitedExtensions = @(
    '.pem', '.key', '.p12', '.pfx', '.dump', '.bak', '.backup'
)

# 3. Copy files to staging
$items = Get-ChildItem -Path $projectRoot -Recurse -File

$stagedCount = 0
foreach ($item in $items) {
    $relPath = $item.FullName.Substring($projectRoot.Length + 1)
    $parts = $relPath.Split([System.IO.Path]::DirectorySeparatorChar)

    # Check if any parent dir is in excludedDirs
    $skip = $false
    foreach ($part in $parts) {
        if ($excludedDirs -contains $part) {
            $skip = $true
            break
        }
    }
    if ($skip) { continue }

    $fileName = $item.Name

    # Exclude any zip file
    if ($fileName.EndsWith(".zip")) { continue }

    # Exclude OS metadata
    if ($fileName -eq ".DS_Store" -or $fileName -eq "Thumbs.db") { continue }

    # Strict .env exclusion: only allow .env.example
    if ($fileName.StartsWith(".env") -and $fileName -ne ".env.example") {
        continue
    }

    # Prohibited credential / backup extensions
    $ext = [System.IO.Path]::GetExtension($fileName).ToLower()
    if ($prohibitedExtensions -contains $ext) {
        continue
    }

    $destPath = Join-Path $stagingDir $relPath
    $destFolder = Split-Path -Parent $destPath
    if (-not (Test-Path $destFolder)) {
        New-Item -ItemType Directory -Path $destFolder -Force | Out-Null
    }

    Copy-Item -Path $item.FullName -Destination $destPath -Force
    $stagedCount++
}

Write-Host "✅ Staged $stagedCount files into $stagingDir"

# 4. Create ZIP using .NET ZipArchive with EXPLICIT FORWARD SLASHES
Write-Host "📦 Archiving staging folder into $zipName with strict forward-slash entries..."
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipArchive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
$stagedFiles = Get-ChildItem -Path $stagingDir -Recurse -File

foreach ($file in $stagedFiles) {
    $rawRel = $file.FullName.Substring($stagingDir.Length + 1)
    # Strictly enforce POSIX standard forward slashes in ZIP entry name
    $entryName = $rawRel.Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zipArchive,
        $file.FullName,
        $entryName,
        [System.IO.Compression.CompressionLevel]::Optimal
    ) | Out-Null
}
$zipArchive.Dispose()

# 5. Remove staging directory
Write-Host "🧹 Cleaning staging folder..."
Remove-Item -Recurse -Force $stagingDir

# 6. Verify ZIP RAW ENTRIES (Rejecting Backslashes, Traversal, Leaks)
Write-Host "🔍 Verifying raw archive entry paths and security compliance..."
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
$total = $zip.Entries.Count
$prohibited = @()
$requiredFound = @{
    'server/src/app.ts' = $false
    'server/prisma/schema.prisma' = $false
    'client/src/App.tsx' = $false
    'client/src/components/movies/MovieModal.tsx' = $false
    'client/src/hooks/useToggleMovieStatus.ts' = $false
    'playwright.config.ts' = $false
    'README.md' = $false
    '.github/workflows/ci.yml' = $false
    'server/.env.example' = $false
    'client/.env.example' = $false
    'docs/PRODUCTION_DEPLOYMENT_GUIDE.md' = $false
    'docs/DATABASE_BACKUP_AND_RECOVERY.md' = $false
    'docs/DATA_INTEGRITY_AND_MIGRATION.md' = $false
    'docs/TESTING.md' = $false
    'docs/SECURITY.md' = $false
    'server/scripts/schema_manifest.ts' = $false
    'server/scripts/migration_preflight.ts' = $false
    'server/scripts/test_e2e_recovery.ts' = $false
    'server/tsconfig.scripts.json' = $false
    'server/src/utils/backup_crypto.ts' = $false
    'server/scripts/backup_production.ts' = $false
    'server/tests/backup-crypto.test.ts' = $false
    'server/tests/backup-production.test.ts' = $false
    'server/tests/backup-restore.test.ts' = $false
    'server/tests/backup-restore-structural.test.ts' = $false
    'server/tests/backup-snapshot-consistency.test.ts' = $false
    'server/tests/migration-preflight-states.test.ts' = $false
    'server/tests/seed-safety.test.ts' = $false
    'server/tests/concurrency.test.ts' = $false
    'deployment/systemd/cinetrack-backup.service' = $false
    'deployment/systemd/cinetrack-backup.timer' = $false
    'server/prisma/migrations/migration_lock.toml' = $false
    'server/prisma/migrations/20261125155738_init/migration.sql' = $false
    'server/prisma/migrations/20261125170000_add_watch_status_check_constraint/migration.sql' = $false
    'server/prisma/migrations/20261125180000_restore_integrity_indexes_and_constraints/migration.sql' = $false
}

$disallowedRootFiles = @(
    'app.ts', 'MovieModal.tsx', 'useToggleMovieStatus.ts',
    'schema.prisma', 'auth.service.ts', 'collection.service.ts'
)

foreach ($entry in $zip.Entries) {
    $rawName = $entry.FullName

    # Rule 3.6: Reject any archive containing backslashes
    if ($rawName.Contains("\")) {
        $prohibited += "BACKSLASH_PATH_DETECTED: $rawName"
    }

    # Rule 3: Reject absolute paths or traversal
    if ($rawName.StartsWith("/") -or $rawName -match "^[A-Za-z]:") {
        $prohibited += "ABSOLUTE_PATH_DETECTED: $rawName"
    }
    if ($rawName -match "\.\./") {
        $prohibited += "PATH_TRAVERSAL_DETECTED: $rawName"
    }

    $base = [System.IO.Path]::GetFileName($rawName)

    # Check prohibited env leaks
    if ($base -like ".env*" -and $base -ne ".env.example") {
        $prohibited += "ENV_SECRET_LEAK: $rawName"
    }

    # Check prohibited node_modules / .git
    if ($rawName -match '^node_modules/' -or $rawName -match '^\.git/') {
        $prohibited += "REPO_JUNK: $rawName"
    }

    # Check nested zip
    if ($rawName.EndsWith('.zip')) {
        $prohibited += "NESTED_ZIP: $rawName"
    }

    # Check prohibited key / dump extensions
    $ext = [System.IO.Path]::GetExtension($base).ToLower()
    if ($prohibitedExtensions -contains $ext) {
        $prohibited += "UNSAFE_EXTENSION: $rawName"
    }

    # Check flattened misplaced root files
    if ($disallowedRootFiles -contains $rawName) {
        $prohibited += "FLATTENED_ROOT_FILE: $rawName"
    }

    if ($requiredFound.ContainsKey($rawName)) {
        $requiredFound[$rawName] = $true
    }
}
$zip.Dispose()

Write-Host "📊 Total archive entries inspected: $total"

$missing = @()
foreach ($key in $requiredFound.Keys) {
    if (-not $requiredFound[$key]) {
        $missing += $key
    }
}

if ($missing.Count -gt 0) {
    Write-Error "CRITICAL: Missing required files in archive: $($missing -join ', ')"
    exit 1
}

if ($prohibited.Count -gt 0) {
    Write-Error "CRITICAL: Prohibited entries found in archive: $($prohibited -join '; ')"
    exit 1
}

# 7. Test Extraction into separate clean directory
Write-Host "📦 Testing ZIP extraction into isolated folder: $testExtractDir..."
[System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $testExtractDir)

# Verify extracted critical paths
$testFiles = @(
    (Join-Path $testExtractDir "server/src/app.ts"),
    (Join-Path $testExtractDir "client/src/App.tsx"),
    (Join-Path $testExtractDir "server/prisma/schema.prisma"),
    (Join-Path $testExtractDir ".github/workflows/ci.yml")
)

foreach ($tf in $testFiles) {
    if (-not (Test-Path $tf)) {
        Write-Error "CRITICAL: Extraction failed to produce expected file: $tf"
        exit 1
    }
}

Write-Host "🧹 Cleaning extraction test folder..."
Remove-Item -Recurse -Force $testExtractDir

Write-Host "🎉 SUCCESS! Archive $zipName verified: 100% forward slashes, 0 backslashes, 0 leaks, 0 nested zips, extracted and verified cleanly."
