# Print Server Pro

Print Server Pro menghubungkan printer Windows—termasuk printer USB—dengan HP
dan komputer lain melalui jaringan lokal.

- Aplikasi stabil: **v4.6.9 Professional Header**
- Installer online: **v4.5.35-H4**
- Repository: `dedejamaludinmuslim/print-server-pro`

## Arsitektur

| Komponen | Lokasi | Fungsi |
| --- | --- | --- |
| Source aplikasi | `app/` | UI, server Node.js, deteksi printer, dan mesin cetak |
| GitHub Pages | `docs/` | Antarmuka publik yang menghubungi server lokal |
| Installer | `installer/` | Instalasi, repair, startup otomatis, dan uninstall |
| GitHub Release | `v4.6.9` | Menyediakan `Print_Server_Pro.zip` dan `manifest.json` |
| PC printer | `C:\ProgramData\PrintServerPro` | Menjalankan server lokal dan mengakses printer Windows |

GitHub menyimpan source serta paket rilis. GitHub Pages menyediakan antarmuka
publik, sedangkan server printer tetap berjalan pada PC Windows yang terhubung
ke printer.

## Struktur repository

```text
print-server-pro/
├── .github/workflows/qa.yml
├── app/
│   ├── icons/
│   ├── scripts/
│   ├── index.html
│   ├── server.js
│   ├── package.json
│   ├── package-lock.json
│   ├── manifest.json
│   ├── sw.js
│   └── setup_printer.bat
├── docs/
│   ├── icons/
│   ├── .nojekyll
│   ├── index.html
│   ├── manifest.json
│   └── sw.js
├── installer/
│   └── Install-PrintServerPro.ps1
├── .gitattributes
├── .gitignore
├── DEPLOYMENT.md
└── README.md
```

## GitHub Pages

Aktifkan **Settings → Pages → Deploy from a branch → main → /docs**. Alamat
aplikasi:

`https://dedejamaludinmuslim.github.io/print-server-pro/`

Deployment Vercel produksi juga diizinkan pada:

`https://print-server-pro.vercel.app/`

Saat browser meminta izin akses jaringan lokal, pilih **Allow**. PC printer
harus berada pada jaringan yang dapat dijangkau perangkat pengguna dan server
lokal harus tetap aktif pada port 3000.

Pada pembukaan awal, aplikasi langsung menampilkan antarmuka dan membuka panel
**Pengaturan**. Tidak ada pemindaian otomatis dan tidak ada layar loading yang
memblokir. Masukkan IP server lalu tekan Enter. Tombol 🔎 tetap dapat digunakan
untuk memindai `192.168.1.1–254` secara opsional. Panel Pengaturan memuat alamat
server, printer, Preset, pemasangan aplikasi, dan bantuan koneksi. Semua opsi
yang langsung memengaruhi hasil cetak tetap berada di area **Print Setup**.

Header utama memakai ikon aplikasi, badge versi, tombol ikon **Panduan**, dan
tombol ikon **Pengaturan**. Header panel Pengaturan memakai susunan tiga kolom
agar ikon, judul, keterangan, dan tombol tutup tetap sejajar pada desktop maupun
HP.

Pada perangkat yang menyediakan tombol Kembali, aplikasi menutup modal atau
panel aktif terlebih dahulu. Dari kategori cetak selain **Dasar**, tombol
Kembali mengarah ke **Dasar**. Aplikasi hanya keluar setelah tombol Kembali
ditekan dua kali dalam jeda sekitar dua detik. Fitur Cari Cepat dan Preflight
tidak lagi digunakan; koneksi awal dilakukan manual dan pemindaian prefix tetap
tersedia sebagai tindakan pengguna.

Startup v4.6.9 tidak menjalankan deteksi server di belakang layar. Service
Worker didaftarkan segera setelah UI siap dan hanya menangani aset dari origin
halaman, sehingga tidak mencegat permintaan menuju server LAN. Kegagalan
koneksi tidak dapat lagi mengunci antarmuka.

Kontrol pemasangan selalu tersedia di Pengaturan. Saat prompt PWA disediakan
browser, tombol menampilkan **Install Aplikasi**. Jika browser hanya mendukung
pintasan, tombol berubah menjadi **Buat Pintasan Aplikasi**; jika aplikasi sudah
dipasang, statusnya ditampilkan pada tombol.

## Instalasi online

Buka Windows PowerShell atau Terminal, lalu jalankan:

```powershell
$u="https://raw.githubusercontent.com/dedejamaludinmuslim/print-server-pro/main/installer/Install-PrintServerPro.ps1"; $p="$env:TEMP\Install-PrintServerPro.ps1"; Invoke-WebRequest $u -UseBasicParsing -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p
```

Perintah tunggal tersebut menampilkan pilihan terpadu:

1. **Pasang / Perbarui / Perbaiki**
2. **Hapus Print Server Pro**
3. **Batal**

Installer meminta hak Administrator, mengunduh Release stabil terbaru,
memverifikasi SHA-256, memasang dependensi, membuka TCP 3000 hanya untuk profil
Private/Domain, dan mendaftarkan startup tersembunyi melalui Task Scheduler.

Node.js tidak ikut dihapus karena mungkin digunakan aplikasi lain.

## Menjalankan source untuk pengembangan

```powershell
cd app
npm ci
npm start
```

Buka `http://localhost:3000/?server=localhost`.

QA source:

```powershell
cd app
npm run check
```

## GitHub Release

Installer selalu menggunakan Release stabil terbaru. Setiap Release wajib
memiliki dua aset dengan nama tetap:

- `Print_Server_Pro.zip`
- `manifest.json`

Jangan menandai Release aktif sebagai draft atau pre-release. Prosedur lengkap
tersedia di [DEPLOYMENT.md](DEPLOYMENT.md).

## Persyaratan dan keamanan jaringan

- Windows 10/11 dan hak Administrator
- Internet ketika instalasi atau pembaruan
- WinGet jika Node.js belum tersedia
- Profil jaringan Private/Domain untuk akses dari perangkat lain
- Port TCP 3000 dapat dijangkau pada jaringan lokal tepercaya

Installer tidak mengubah jaringan Public menjadi Private secara otomatis.
Jangan menghapus `C:\ProgramData\PrintServerPro` setelah instalasi berhasil.
