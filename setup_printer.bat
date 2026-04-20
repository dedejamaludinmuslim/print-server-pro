@echo off
setlocal ENABLEDELAYEDEXPANSION
title Installer - Print Server Pro v4.6
color 0B

cd /d "%~dp0"

set "APP_NAME=print-server"
set "APP_TITLE=Print Server Pro v4.6"


echo ===================================================
echo      INSTALLER OFFLINE %APP_TITLE%
echo ===================================================
echo.

:: 1. Cek ketersediaan Node.js
echo [1/6] Mengecek sistem Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [ERROR FATAL] Node.js belum terinstall di PC ini!
    echo Silakan install Node.js versi LTS terlebih dahulu.
    echo Setelah Node.js terinstall, jalankan kembali file ini.
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo Node.js terdeteksi: %NODE_VER%
echo.

:: 2. Cek file inti
 echo [2/6] Mengecek file aplikasi...
if not exist "server.js" (
    echo [ERROR] File server.js tidak ditemukan.
    echo Pastikan setup_printer.bat berada dalam folder aplikasi yang sama.
    pause
    exit /b 1
)
if not exist "package.json" (
    echo [ERROR] File package.json tidak ditemukan.
    pause
    exit /b 1
)
if not exist "public\index.html" (
    echo [ERROR] File public\index.html tidak ditemukan.
    echo Versi aplikasi ini membutuhkan folder public.
    pause
    exit /b 1
)
echo Struktur file utama valid.
echo.

:: 3. Siapkan .env jika belum ada
echo [3/6] Menyiapkan file konfigurasi...
if not exist ".env" (
    if exist ".env.example" (
        copy /Y ".env.example" ".env" >nul
        echo File .env dibuat dari .env.example
    ) else (
        (
            echo APP_PIN=4545
            echo PORT=3000
            echo ALLOWED_ORIGINS=*
            echo MAX_UPLOAD_MB=25
        ) > ".env"
        echo File .env default berhasil dibuat.
    )
) else (
    echo File .env sudah ada, tidak ditimpa.
)
echo.

:: 4. Install dependensi aplikasi
echo [4/6] Memasang modul aplikasi...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Gagal menginstall modul aplikasi.
    echo Pastikan koneksi internet tersedia dan npm dapat berjalan normal.
    pause
    exit /b 1
)
echo Dependensi aplikasi selesai dipasang.
echo.

:: 5. Install PM2 jika belum ada
echo [5/6] Mengecek PM2...
call pm2 -v >nul 2>&1
if %errorlevel% neq 0 (
    echo PM2 belum tersedia. Memasang PM2 global...
    call npm install -g pm2
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] Gagal memasang PM2.
        echo Jalankan CMD sebagai Administrator lalu coba lagi.
        pause
        exit /b 1
    )
) else (
    echo PM2 sudah terpasang.
)
echo.

:: 6. Jalankan server via PM2
echo [6/6] Menyalakan mesin server...
call pm2 stop %APP_NAME% >nul 2>&1
call pm2 delete %APP_NAME% >nul 2>&1
call pm2 start server.js --name "%APP_NAME%"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server gagal dijalankan lewat PM2.
    pause
    exit /b 1
)
call pm2 save >nul 2>&1

echo.
echo ===================================================
echo   INSTALLASI SELESAI! SERVER CETAK SUDAH AKTIF.
echo ===================================================
echo.
echo Aplikasi berjalan di latar belakang melalui PM2.
echo Buka dari PC ini: http://localhost:3000
echo.
echo Cek IP lokal untuk diakses dari perangkat lain:
ipconfig | findstr /i "ipv4"
echo.
echo Catatan:
echo - Jika ingin mengganti PIN, edit file .env lalu restart PM2:
echo   pm2 restart %APP_NAME%
echo - Jika firewall Windows meminta izin, pilih Allow access.
echo.
pause
endlocal
