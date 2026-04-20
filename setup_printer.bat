@echo off
title Installer - Print Server Pro V4.5
color 0B

echo ===================================================
echo      INSTALLER OFFLINE PRINT SERVER PRO V4.5
echo ===================================================
echo.

:: 1. Cek ketersediaan Node.js
echo [1/4] Mengecek sistem Node.js...
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
echo [2/4] Mengunduh dan memasang modul aplikasi...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Gagal menginstall modul. Pastikan PC terkoneksi internet.
    pause
    exit /b
)
echo.

:: 3. Install PM2 (Agar server berjalan di latar belakang tanpa jendela CMD hitam)
echo [3/4] Memasang PM2 (Server Manager)...
call npm install -g pm2
echo.

:: 4. Nyalakan Server
echo [4/4] Menyalakan Mesin Server...
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
pause