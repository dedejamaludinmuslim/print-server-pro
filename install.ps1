# 1. Buat Folder Kerja
$path = "D:\APLIKASI\print-server"
if (!(Test-Path $path)) { New-Item -ItemType Directory -Path $path }
Set-Location $path

# 2. Download server.js langsung dari GitHub kamu
echo "[1/4] Mengambil kode server terbaru..."
$baseUrl = "https://raw.githubusercontent.com/USERNAME_KAMU/REPO_KAMU/main"
Invoke-WebRequest -Uri "$baseUrl/server.js" -OutFile "server.js"

# 3. Instalasi Node Modules
echo "[2/4] Menginstal library pendukung..."
npm install express multer cors pdf-to-printer pdfkit convertapi socket.io

# 4. Pengaturan Firewall
echo "[3/4] Membuka jalur akses jaringan..."
netsh advfirewall firewall add rule name="PrintServerV4" dir=in action=allow protocol=TCP localport=3000

# 5. Konfigurasi PM2 Startup
echo "[4/4] Mengunci server agar tahan banting..."
npm install -g pm2 pm2-windows-startup
pm2 delete print-server | out-null
pm2 start server.js --name print-server
pm2-startup install
pm2 save --force

echo "`n=========================================="
echo " BERHASIL! Server Print Aktif Selamanya."
echo "=========================================="