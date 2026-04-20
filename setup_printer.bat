@echo off
setlocal

echo ========================================
echo  PRINT SERVER V4.5.2 HEARTBEAT INSTALLER
echo ========================================

echo.
if not exist server.js (
  echo [ERROR] server.js tidak ditemukan.
  pause
  exit /b 1
)

if not exist index.html (
  echo [ERROR] index.html tidak ditemukan.
  pause
  exit /b 1
)

echo [1/4] Install dependency...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install gagal.
  pause
  exit /b 1
)

echo [2/4] Konfigurasi heartbeat opsional:
echo Set environment variable ini jika ingin registry pusat:
echo   REGISTRY_URL=https://domain-registry-anda
echo   SERVER_LABEL=Printer HK 1
echo   ALLOWED_ORIGINS=https://domain-hosting-anda
echo.

echo [3/4] Jalankan server lokal:
echo   npm start
echo.
echo [4/4] Jika ingin registry pusat, jalankan di server publik:
echo   npm run start:registry
echo.

echo Selesai.
pause
