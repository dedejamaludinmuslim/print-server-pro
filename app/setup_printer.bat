@echo off
title Installer - Print Server Pro V4.6.2
color 0B

:: Hak administrator diperlukan hanya untuk membuat aturan firewall yang terbatas.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Meminta hak Administrator untuk konfigurasi firewall...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -WorkingDirectory '%~dp0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

echo ===================================================
echo      INSTALLER PRINT SERVER PRO V4.6.2
echo ===================================================
echo.

:: 1. Cek ketersediaan Node.js
echo [1/5] Mengecek sistem Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR FATAL] Node.js belum terinstall di PC ini!
    echo Silakan download dan install Node.js versi LTS dari https://nodejs.org/
    echo Setelah Node.js terinstall, jalankan kembali file ini.
    echo.
    pause
    exit /b
)
echo Node.js terdeteksi! Melanjutkan proses...
echo.

:: 2. Install dependensi (node_modules)
echo [2/5] Mengunduh dan memasang modul aplikasi...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Gagal menginstall modul. Pastikan PC terkoneksi internet.
    pause
    exit /b
)
echo.

:: 3. Install PM2 (Agar server berjalan di latar belakang tanpa jendela CMD hitam)
echo [3/5] Memasang PM2 (Server Manager)...
call npm install -g pm2
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] PM2 gagal dipasang. Periksa koneksi internet dan izin Administrator.
    pause
    exit /b
)
echo.

:: 4. Firewall: hanya TCP 3000 pada profil Private dan Domain.
echo [4/5] Mengatur Windows Firewall untuk jaringan Private/Domain...
netsh advfirewall firewall delete rule name="Print Server Pro TCP 3000" >nul 2>&1
netsh advfirewall firewall add rule name="Print Server Pro TCP 3000" dir=in action=allow protocol=TCP localport=3000 profile=private,domain enable=yes >nul
if %errorlevel% neq 0 (
    echo [PERINGATAN] Aturan firewall tidak berhasil dibuat. Server tetap akan dijalankan.
) else (
    echo Aturan firewall Private/Domain berhasil dibuat.
)
netsh advfirewall show currentprofile | findstr /i "Public" >nul 2>&1
if %errorlevel% equ 0 (
    echo [PERINGATAN] Profil jaringan saat ini mungkin Public.
    echo Ubah sendiri ke Private hanya jika LAN ini terpercaya. Installer tidak mengubah profil otomatis.
)
echo.

:: 5. Nyalakan Server
echo [5/5] Menyalakan Mesin Server...
:: Matikan dulu jika sebelumnya sudah ada yang menyala
call pm2 stop print-server >nul 2>&1
call pm2 delete print-server >nul 2>&1

:: Nyalakan yang baru
call pm2 start server.js --name "print-server"
call pm2 save

echo.
echo ===================================================
echo   INSTALLASI SUKSES! MESIN CETAK AKTIF!
echo ===================================================
echo.
echo Aplikasi Print Server Anda sudah menyala di latar belakang.
echo Anda bisa menutup jendela ini sekarang.
echo.
echo Untuk mengaksesnya dari HP atau Laptop lain, buka browser dan ketik:
echo http://localhost:3000  (Jika dibuka dari PC ini)
echo.
echo Jika butuh cek IP otomatis jaringan ini:
ipconfig | findstr /i "ipv4"
echo.
echo Buka http://IP-PC-SERVER:3000 dari perangkat lain.
echo Halaman server menyediakan QR koneksi dan alamat hostname.local bila mDNS tersedia.
echo Jika PC kabel tetap tidak terlihat, periksa apakah LAN dan Wi-Fi berada di VLAN/subnet berbeda.
echo.
pause
