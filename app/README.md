# Source Aplikasi

Folder ini berisi source Print Server Pro v4.6.10. Versi ini membuka antarmuka
dan panel Pengaturan secara langsung tanpa pemindaian otomatis atau overlay
loading. Pengguna memasukkan IP server lalu menekan Enter; pemindaian
`192.168.1.x` tetap tersedia melalui tombol pencarian.

```powershell
npm ci
npm start
```

Aplikasi berjalan pada port 3000. File yang diunggah pengguna disimpan sementara
di `uploads/`; folder tersebut dibuat otomatis dan tidak dikomit ke Git.

Jalankan pemeriksaan source dengan:

```powershell
npm run check
```
