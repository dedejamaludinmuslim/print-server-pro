# Print Server Pro

Print Server Pro menghubungkan printer Windows dengan perangkat lain melalui jaringan lokal.

## Instalasi online

Buka Windows PowerShell atau Terminal, lalu jalankan:

```powershell
$u="https://raw.githubusercontent.com/dedejamaludinmuslim/print-server-pro/main/installer/Install-PrintServerPro.ps1"; $p="$env:TEMP\Install-PrintServerPro.ps1"; Invoke-WebRequest $u -UseBasicParsing -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p
```

Installer akan meminta hak Administrator, mengunduh Release stabil terbaru,
memverifikasi SHA-256, memasang dependensi, mengatur firewall TCP 3000 untuk
profil Private/Domain, dan membuat startup otomatis melalui Task Scheduler.

## Repair

```powershell
$u="https://raw.githubusercontent.com/dedejamaludinmuslim/print-server-pro/main/installer/Install-PrintServerPro.ps1"; $p="$env:TEMP\Install-PrintServerPro.ps1"; Invoke-WebRequest $u -UseBasicParsing -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -Mode Repair
```

## Uninstall

```powershell
$u="https://raw.githubusercontent.com/dedejamaludinmuslim/print-server-pro/main/installer/Install-PrintServerPro.ps1"; $p="$env:TEMP\Install-PrintServerPro.ps1"; Invoke-WebRequest $u -UseBasicParsing -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -Mode Uninstall
```

Node.js tidak ikut dihapus karena mungkin digunakan aplikasi lain.

## Aset Release wajib

Setiap Release stabil harus memiliki dua aset dengan nama yang selalu sama:

- `Print_Server_Pro.zip`
- `manifest.json`

Jangan menandai Release aktif sebagai draft atau pre-release karena installer
menggunakan URL `releases/latest/download`.

## Kebutuhan

- Windows 10/11
- Hak Administrator
- Internet saat instalasi atau pembaruan
- WinGet jika Node.js belum terpasang
- Profil jaringan Private/Domain agar akses dari perangkat lain dibuka

Setelah instalasi selesai, proses cetak berjalan melalui jaringan lokal.
