[CmdletBinding()]
param(
    [ValidateSet('Install', 'Repair', 'Uninstall')]
    [string]$Mode = 'Install'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepositoryOwner = 'dedejamaludinmuslim'
$RepositoryName = 'print-server-pro'
$InstallerRevision = '4.5.35-H2'
$ManifestUrl = "https://github.com/$RepositoryOwner/$RepositoryName/releases/latest/download/manifest.json"
$InstallRoot = Join-Path $env:ProgramData 'PrintServerPro'
$AppDirectory = Join-Path $InstallRoot 'app'
$BackupDirectory = Join-Path $InstallRoot 'backup'
$LogsDirectory = Join-Path $InstallRoot 'logs'
$LauncherPath = Join-Path $InstallRoot 'Start-PrintServerPro.cmd'
$HiddenLauncherPath = Join-Path $InstallRoot 'Start-PrintServerPro-Hidden.vbs'
$TaskName = 'Print Server Pro'
$FirewallRuleName = 'PrintServerPro-TCP-3000'
$FirewallDisplayName = 'Print Server Pro TCP 3000'
$Port = 3000
$WorkDirectory = $null
$TranscriptStarted = $false
$HadExistingApp = $false
$AppMutationStarted = $false
$ExistingTaskStopped = $false

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machinePath, $userPath) -join ';'
}

function Get-NodeCommand {
    return Get-Command node.exe -ErrorAction SilentlyContinue
}

function Ensure-NodeJs {
    param([int]$MinimumMajor)

    $nodeCommand = Get-NodeCommand
    if ($nodeCommand) {
        $installedVersion = (& $nodeCommand.Source --version).Trim()
        $installedMajor = [int](($installedVersion -replace '^v', '').Split('.')[0])
        if ($installedMajor -ge $MinimumMajor) {
            Write-Success "Node.js ditemukan: $installedVersion"
            return $nodeCommand.Source
        }
        Write-Host "Node.js $installedVersion terlalu lama; minimum v$MinimumMajor." -ForegroundColor Yellow
    }

    Write-Step 'Memasang atau memperbarui Node.js LTS melalui WinGet'
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'WinGet tidak tersedia. Pasang App Installer/Node.js LTS, lalu jalankan installer kembali.'
    }

    $wingetOperation = if ($nodeCommand) { 'upgrade' } else { 'install' }
    & $winget.Source $wingetOperation --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "Pemasangan/pembaruan Node.js melalui WinGet gagal dengan kode $LASTEXITCODE."
    }

    Refresh-ProcessPath
    $nodeCommand = Get-NodeCommand
    if (-not $nodeCommand) {
        $defaultNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
        if (Test-Path -LiteralPath $defaultNode) {
            return $defaultNode
        }
        throw 'Node.js selesai dipasang tetapi node.exe belum ditemukan. Restart Windows lalu jalankan installer kembali.'
    }
    $finalVersion = (& $nodeCommand.Source --version).Trim()
    $finalMajor = [int](($finalVersion -replace '^v', '').Split('.')[0])
    if ($finalMajor -lt $MinimumMajor) {
        throw "Node.js $finalVersion masih di bawah versi minimum v$MinimumMajor."
    }
    Write-Success "Node.js terpasang: $finalVersion"
    return $nodeCommand.Source
}

function Stop-ExistingServer {
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        $script:ExistingTaskStopped = $true
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    $pm2 = Get-Command pm2.cmd -ErrorAction SilentlyContinue
    if ($pm2) {
        try {
            # PM2 hanya dipakai versi lama. Exit code nonzero saat proses tidak
            # ditemukan adalah kondisi normal dan tidak boleh menggagalkan installer.
            $pm2Process = Start-Process -FilePath $pm2.Source -ArgumentList @('delete', 'print-server') -WindowStyle Hidden -Wait -PassThru
            if ($pm2Process.ExitCode -eq 0) {
                Write-Success 'Proses PM2 lama dihentikan'
            } else {
                Write-Host '[INFO] Proses PM2 lama tidak aktif; dilewati.' -ForegroundColor DarkGray
            }
        } catch {
            Write-Warning "Pembersihan PM2 lama dilewati: $($_.Exception.Message)"
        }
    }

    for ($attempt = 1; $attempt -le 10; $attempt++) {
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $listener) {
            return
        }
        Start-Sleep -Seconds 1
    }

    throw "Port $Port masih dipakai proses PID $($listener.OwningProcess). Hentikan proses tersebut lalu jalankan installer kembali."
}

function Remove-ManagedComponents {
    Write-Step 'Menghentikan komponen Print Server Pro'
    Stop-ExistingServer
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue
}

function Invoke-Uninstall {
    Remove-ManagedComponents
    if (Test-Path -LiteralPath $InstallRoot) {
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    }
    Write-Success 'Print Server Pro telah dihapus. Node.js tidak dihapus karena mungkin dipakai aplikasi lain.'
}

