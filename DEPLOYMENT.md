# Deployment ke Repository yang Sama

Target repository:
`https://github.com/dedejamaludinmuslim/print-server-pro`

## 1. Isi branch `main`

Salin seluruh isi folder `repository` dari paket deployment ke root repository.
Hasil akhirnya harus memuat `app/`, `installer/`, `.github/`, `.gitignore`,
`.gitattributes`, `README.md`, dan `DEPLOYMENT.md`.

Jika menggunakan Git:

```powershell
git clone https://github.com/dedejamaludinmuslim/print-server-pro.git
cd print-server-pro
# Salin isi folder repository dari paket ke folder ini.
git add app installer .github .gitignore .gitattributes README.md DEPLOYMENT.md
git commit -m "Deploy Print Server Pro v4.5.36 source and installer H3"
git push origin main
```

Jangan mengunggah `node_modules`, file upload sementara, log, atau ZIP Release ke
branch `main`.

## 2. Buat Release stabil v4.5.36

1. Buka halaman repository, lalu pilih **Releases**.
2. Pilih **Draft a new release**.
3. Buat tag `v4.5.36` dari branch `main`.
4. Gunakan judul `Print Server Pro v4.5.36 Large Type`.
5. Unggah dari folder `release-assets`:
   - `Print_Server_Pro.zip`
   - `manifest.json`
6. Jangan aktifkan **Set as a pre-release**.
7. Publikasikan Release.

## 3. Verifikasi publik

Pastikan alamat berikut dapat dibuka tanpa login:

- `https://raw.githubusercontent.com/dedejamaludinmuslim/print-server-pro/main/installer/Install-PrintServerPro.ps1`
- `https://github.com/dedejamaludinmuslim/print-server-pro/releases/latest/download/manifest.json`
- `https://github.com/dedejamaludinmuslim/print-server-pro/releases/latest/download/Print_Server_Pro.zip`

Isi manifest terbaru harus menunjukkan versi `4.5.36`.

## 4. Uji satu PC

Jalankan mode Repair pada satu PC nonkritis. Verifikasi:

```powershell
Invoke-RestMethod http://localhost:3000/ping
Get-ScheduledTask -TaskName "Print Server Pro" | Select-Object TaskName,State
```

Server harus melaporkan versi `4.5.36`, task tetap berjalan setelah terminal
ditutup, dan printer Windows muncul pada aplikasi.

## 5. Batas deployment

GitHub Pages tidak digunakan. Halaman aplikasi bergantung pada `server.js`,
printer Windows, dan endpoint lokal port 3000. Source boleh berada di GitHub,
tetapi layanan cetak harus berjalan pada PC printer.

