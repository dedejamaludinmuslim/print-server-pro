const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ptp = require('pdf-to-printer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument, degrees } = require('pdf-lib');
const { Server } = require("socket.io");
const http = require("http");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const port = 3000;

const APP_PIN = "4545"; // Ganti PIN Anda

app.use(cors());
app.use(express.static(__dirname));
const upload = multer({ dest: 'uploads/' });

function updateStatus(message, type = 'info') {
    io.emit('print-status', { message, type });
}

app.get('/ping', (req, res) => res.json({ status: 'PrintServerActive', hostname: os.hostname() }));
app.get('/printers', async (req, res) => {
    try { res.json(await ptp.getPrinters()); } catch (e) { res.status(500).send("Gagal"); }
});

async function processPdf(filePath, pagesInput, orientation, pps) {
    const bytes = fs.readFileSync(filePath);
    let pdfDoc = await PDFDocument.load(bytes);
    
    // Filter Halaman
    if (pagesInput) {
        const total = pdfDoc.getPageCount();
        let keep = [];
        pagesInput.split(',').forEach(p => {
            if(p.includes('-')) {
                let [s, e] = p.split('-').map(n => parseInt(n.trim()));
                for(let i=s; i<=e; i++) if(i<=total) keep.push(i-1);
            } else {
                let n = parseInt(p.trim());
                if(n<=total) keep.push(n-1);
            }
        });
        if(keep.length) {
            const newDoc = await PDFDocument.create();
            const copied = await newDoc.copyPages(pdfDoc, keep);
            copied.forEach(pg => newDoc.addPage(pg));
            pdfDoc = newDoc;
        }
    }

    // Grid N-Up & Rotasi
    if (orientation === 'landscape' || pps > 1) {
        const pages = pdfDoc.getPages();
        const final = await PDFDocument.create();
        let cols = pps > 1 ? (orientation === 'landscape' ? 2 : 1) : 1;
        let rows = Math.ceil(pps / cols);
        let sW = 595, sH = 842; if(orientation === 'landscape') [sW, sH] = [842, 595];
        
        let curPage;
        for(let i=0; i<pages.length; i++) {
            if(i % pps === 0) curPage = final.addPage([sW, sH]);
            const emb = await final.embedPage(pages[i]);
            let rot = (sW > sH && emb.width < emb.height) || (sW < sH && emb.width > emb.height);
            let dW = rot ? emb.height : emb.width, dH = rot ? emb.width : emb.height;
            const scale = Math.min((sW/cols-10)/dW, (sH/rows-10)/dH);
            
            const x = (i%pps%cols)*(sW/cols) + (sW/cols - dW*scale)/2;
            const y = sH - (Math.floor(i%pps/cols)+1)*(sH/rows) + (sH/rows - dH*scale)/2;

            curPage.drawPage(emb, { x: x + (rot?dH*scale:0), y, width: emb.width*scale, height: emb.height*scale, rotate: rot ? degrees(90) : degrees(0) });
        }
        pdfDoc = final;
    }

    fs.writeFileSync(filePath, await pdfDoc.save());
}

app.post('/print', upload.single('document'), async (req, res) => {
    let fPath = req.file ? req.file.path : '';
    if(req.body.pin !== APP_PIN) return res.status(401).send("PIN Salah!");

    try {
        updateStatus("Memproses...", "processing");
        await processPdf(fPath, req.body.pages, req.body.orientation, parseInt(req.body.pagesPerSheet));
        
        // --- PERBAIKAN FITUR JUMLAH COPY DAN UKURAN KERTAS ---
        const copies = parseInt(req.body.copies) || 1;
        let paperSize = req.body.paperSize || 'A4';
        if (paperSize === 'F4') paperSize = '210x330mm'; 

        const opts = { 
            printer: req.body.printerName, 
            monochrome: req.body.colorMode === 'monochrome',
            copies: copies,         // <-- Instruksi untuk mencetak rangkap
            paperSize: paperSize    // <-- Instruksi untuk ganti kertas (jika didukung printer)
        };

        updateStatus("Mencetak...", "printing");
        await ptp.print(fPath, opts);
        
        updateStatus("Sukses", "success");
        res.send("OK");
    } catch (e) {
        updateStatus("Gagal", "error");
        res.status(500).send(e.message);
    } finally {
        if(fPath && fs.existsSync(fPath)) fs.unlinkSync(fPath);
    }
});

server.listen(port, '0.0.0.0', () => console.log(`Print Server V4.5 Revised - Ready`));