function Get-ValidatedManifest {
    param([string]$Destination)

    Invoke-WebRequest -Uri $ManifestUrl -UseBasicParsing -OutFile $Destination
    $manifest = Get-Content -LiteralPath $Destination -Raw | ConvertFrom-Json
    $required = @('name', 'version', 'downloadUrl', 'sha256', 'minimumNodeMajor')
    foreach ($field in $required) {
        if (-not ($manifest.PSObject.Properties.Name -contains $field) -or [string]::IsNullOrWhiteSpace([string]$manifest.$field)) {
            throw "Manifest tidak valid: field '$field' tidak tersedia."
        }
    }
    if ([string]$manifest.sha256 -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'Manifest tidak valid: SHA-256 harus terdiri dari 64 karakter heksadesimal.'
    }
    $downloadUri = [Uri][string]$manifest.downloadUrl
    if ($downloadUri.Scheme -ne 'https' -or $downloadUri.Host -ne 'github.com') {
        throw 'Manifest ditolak: paket harus diunduh melalui HTTPS dari github.com.'
    }
    return $manifest
}

function Register-PrintServerTask {
    param([string]$NodeExecutable)

    $serverLog = Join-Path $LogsDirectory 'server.log'
    $launcher = @"
@echo off
cd /d "$AppDirectory"
"$NodeExecutable" server.js >> "$serverLog" 2>&1
"@
    Set-Content -LiteralPath $LauncherPath -Value $launcher -Encoding ASCII

    # WScript menjalankan launcher tanpa jendela terminal. Parameter True membuat
    # Task Scheduler tetap memantau proses dan dapat memulai ulang jika server gagal.
    $escapedLauncherPath = $LauncherPath.Replace('"', '""')
    $hiddenLauncher = @"
Set Shell = CreateObject("WScript.Shell")
Launcher = "$escapedLauncherPath"
ExitCode = Shell.Run(Chr(34) & Launcher & Chr(34), 0, True)
WScript.Quit ExitCode
"@
    Set-Content -LiteralPath $HiddenLauncherPath -Value $hiddenLauncher -Encoding ASCII

    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $wscriptExecutable = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $taskArgument = '"{0}"' -f $HiddenLauncherPath
    $action = New-ScheduledTaskAction -Execute $wscriptExecutable -Argument $taskArgument -WorkingDirectory $InstallRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Menjalankan Print Server Pro tersembunyi saat pengguna pemasang login.' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
}

function Show-NetworkProfileWarning {
    $publicProfiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue |
        Where-Object { $_.NetworkCategory -eq 'Public' })

    if ($publicProfiles.Count -gt 0) {
        $interfaces = ($publicProfiles | Select-Object -ExpandProperty InterfaceAlias -Unique) -join ', '
        Write-Warning "Profil jaringan Public terdeteksi: $interfaces. Firewall installer hanya membuka port $Port pada Private/Domain. Jika ini jaringan kantor yang tepercaya, ubah profilnya ke Private agar perangkat lain dapat mengakses server."
    }
}

