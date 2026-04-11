const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ptp = require('pdf-to-printer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const PDFDocument = require('pdfkit');
const convertapi = require('convertapi')('gUmIBMyAwXTfTrNguDfGXJVnjDexR7XF');

// Setup WebSockets untuk Status Real-Time
const { Server } = require("socket.io");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const port = 3000;

// === PENGATURAN KEAMANAN ===
const APP_PIN = "4545"; // Ganti dengan PIN rahasiamu

app.use(cors());
app.use(express.static(__dirname));
const upload = multer({ dest: 'uploads/' });

// --- FUNGSI HELPER: PENGIRIM STATUS REAL-TIME ---
function updateStatus(message, type = 'info') {
    console.log(`[Status]: ${message}`);
    io.emit('print-status', { message, type });
}

// ==========================================
// 1. ENDPOINT: AUTO-DISCOVERY (PING)
// ==========================================
app.get('/ping', (req, res) => {
    res.json({ status: 'PrintServerActive', hostname: os.hostname(), platform: os.platform() });
});

// ==========================================
// 2. ENDPOINT: MENGAMBIL DAFTAR PRINTER
// ==========================================
app.get('/printers', async (req, res) => {
    try {
        const printers = await ptp.getPrinters();
        res.json(printers); 
    } catch (error) {
        console.error("Gagal membaca printer:", error);
        res.status(500).send("Gagal mengambil daftar printer");
    }
});

// ==========================================
// 3. ENDPOINT: EKSEKUSI CETAK UTAMA (V4.2)
// ==========================================
app.post('/print', upload.single('document'), async (req, res) => {
    let filePath = req.file ? path.join(__dirname, req.file.path) : '';
    
    // --- CEK KEAMANAN PIN ---
    const pin = req.body.pin || '';
    if (pin !== APP_PIN) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        console.log("🚨 Akses ditolak! Seseorang mencoba print dengan PIN yang salah.");
        return res.status(401).send('PIN Salah! Akses ditolak oleh Server PC.');
    }

    // --- BACA PENGATURAN DOKUMEN ---
    const copies = req.body.copies ? parseInt(req.body.copies) : 1;
    let pages = req.body.pages || ''; 
    const targetPrinter = req.body.printerName || ''; 
    const colorMode = req.body.colorMode || 'color'; 
    let paperSize = req.body.paperSize || 'A4';

    // Konversi F4 ke ukuran milimeter yang dipahami mesin printer
    if (paperSize === 'F4') {
        paperSize = '210x330mm'; 
    }

    // Susun perintah untuk driver printer
    const printOptions = { copies: copies, paperSize: paperSize };
    
    // Hapus spasi jika user mengetik halaman mix dengan spasi (cth: "1, 3, 5-7" -> "1,3,5-7")
    if (pages !== '') {
        printOptions.pages = pages.replace(/\s/g, ''); 
    }
    
    // Perintah cetak hitam-putih
    if (colorMode === 'monochrome') {
        printOptions.monochrome = true; 
    }

    const fileUrl = req.body.fileUrl;
    let originalName = req.file ? req.file.originalname.toLowerCase() : '';

    try {
        updateStatus("Menerima instruksi dari HP...", "processing");

        // --- SUMBER FILE: DOWNLOAD LINK URL ---
        if (fileUrl) {
            updateStatus("Mendownload dokumen dari internet...", "downloading");
            filePath = path.join(__dirname, `downloaded_${Date.now()}.tmp`);
            let urlExt = '.pdf';
            try { urlExt = path.extname(new URL(fileUrl).pathname).toLowerCase(); } catch(e){}
            originalName = 'download' + (urlExt || '.pdf');

            await new Promise((resolve, reject) => {
                const fileStream = fs.createWriteStream(filePath);
                https.get(fileUrl, (response) => {
                    if (response.statusCode !== 200) return reject(new Error('URL tidak valid'));
                    response.pipe(fileStream);
                    fileStream.on('finish', () => { fileStream.close(); resolve(); });
                }).on('error', (err) => reject(err));
            });
        } else if (!req.file) {
            return res.status(400).send('Pilih file atau masukkan link!');
        }

        // --- KONVERSI GAMBAR KE PDF ---
        if (['.jpg', '.jpeg', '.png'].some(ext => originalName.endsWith(ext))) {
            updateStatus("Membungkus gambar ke format PDF...", "converting");
            const pdfPath = filePath + '_converted.pdf';
            const doc = new PDFDocument({ autoFirstPage: false });
            const stream = fs.createWriteStream(pdfPath);
            await new Promise((resolve, reject) => {
                doc.pipe(stream);
                const img = doc.openImage(filePath);
                doc.addPage({ size: [img.width, img.height] });
                doc.image(img, 0, 0);
                doc.end();
                stream.on('finish', resolve); stream.on('error', reject);
            });
            fs.unlinkSync(filePath); filePath = pdfPath; 
        }

        // --- KONVERSI OFFICE (DOCX/XLSX) DI CLOUD ---
        else if (['.doc', '.docx', '.xls', '.xlsx'].some(ext => originalName.endsWith(ext))) {
            updateStatus("Mengonversi dokumen Word/Excel di Cloud...", "converting");
            const format = originalName.split('.').pop(); 
            const convertResult = await convertapi.convert('pdf', { File: filePath }, format);
            const savedFiles = await convertResult.saveFiles(__dirname);
            fs.unlinkSync(filePath); filePath = savedFiles[0];
        }

        // --- EKSEKUSI CETAK ---
        let namaMesin = targetPrinter ? targetPrinter : "Default Printer";
        updateStatus(`Mencetak di [${namaMesin}]...`, "printing");
        
        await ptp.print(filePath, printOptions);
        
        updateStatus("✅ Cetak Selesai!", "success");
        res.send('Dokumen berhasil dicetak!');
        
    } catch (error) {
        console.error('Error:', error); 
        updateStatus(`🚨 Error: ${error.message}`, "error");
        res.status(500).send('Gagal: ' + error.message);
    } finally {
        // Membersihkan file sementara agar hardisk PC tidak penuh
        if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    }
});

// ==========================================
// MENYALAKAN SERVER 
// ==========================================
server.listen(port, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🏢 Print Server V4.2 (Enterprise Mode)`);
    console.log(`🔒 PIN Protection  : ACTIVE`);
    console.log(`⚙️ Format F4 & Mono : ACTIVE`);
    console.log(`⚡ WebSocket Status : ACTIVE`);
    console.log(`=========================================`);
});