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
const { Server } = require("socket.io");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const port = 3000;

app.use(cors());
app.use(express.static(__dirname));
const upload = multer({ dest: 'uploads/' });

// ==========================================
// 🗄️ DATABASE PENGGUNA & KUOTA (Simulasi)
// ==========================================
const usersDB = {
    "admin": { pin: "8888", role: "SuperAdmin", quota: 9999, used: 0 },
    "bos": { pin: "1234", role: "Manager", quota: 500, used: 0 },
    "magang": { pin: "0000", role: "Intern", quota: 20, used: 0 }
};

function updateStatus(message, type = 'info') {
    console.log(`[Status]: ${message}`);
    io.emit('print-status', { message, type });
}

app.get('/ping', (req, res) => {
    res.json({ status: 'PrintServerActive', hostname: os.hostname(), platform: os.platform() });
});

app.get('/printers', async (req, res) => {
    try { res.json(await ptp.getPrinters()); } 
    catch (error) { res.status(500).send("Gagal mengambil daftar printer"); }
});

// ==========================================
// 🚀 ENDPOINT PRINT (DENGAN AUTH & ADVANCED SETTINGS)
// ==========================================
app.post('/print', upload.single('document'), async (req, res) => {
    let filePath = req.file ? path.join(__dirname, req.file.path) : '';
    
    // --- 1. AUTENTIKASI & CEK KUOTA ---
    const username = req.body.username ? req.body.username.toLowerCase() : '';
    const pin = req.body.pin || '';
    const copies = req.body.copies ? parseInt(req.body.copies) : 1;

    const user = usersDB[username];
    if (!user || user.pin !== pin) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(401).send('Akses Ditolak: Username atau PIN salah!');
    }

    if (user.used + copies > user.quota) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(403).send(`Kuota Habis! Sisa kuota ${username}: ${user.quota - user.used} lembar.`);
    }

    // --- 2. ADVANCED HARDWARE CONTROL ---
    const pages = req.body.pages || ''; 
    const targetPrinter = req.body.printerName || ''; 
    const colorMode = req.body.colorMode || 'color'; // color atau monochrome
    const paperSize = req.body.paperSize || 'A4';

    // Menyusun argumen OS tingkat lanjut untuk pdf-to-printer
    const printOptions = { copies: copies, paperSize: paperSize };
    if (pages !== '') printOptions.pages = pages;
    if (targetPrinter !== '') printOptions.printer = targetPrinter; 
    
    // Injeksi perintah warna khusus Windows
    if (colorMode === 'monochrome') {
        printOptions.monochrome = true; 
    }

    let originalName = req.file ? req.file.originalname.toLowerCase() : '';
    const fileUrl = req.body.fileUrl;

    try {
        updateStatus(`[${user.role}] ${username} mengirim dokumen...`, "processing");

        // --- 3. PROSES FILE (LOKAL & URL SAJA) ---
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

        // --- 4. KONVERSI (GAMBAR & OFFICE) ---
        if (['.jpg', '.jpeg', '.png'].some(ext => originalName.endsWith(ext))) {
            updateStatus("Membungkus gambar ke format PDF...", "converting");
            const pdfPath = filePath + '_converted.pdf';
            const doc = new PDFDocument({ autoFirstPage: false });
            const stream = fs.createWriteStream(pdfPath);
            await new Promise((resolve, reject) => {
                doc.pipe(stream); const img = doc.openImage(filePath);
                doc.addPage({ size: [img.width, img.height] }); doc.image(img, 0, 0); doc.end();
                stream.on('finish', resolve); stream.on('error', reject);
            });
            fs.unlinkSync(filePath); filePath = pdfPath; 
        } else if (['.doc', '.docx', '.xls', '.xlsx'].some(ext => originalName.endsWith(ext))) {
            updateStatus("Mengonversi dokumen Office di Cloud...", "converting");
            const format = originalName.split('.').pop(); 
            const convertResult = await convertapi.convert('pdf', { File: filePath }, format);
            const savedFiles = await convertResult.saveFiles(__dirname);
            fs.unlinkSync(filePath); filePath = savedFiles[0];
        }

        // --- 5. EKSEKUSI CETAK & POTONG KUOTA ---
        let namaMesin = targetPrinter ? targetPrinter : "Default Printer";
        updateStatus(`Mencetak di [${namaMesin}] (${paperSize}, ${colorMode})...`, "printing");
        
        await ptp.print(filePath, printOptions);
        
        // Memotong kuota pengguna setelah sukses
        usersDB[username].used += copies;
        console.log(`[Kuota] ${username} telah menggunakan ${usersDB[username].used}/${usersDB[username].quota}`);

        updateStatus("✅ Cetak Selesai!", "success");
        res.send(`Sukses dicetak! Sisa kuota Anda: ${user.quota - user.used}`);
        
    } catch (error) {
        console.error('Error:', error); 
        updateStatus(`🚨 Error: ${error.message}`, "error");
        res.status(500).send('Gagal: ' + error.message);
    } finally {
        if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    }
});

server.listen(port, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🏢  Print Server V4 (Enterprise/Multi-Tenant)`);
    console.log(`🗄️  Database User & Kuota: ONLINE`);
    console.log(`⚙️  Advanced Hardware Control: ONLINE`);
    console.log(`⚡  WebSockets & Auto-Discovery: ONLINE`);
    console.log(`=========================================`);
});