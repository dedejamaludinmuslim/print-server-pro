# Print Server Pro

Print Server Pro menghubungkan printer Windows dengan perangkat lain melalui jaringan lokal.

Installer saat ini: **v4.5.35-H2**. Hotfix ini menjalankan server secara
tersembunyi melalui Task Scheduler dan WScript. Tidak ada terminal Node.js yang
perlu dibiarkan terbuka, dan menutup PowerShell/Terminal tidak menghentikan server.
H2 juga memperbaiki pemasangan pada PC yang memiliki perintah PM2 tetapi tidak
memiliki proses lama bernama `print-server`.

## Instalasi online

Buka Windows PowerShell atau Terminal, lalu jalankan:

```powershell
$u="https://raw.githubusercontent.com/dedejamaludinmuslim/print-server-pro/main/installer/Install-PrintServerPro.ps1"; $p="$env:TEMP\Install-PrintServerPro.ps1"; Invoke-WebRequest $u -UseBasicParsing -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p
```

Installer akan meminta hak Administrator, mengunduh Release stabil terbaru,
memverifikasi SHA-256, memasang dependensi, mengatur firewall TCP 3000 untuk
profil Private/Domain, dan membuat startup otomatis melalui Task Scheduler.
Task berjalan memakai akun pengguna yang memasang aplikasi agar printer Windows,
termasuk printer USB yang tersedia pada sesi pengguna tersebut, tetap dapat dibaca.

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

Jika jaringan Windows masih berprofil **Public**, installer menampilkan peringatan
dan tidak mengubahnya secara otomatis. Pada jaringan kantor yang benar-benar
tepercaya, ubah profil ke Private agar port 3000 dapat diakses perangkat lain.

Setelah instalasi selesai, proses cetak berjalan melalui jaringan lokal.
Jangan hapus folder `C:\ProgramData\PrintServerPro` karena folder tersebut adalah
lokasi aplikasi aktif, launcher startup, dan log server. Folder proyek lama di
lokasi lain tidak lagi diperlukan setelah instalasi berhasil.