function Wait-ForServer {
    $pingUrl = "http://127.0.0.1:$Port/ping"
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        try {
            $response = Invoke-RestMethod -Uri $pingUrl -Method Get -TimeoutSec 2
            if ($response.status -eq 'PrintServerActive') {
                return $response
            }
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    throw "Server tidak merespons $pingUrl setelah 20 detik. Periksa $LogsDirectory."
}

function Show-ConnectionInformation {
    param([object]$PingResponse)

    Write-Host "`n======================================================" -ForegroundColor Green
    Write-Host " PRINT SERVER PRO $($PingResponse.version) SIAP DIGUNAKAN" -ForegroundColor Green
    Write-Host "======================================================" -ForegroundColor Green
    Write-Host "PC ini : http://localhost:$Port/?server=localhost"

    $addresses = Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress -Unique
    foreach ($address in $addresses) {
        Write-Host "Jaringan: http://$address`:$Port/?server=$address"
    }

    Write-Host "`nTask startup : $TaskName"
    Write-Host "Folder       : $InstallRoot"
    Write-Host "Log server   : $(Join-Path $LogsDirectory 'server.log')"
    Write-Host 'Firewall     : TCP 3000, profil Private/Domain'
    Write-Host "======================================================`n"
}

if (-not (Test-Administrator)) {
    Write-Host 'Meminta hak Administrator...' -ForegroundColor Yellow
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Mode', $Mode)
    Start-Process -FilePath $powershellExe -ArgumentList $arguments -Verb RunAs
    exit 0
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Path $InstallRoot, $LogsDirectory -Force | Out-Null
    $transcriptDirectory = if ($Mode -eq 'Uninstall') { $env:TEMP } else { $LogsDirectory }
    $transcriptPath = Join-Path $transcriptDirectory ("PrintServerPro-installer-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
    try {
        Start-Transcript -LiteralPath $transcriptPath -Force | Out-Null
        $TranscriptStarted = $true
    } catch {
        Write-Warning 'Log transcript tidak dapat dimulai; instalasi tetap dilanjutkan.'
    }

    if ($Mode -eq 'Uninstall') {
        Invoke-Uninstall
        exit 0
    }

    Write-Host "Print Server Pro Online Installer $InstallerRevision" -ForegroundColor White
    Write-Host "Repository: https://github.com/$RepositoryOwner/$RepositoryName"
    Write-Host "Mode: $Mode"

    $WorkDirectory = Join-Path $env:TEMP ("PrintServerPro-{0}" -f [Guid]::NewGuid().ToString('N'))
    $extractDirectory = Join-Path $WorkDirectory 'extract'
    $manifestPath = Join-Path $WorkDirectory 'manifest.json'
    $packagePath = Join-Path $WorkDirectory 'Print_Server_Pro.zip'
    New-Item -ItemType Directory -Path $WorkDirectory, $extractDirectory -Force | Out-Null

    Write-Step 'Membaca versi stabil terbaru dari GitHub Release'
    $manifest = Get-ValidatedManifest -Destination $manifestPath
    Write-Success "Versi tersedia: $($manifest.version)"

    Write-Step 'Mengunduh paket Print Server Pro'
    Invoke-WebRequest -Uri ([string]$manifest.downloadUrl) -UseBasicParsing -OutFile $packagePath
    $actualHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = ([string]$manifest.sha256).ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "Verifikasi SHA-256 gagal. Diharapkan $expectedHash, diperoleh $actualHash."
    }
    Write-Success 'Checksum paket valid'

    Expand-Archive -LiteralPath $packagePath -DestinationPath $extractDirectory -Force
    $sourceApp = Join-Path $extractDirectory 'PrintServerPro'
    if (-not (Test-Path -LiteralPath (Join-Path $sourceApp 'package.json'))) {
        throw 'Struktur paket tidak valid: PrintServerPro\package.json tidak ditemukan.'
    }

    $nodeExecutable = Ensure-NodeJs -MinimumMajor ([int]$manifest.minimumNodeMajor)
    $npmCommand = Join-Path (Split-Path -Parent $nodeExecutable) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npmCommand)) {
        throw "npm.cmd tidak ditemukan di $npmCommand."
    }

    Write-Step 'Menyiapkan dependensi aplikasi'
    Push-Location $sourceApp
    try {
        & $npmCommand ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci gagal dengan kode $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    Write-Step 'Menghentikan versi Print Server Pro sebelumnya'
    Stop-ExistingServer

    $AppMutationStarted = $true
    if (Test-Path -LiteralPath $BackupDirectory) {
        Remove-Item -LiteralPath $BackupDirectory -Recurse -Force
    }
    if (Test-Path -LiteralPath $AppDirectory) {
        Move-Item -LiteralPath $AppDirectory -Destination $BackupDirectory
        $HadExistingApp = $true
    }

    Write-Step "Memasang Print Server Pro $($manifest.version)"
    Copy-Item -LiteralPath $sourceApp -Destination $AppDirectory -Recurse -Force

    Write-Step 'Mengatur Windows Firewall untuk Private/Domain'
    Remove-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue
    New-NetFirewallRule -Name $FirewallRuleName -DisplayName $FirewallDisplayName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private,Domain -Description 'Akses Print Server Pro dari jaringan terpercaya.' | Out-Null
    Show-NetworkProfileWarning

    Write-Step 'Mendaftarkan startup otomatis untuk pengguna pemasang'
    Register-PrintServerTask -NodeExecutable $nodeExecutable

    Write-Step 'Menjalankan smoke test server'
    $pingResponse = Wait-ForServer
    if ([string]$pingResponse.version -ne [string]$manifest.version) {
        throw "Versi server $($pingResponse.version) tidak sama dengan manifest $($manifest.version)."
    }

    Write-Success 'Instalasi dan smoke test berhasil'
    Show-ConnectionInformation -PingResponse $pingResponse
    Start-Process "http://localhost:$Port/?server=localhost"
}
catch {
    Write-Host "`n[INSTALLER GAGAL] $($_.Exception.Message)" -ForegroundColor Red
    try {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($AppMutationStarted -and $HadExistingApp -and (Test-Path -LiteralPath $BackupDirectory)) {
            if (Test-Path -LiteralPath $AppDirectory) {
                Remove-Item -LiteralPath $AppDirectory -Recurse -Force
            }
            Move-Item -LiteralPath $BackupDirectory -Destination $AppDirectory
            Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            Write-Host '[ROLLBACK] Versi aplikasi sebelumnya telah dipulihkan.' -ForegroundColor Yellow
        } elseif ($AppMutationStarted -and -not $HadExistingApp) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
            Remove-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $AppDirectory) {
                Remove-Item -LiteralPath $AppDirectory -Recurse -Force
            }
        } elseif (-not $AppMutationStarted -and $ExistingTaskStopped) {
            $previousTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if ($previousTask) {
                Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
                Write-Host '[ROLLBACK] Task server sebelumnya dinyalakan kembali.' -ForegroundColor Yellow
            }
        }
    } catch {
        Write-Warning "Rollback tidak lengkap: $($_.Exception.Message)"
    }
    Write-Host "Log installer: $LogsDirectory" -ForegroundColor Yellow
    exit 1
}
finally {
    if ($WorkDirectory -and (Test-Path -LiteralPath $WorkDirectory)) {
        Remove-Item -LiteralPath $WorkDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($TranscriptStarted) {
        try { Stop-Transcript | Out-Null } catch { }
    }
}
