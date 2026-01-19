# MSV Skill Installation Script
# Installs dependencies and downloads the AppThreat vulnerability database
#
# Usage: .\install.ps1
#
# Requirements:
#   - Python 3.9+ with pip
#   - Bun runtime
#   - ~3GB disk space for database

$ErrorActionPreference = "Stop"

Write-Host "`n=== MSV Skill Installation ===" -ForegroundColor Cyan
Write-Host "Minimum Safe Version Calculator for Windows Software`n"

# Check Python
Write-Host "Checking Python..." -ForegroundColor Yellow
try {
    $pythonVersion = python --version 2>&1
    Write-Host "  Found: $pythonVersion" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Python not found. Please install Python 3.9+" -ForegroundColor Red
    exit 1
}

# Check Bun
Write-Host "Checking Bun..." -ForegroundColor Yellow
try {
    $bunVersion = bun --version 2>&1
    Write-Host "  Found: Bun $bunVersion" -ForegroundColor Green
} catch {
    Write-Host "  ERROR: Bun not found. Please install Bun: https://bun.sh" -ForegroundColor Red
    exit 1
}

# Try to install and download database using best available method
Write-Host "`nDownloading AppThreat vulnerability database..." -ForegroundColor Yellow
Write-Host "  This downloads ~700MB and expands to ~2.5GB" -ForegroundColor DarkGray
Write-Host "  Source: ghcr.io/appthreat/vdbxz-app" -ForegroundColor DarkGray

$vdbDir = "$env:LOCALAPPDATA\vdb\vdb"
$downloadSuccess = $false

# Method 1: Try vdb CLI (requires pip install)
Write-Host "`nMethod 1: Trying vdb CLI..." -ForegroundColor Yellow
try {
    # Check if vdb is already installed
    $vdbExists = Get-Command vdb -ErrorAction SilentlyContinue
    if (-not $vdbExists) {
        Write-Host "  Installing appthreat-vulnerability-db..." -ForegroundColor DarkGray
        pip install appthreat-vulnerability-db[oras] --quiet --upgrade 2>$null
    }
    vdb --download-image
    Write-Host "  Database downloaded via vdb" -ForegroundColor Green
    $downloadSuccess = $true
} catch {
    Write-Host "  vdb method failed, trying alternative..." -ForegroundColor Yellow
}

# Method 2: Try oras CLI
if (-not $downloadSuccess) {
    Write-Host "`nMethod 2: Trying oras CLI..." -ForegroundColor Yellow
    try {
        $orasExists = Get-Command oras -ErrorAction SilentlyContinue
        if (-not $orasExists) {
            Write-Host "  oras not found. Attempting install via winget..." -ForegroundColor DarkGray
            winget install oras --silent 2>$null
        }

        # Create target directory
        if (-not (Test-Path $vdbDir)) {
            New-Item -ItemType Directory -Path $vdbDir -Force | Out-Null
        }

        oras pull ghcr.io/appthreat/vdbxz-app:latest --output $vdbDir
        Write-Host "  Database downloaded via oras" -ForegroundColor Green
        $downloadSuccess = $true
    } catch {
        Write-Host "  oras method failed" -ForegroundColor Yellow
    }
}

# Method 3: Manual instructions
if (-not $downloadSuccess) {
    Write-Host "`n" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  Automatic database download failed" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host @"

Please install manually using one of these methods:

Option A: Install vdb CLI
  pip install appthreat-vulnerability-db[oras]
  vdb --download-image

Option B: Install oras CLI
  winget install oras
  oras pull ghcr.io/appthreat/vdbxz-app:latest --output $vdbDir

Option C: Use pipx (isolated environment)
  pipx install appthreat-vulnerability-db[oras]
  vdb --download-image

Database will be stored at: $vdbDir

"@ -ForegroundColor Yellow
    Write-Host "MSV will work without offline database (uses online APIs only)" -ForegroundColor DarkGray
}

# Verify installation
Write-Host "`nVerifying installation..." -ForegroundColor Yellow
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $scriptPath

try {
    $result = bun run tools/msv.ts db status 2>&1
    if ($result -match "UP TO DATE|Database Size") {
        Write-Host "  Database verification: PASS" -ForegroundColor Green
    } else {
        Write-Host "  Database verification: WARNING - check 'msv db status'" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  Database verification: SKIPPED" -ForegroundColor Yellow
}

Pop-Location

# Summary
Write-Host "`n=== Installation Complete ===" -ForegroundColor Cyan
Write-Host @"

MSV skill is ready to use!

Quick Start:
  cd $scriptPath
  bun run tools/msv.ts chrome        # Query Chrome MSV
  bun run tools/msv.ts db status     # Check database status

The database will auto-update when older than 48 hours.

Documentation: $scriptPath\README.md
"@ -ForegroundColor White
