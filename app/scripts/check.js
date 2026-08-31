const fs = require('fs');

const expected = process.argv[2];
if (!expected) throw new Error('Versi yang diharapkan belum diberikan.');

const index = fs.readFileSync('index.html', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const setup = fs.readFileSync('setup_printer.bat', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

new Function(server);
let inlineCount = 0;
for (const match of index.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  new Function(match[1]);
  inlineCount += 1;
}

if (!index.includes(`>v${expected}<`)) throw new Error('Badge versi UI tidak sesuai.');
if (!server.includes(`version: '${expected}'`)) throw new Error('Versi respons server tidak sesuai.');
if (!setup.includes(`V${expected}`)) throw new Error('Versi installer tidak sesuai.');
if (pkg.name !== 'print-server-pro') throw new Error('Nama paket internal belum dibersihkan.');
if (index.includes('addPrintOptionExpansion')) throw new Error('Placeholder opsi cetak masih tersisa.');
if (index.includes('Auto sesuai ukuran halaman')) throw new Error('Opsi tray semu masih tersisa pada UI aktif.');
if (!index.includes('refreshPrinterCapabilities(force=false)')) throw new Error('Deteksi kemampuan dinamis tidak ditemukan.');
if (!server.includes('assertPrintOptionsSupported')) throw new Error('Validasi kemampuan di backend tidak ditemukan.');
if (index.includes('startQuickDiscovery') || index.includes('Cari Cepat')) throw new Error('Fitur Cari Cepat masih ditemukan.');
if (!index.includes("const DEFAULT_DISCOVERY_PREFIX = '192.168.1'")) throw new Error('Prefix pencarian server default belum ditetapkan.');
if (!index.includes('Array.from({ length: 254 }')) throw new Error('Pemindaian 254 alamat pada prefix default tidak ditemukan.');
if (!index.includes('Pemindaian tahap 1') || !index.includes('Pemindaian tahap 2')) throw new Error('Pemindaian server dua tahap tidak ditemukan.');
if (!index.includes('discoverFirstServer(prefixCandidates, 1600') || !index.includes('discoverFirstServer(prefixCandidates, 2800')) throw new Error('Timeout pemindaian dua tahap tidak sesuai.');
if (!index.includes("permissionBeforeScan === 'prompt'") || !index.includes('probePrintServer(`${DEFAULT_DISCOVERY_PREFIX}.1`, 10000')) throw new Error('Pemicu izin Local Network Access belum ditemukan.');
if (index.includes('192.168.0')) throw new Error('Prefix kedua masih aktif pada pencarian server.');
if (!index.includes('initialAutoDiscoverServer()')) throw new Error('Bootstrap pencarian server otomatis tidak ditemukan.');
if (!index.includes('id="initialLoadingScreen"')) throw new Error('Layar loading awal tidak ditemukan.');
if (!index.includes('id="appSettingsBtn"')) throw new Error('Tombol Pengaturan pada header tidak ditemukan.');
if (!index.includes('id="appSettingsPanel"')) throw new Error('Panel Pengaturan Aplikasi tidak ditemukan.');
for (const slot of ['appSettingsConnection', 'appSettingsPrinter', 'appSettingsPreset', 'appSettingsGeneral']) {
  if (!index.includes(`id="${slot}"`)) throw new Error(`Slot ${slot} tidak ditemukan.`);
}
if (index.includes('id="dialogServerSlot"')) throw new Error('Alamat server masih berada pada bar pengaturan cetak.');
if (index.includes('id="dialogPresetSlot"')) throw new Error('Preset masih berada pada bar pengaturan cetak.');
if (index.includes("['sourceSizeInfo','printerSelect'")) throw new Error('Printer masih ditempatkan pada panel Dasar.');
if (!index.includes("uxGroupForControl('ipAddress'),serverSlot=document.getElementById('appSettingsConnection')")) throw new Error('Alamat server belum dipindahkan ke Pengaturan Aplikasi.');
if (!index.includes("uxGroupForControl('printerSelect'),printerSlot=document.getElementById('appSettingsPrinter')")) throw new Error('Printer belum dipindahkan ke Pengaturan Aplikasi.');
if (!index.includes("uxGroupForControl('presetSelect'),presetSlot=document.getElementById('appSettingsPreset')")) throw new Error('Preset belum dipindahkan ke Pengaturan Aplikasi.');
if (!index.includes("['fileInput','sourceSizeInfo','colorMode'")) throw new Error('Pilih File belum ditempatkan tepat sebelum Ukuran Dokumen Sumber.');
if (/preflight/i.test(index)) throw new Error('Fitur Preflight masih ditemukan.');
if (!index.includes('function setupBackNavigation()')) throw new Error('Pelindung tombol Kembali tidak ditemukan.');
if (!index.includes("showToast('Tekan tombol Kembali sekali lagi untuk keluar.'")) throw new Error('Pesan konfirmasi keluar dua kali tidak ditemukan.');
if (!index.includes("if (activePanel && activePanel !== 'basic')")) throw new Error('Tombol Kembali belum mengembalikan panel cetak ke Dasar.');
if (!index.includes('parseDiscoveryInput')) throw new Error('Pemindaian multi-subnet tidak ditemukan.');
if (!index.includes("local-network-access")) throw new Error('Diagnosis izin Local Network Access tidak ditemukan.');
if (!server.includes("app.get('/pairing-qr'")) throw new Error('Endpoint QR pairing tidak ditemukan.');
if (!server.includes("type: 'printserverpro'")) throw new Error('Publikasi mDNS tidak ditemukan.');
if (!server.includes('https://dedejamaludinmuslim.github.io')) throw new Error('Origin GitHub Pages belum diizinkan.');
if (!server.includes("res.setHeader('Access-Control-Allow-Private-Network', 'true')")) throw new Error('Header akses jaringan lokal pada ping tidak ditemukan.');
if (!setup.includes('profile=private,domain')) throw new Error('Aturan firewall aman tidak ditemukan.');

console.log(`QA ${expected} OK: server valid, ${inlineCount} inline script valid, identitas versi konsisten.`);
