const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ptp = require('pdf-to-printer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const PDFDocument = require('pdfkit');
const convertapi = require('convertapi')('AIzaSyDJwVqEvUPWN9yu5Jg00V-RXPQt7ldVRzg');
const { PDFDocument, degrees } = require('pdf-lib');

// Setup WebSockets untuk Status Real-Time
const { Server } = require("socket.io");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const port = 4545;

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
    const orientation = req.body.orientation || 'portrait';
    const pagesPerSheet = parseInt(req.body.pagesPerSheet) || 1; 
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
        updateStatus("Menerima instruksi dari device...", "processing");

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

        // --- MANIPULASI TATA LETAK PDF (Landscape & N-Up) ---
        if (orientation === 'landscape' || pagesPerSheet > 1) {
            updateStatus("Menyesuaikan tata letak halaman (Orientation/N-Up)...", "converting");
            
            const pdfBytes = fs.readFileSync(filePath);
            const pdfDoc = await PDFDocument.load(pdfBytes);
            let finalPdfDoc = pdfDoc;

            // Logika Rotasi Landscape (Hanya jika 1 hal/kertas)
            if (orientation === 'landscape' && pagesPerSheet === 1) {
                const pages = pdfDoc.getPages();
                pages.forEach((page) => {
                    page.setRotation(degrees(90));
                });
            }

            // Logika 2-Up (Mencetak 2 Halaman dalam 1 Kertas A4)
            if (pagesPerSheet === 2) {
                finalPdfDoc = await PDFDocument.create();
                const copiedPages = await finalPdfDoc.copyPages(pdfDoc, pdfDoc.getPageIndices());
                
                for (let i = 0; i < copiedPages.length; i += 2) {
                    // Buat lembar kanvas baru (Ukuran A4 Landscape: 841.89 x 595.28 point)
                    const newPage = finalPdfDoc.addPage([841.89, 595.28]); 
                    
                    // Tempel halaman ganjil di sisi KIRI
                    const page1 = copiedPages[i];
                    const embeddedPage1 = await finalPdfDoc.embedPage(page1);
                    newPage.drawPage(embeddedPage1, {
                        x: 0, y: 0, width: 420.94, height: 595.28,
                    });

                    // Tempel halaman genap di sisi KANAN (jika masih ada sisa halaman)
                    if (i + 1 < copiedPages.length) {
                        const page2 = copiedPages[i + 1];
                        const embeddedPage2 = await finalPdfDoc.embedPage(page2);
                        newPage.drawPage(embeddedPage2, {
                            x: 420.94, y: 0, width: 420.94, height: 595.28,
                        });
                    }
                }
            }

            // Timpa file lama dengan PDF yang sudah dimodifikasi
            const modifiedPdfBytes = await finalPdfDoc.save();
            fs.writeFileSync(filePath, modifiedPdfBytes);
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

// ====================================================
// ENDPOINT SIMULASI: KEMBALIKAN PDF TANPA MENCETAK
// ====================================================
app.post('/simulate', upload.single('document'), async (req, res) => {
    try {
        let filePath = '';
        if (req.file) {
            filePath = req.file.path;
        } else if (req.body.fileUrl) {
            // Jika Anda punya logika download URL di /print, pastikan berjalan juga di sini
            return res.status(400).send("Simulasi URL belum didukung. Harap upload file.");
        }

        if (!filePath) return res.status(400).send("File tidak ditemukan.");

        const orientation = req.body.orientation || 'portrait';
        const pagesPerSheetVal = parseInt(req.body.pagesPerSheet) || 1;
        const pagesInput = req.body.pages || '';

        const { PDFDocument, degrees } = require('pdf-lib');

        // 1. FILTER HALAMAN (Sama seperti print asli)
        if (pagesInput) {
            const pdfBytes = fs.readFileSync(filePath);
            const pdfDoc = await PDFDocument.load(pdfBytes);
            const totalPages = pdfDoc.getPageCount();
            
            let pagesToKeep = new Set();
            let parts = pagesInput.split(',');
            for (let part of parts) {
                if (part.includes('-')) {
                    let [start, end] = part.split('-').map(n => parseInt(n.trim()));
                    if (!isNaN(start) && !isNaN(end)) {
                        start = Math.max(1, start); end = Math.min(totalPages, end);
                        for (let i = start; i <= end; i++) pagesToKeep.add(i);
                    }
                } else {
                    let num = parseInt(part.trim());
                    if (!isNaN(num) && num >= 1 && num <= totalPages) pagesToKeep.add(num);
                }
            }

            let sortedPages = Array.from(pagesToKeep).sort((a,b) => a-b);
            if (sortedPages.length > 0) {
                const newPdf = await PDFDocument.create();
                const copiedPages = await newPdf.copyPages(pdfDoc, sortedPages.map(p => p - 1));
                copiedPages.forEach(page => newPdf.addPage(page));
                const newBytes = await newPdf.save();
                fs.writeFileSync(filePath, newBytes);
            }
        }

        // 2. MANIPULASI GRID N-UP & ROTASI (Sama persis seperti algoritma print asli)
        if (orientation === 'landscape' || pagesPerSheetVal > 1) {
            const pdfBytes = fs.readFileSync(filePath);
            const pdfDoc = await PDFDocument.load(pdfBytes);
            const pages = pdfDoc.getPages();
            const finalPdfDoc = await PDFDocument.create();

            let cols = 1, rows = 1;
            if (pagesPerSheetVal === 1) { cols = 1; rows = 1; }
            else if (pagesPerSheetVal === 2) { if (orientation === 'landscape') { cols = 2; rows = 1; } else { cols = 1; rows = 2; } }
            else if (pagesPerSheetVal <= 4) { cols = 2; rows = 2; }
            else if (pagesPerSheetVal <= 6) { if (orientation === 'landscape') { cols = 3; rows = 2; } else { cols = 2; rows = 3; } }
            else if (pagesPerSheetVal <= 9) { cols = 3; rows = 3; }
            else if (pagesPerSheetVal <= 16) { cols = 4; rows = 4; }
            else { cols = Math.ceil(Math.sqrt(pagesPerSheetVal)); rows = Math.ceil(pagesPerSheetVal / cols); }

            let sheetWidth = 595.28, sheetHeight = 841.89;
            if (orientation === 'landscape') { sheetWidth = 841.89; sheetHeight = 595.28; }

            const cellWidth = sheetWidth / cols;
            const cellHeight = sheetHeight / rows;

            let currentSheet;
            for (let i = 0; i < pages.length; i++) {
                if (i % pagesPerSheetVal === 0) currentSheet = finalPdfDoc.addPage([sheetWidth, sheetHeight]);
                
                const embeddedPage = await finalPdfDoc.embedPage(pages[i]);
                
                let isRotated = false;
                if (cellWidth > cellHeight && embeddedPage.width < embeddedPage.height) isRotated = true;
                else if (cellWidth < cellHeight && embeddedPage.width > embeddedPage.height) isRotated = true;

                let drawW = embeddedPage.width; let drawH = embeddedPage.height;
                if (isRotated) { drawW = embeddedPage.height; drawH = embeddedPage.width; }
                
                const scale = Math.min((cellWidth - 10) / drawW, (cellHeight - 10) / drawH);
                const origW = embeddedPage.width * scale; const origH = embeddedPage.height * scale;

                const col = (i % pagesPerSheetVal) % cols;
                const row = Math.floor((i % pagesPerSheetVal) / cols);

                const cellX = col * cellWidth;
                const cellY = sheetHeight - ((row + 1) * cellHeight);
                const centerX = cellX + cellWidth / 2;
                const centerY = cellY + cellHeight / 2;

                if (isRotated) {
                    currentSheet.drawPage(embeddedPage, {
                        x: centerX + origH / 2, y: centerY - origW / 2, width: origW, height: origH, rotate: degrees(90)
                    });
                } else {
                    currentSheet.drawPage(embeddedPage, {
                        x: centerX - origW / 2, y: centerY - origH / 2, width: origW, height: origH
                    });
                }
            }

            const modifiedPdfBytes = await finalPdfDoc.save();
            fs.writeFileSync(filePath, modifiedPdfBytes);
        }

        // 3. JANGAN CETAK! KEMBALIKAN FILE KE USER SEBAGAI DOWNLOAD
        res.download(filePath, 'Simulasi_Print.pdf', (err) => {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath); // Bersihkan file temporary
        });

    } catch (error) {
        console.error(error);
        res.status(500).send("Gagal memproses simulasi.");
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