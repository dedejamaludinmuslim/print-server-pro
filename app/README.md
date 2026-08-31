# Source Aplikasi

Folder ini berisi source Print Server Pro v4.6.4. Versi ini membatasi pencarian
awal `192.168.1.x` hingga 18 detik, selalu menampilkan hasil pemindaian, dan
membuka Pengaturan secara otomatis jika server tidak ditemukan.

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
