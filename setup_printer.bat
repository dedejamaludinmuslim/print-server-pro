@echo off
:: Cek hak akses Administrator
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [OK] Menjalankan dengan hak akses Administrator.
) else (
    echo [ERROR] Klik kanan file ini lalu pilih "Run as Administrator"!
    pause
    exit /b
)

title Installer Print Server Enterprise V4.4
echo =====================================================
echo    INSTALLER PRINT SERVER ENTERPRISE - ONE CLICK
echo =====================================================
echo.

:: 1. Cek apakah Node.js sudah terinstal
node -v >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Node.js tidak ditemukan. Harap instal Node.js terlebih dahulu!
    start https://nodejs.org/
    pause
    exit /b
)

:: 2. Instalasi Library Lokal (Termasuk pdf-lib untuk fitur N-Up)
echo [1/5] Mengunduh library yang dibutuhkan...
call npm install express multer cors pdf-to-printer pdfkit convertapi socket.io pdf-lib --save

:: 3. Instalasi Global Tools (PM2)
echo [2/5] Memasang PM2 dan Tool Startup...
call npm install -g pm2 pm2-windows-startup

:: 4. Membuka Port 3000 di Firewall Windows
echo [3/5] Membuka Port 3000 di Firewall...
netsh advfirewall firewall add rule name="PrintServerV4" dir=in action=allow protocol=TCP localport=3000

:: 5. Menjalankan Server di PM2
echo [4/5] Menjalankan server di latar belakang...
call pm2 delete print-server >nul 2>&1
call pm2 start server.js --name print-server

:: 6. Mengunci agar Tahan Banting (Auto-Startup)
echo [5/5] Mengatur auto-run saat PC menyala...
call pm2-startup install
call pm2 save --force

echo.
echo =====================================================
echo [BERHASIL] Sistem terpasang dan akan aktif otomatis!
echo.
echo Cek IP komputer ini dengan mengetik 'ipconfig' di CMD.
echo Gunakan IP tersebut di aplikasi Android kamu.
echo =====================================================
pause