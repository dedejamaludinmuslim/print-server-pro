# Print Server Pro

Print Server Pro menghubungkan printer Windows—termasuk printer USB—dengan HP
dan komputer lain melalui jaringan lokal.

- Aplikasi stabil: **v4.6.6 LAN Bootstrap Hotfix**
- Installer online: **v4.5.35-H4**
- Repository: `dedejamaludinmuslim/print-server-pro`

## Arsitektur

| Komponen | Lokasi | Fungsi |
| --- | --- | --- |
| Source aplikasi | `app/` | UI, server Node.js, deteksi printer, dan mesin cetak |
| GitHub Pages | `docs/` | Antarmuka publik yang menghubungi server lokal |
| Installer | `installer/` | Instalasi, repair, startup otomatis, dan uninstall |
| GitHub Release | `v4.6.6` | Menyediakan `Print_Server_Pro.zip` dan `manifest.json` |
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

Pada pembukaan awal, aplikasi langsung memindai `192.168.1.1–254` dan memilih
alamat yang terbukti menjalankan Print Server Pro. Hanya prefix `192.168.1.x`
yang dipindai pada tahap ini. Selama proses tersebut aplikasi menampilkan layar
loading. Tombol **Pengaturan** di kanan header membuka panel khusus untuk alamat
server, printer, Preset, pemasangan aplikasi, dan bantuan koneksi. Semua opsi
yang langsung memengaruhi hasil cetak tetap berada di area **Print Setup**.

Pada perangkat yang menyediakan tombol Kembali, aplikasi menutup modal atau
panel aktif terlebih dahulu. Dari kategori cetak selain **Dasar**, tombol
Kembali mengarah ke **Dasar**. Aplikasi hanya keluar setelah tombol Kembali
ditekan dua kali dalam jeda sekitar dua detik. Fitur Cari Cepat dan Preflight
tidak lagi digunakan; pencarian awal otomatis dan pemindaian prefix manual tetap
tersedia.

Deteksi awal v4.6.6 hanya memindai prefix `192.168.1.x`. Setelah `/ping`
membuktikan server aktif, layar awal langsung membuka antarmuka dan daftar
printer dimuat di belakang dengan batas 8 detik. Batas pencarian 18 detik serta
watchdog antarmuka 20 detik mencegah layar loading menetap. Service Worker hanya
menangani aset dari origin halaman dan tidak mencegat permintaan menuju server
LAN. Jika gagal, panel **Pengaturan** dibuka otomatis dan menampilkan diagnosis
jaringan.

Tombol **Install Aplikasi** selalu tersedia di Pengaturan. Saat prompt PWA belum
disediakan browser, tombol tersebut menampilkan petunjuk **Tambahkan ke layar
utama**; jika aplikasi sudah dipasang, statusnya ditampilkan pada tombol.

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
