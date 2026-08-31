# Deployment ke Repository yang Sama

Target repository:
`https://github.com/dedejamaludinmuslim/print-server-pro`

## 1. Isi branch `main`

Salin seluruh isi folder `repository` dari paket deployment ke root repository.
Hasil akhirnya harus memuat `app/`, `docs/`, `installer/`, `.github/`,
`.gitignore`, `.gitattributes`, `README.md`, dan `DEPLOYMENT.md`.

Jika menggunakan Git:

```powershell
git clone https://github.com/dedejamaludinmuslim/print-server-pro.git
cd print-server-pro
# Salin isi folder repository dari paket ke folder ini.
git add app docs installer .github .gitignore .gitattributes README.md DEPLOYMENT.md
git commit -m "Deploy Print Server Pro v4.6.8 balanced header"
git push origin main
```

Jangan mengunggah `node_modules`, file upload sementara, log, atau ZIP Release ke
branch `main`.

## 2. Aktifkan GitHub Pages

1. Buka **Settings → Pages**.
2. Pilih **Deploy from a branch**.
3. Pilih branch `main` dan folder `/docs`.
4. Simpan, lalu tunggu proses deployment selesai.

Alamat aplikasi:

`https://dedejamaludinmuslim.github.io/print-server-pro/`

Saat browser meminta izin akses jaringan lokal, pilih **Allow**.

## 3. Perbarui Release stabil v4.6.8

1. Buka halaman repository, lalu pilih **Releases**.
2. Buka Release `v4.6.8`. Jika belum ada, buat tag `v4.6.8` dari branch
   `main`.
3. Hapus aset lama dengan nama yang sama, lalu unggah dari folder
   `release-assets`:
   - `Print_Server_Pro.zip`
   - `manifest.json`
4. Jangan aktifkan **Set as a pre-release**.
5. Simpan/publikasikan Release.

## 4. Verifikasi publik

Pastikan alamat berikut dapat dibuka tanpa login:

- `https://raw.githubusercontent.com/dedejamaludinmuslim/print-server-pro/main/installer/Install-PrintServerPro.ps1`
- `https://github.com/dedejamaludinmuslim/print-server-pro/releases/latest/download/manifest.json`
- `https://github.com/dedejamaludinmuslim/print-server-pro/releases/latest/download/Print_Server_Pro.zip`
- `https://dedejamaludinmuslim.github.io/print-server-pro/`

Isi manifest terbaru harus menunjukkan versi `4.6.8`.

## 5. Uji satu PC

Jalankan perintah installer terpadu pada satu PC nonkritis, lalu pilih
**Pasang / Perbarui / Perbaiki**. Verifikasi:

```powershell
Invoke-RestMethod http://localhost:3000/ping
Get-ScheduledTask -TaskName "Print Server Pro" | Select-Object TaskName,State
```

Server harus melaporkan versi `4.6.8`, task tetap berjalan setelah terminal
ditutup, dan printer Windows muncul pada aplikasi GitHub Pages. Perintah yang
sama juga menyediakan pilihan untuk menghapus aplikasi.

## 6. Batas deployment

GitHub Pages hanya menjalankan antarmuka statis. `server.js`, printer Windows,
dan endpoint port 3000 tetap harus berjalan pada PC printer. Perangkat pengguna
harus mengizinkan akses jaringan lokal dan dapat menjangkau IP PC printer.
