@echo off
setlocal
title Installer - Print Server Pro V4.5.3
color 0B

echo ===================================================
echo     INSTALLER OFFLINE PRINT SERVER PRO V4.5.3
echo ===================================================
echo.

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
echo Node.js terdeteksi!
echo.

echo [2/4] Menginstall modul aplikasi...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Gagal menginstall modul. Pastikan PC terkoneksi internet.
    pause
    exit /b
)
echo.

echo [3/4] Memasang PM2...
call npm install -g pm2
echo.

echo [4/4] Menyalakan server...
call pm2 stop print-server >nul 2>&1
call pm2 delete print-server >nul 2>&1
set ALLOWED_ORIGINS=https://printer-upmp.vercel.app
call pm2 start server.js --name "print-server"
call pm2 save

echo.
echo ===================================================
echo  INSTALLASI SUKSES! MODE HOSTED-LOCAL SIAP DIPAKAI
echo ===================================================
echo.
echo Web publik default yang diizinkan:
echo https://printer-upmp.vercel.app
echo.
echo Akses dari perangkat lain tetap mengandalkan jaringan yang masih reachable.
echo Prioritas deteksi: IP terakhir sukses -> auto detect multi-subnet -> manual IP.
echo.
echo Cek IP server lokal Anda:
ipconfig | findstr /i "ipv4"
echo.
pause
endlocal
