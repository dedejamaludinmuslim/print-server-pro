const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ptp = require('pdf-to-printer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument, degrees } = require('pdf-lib');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const port = 3000;
const APP_PIN = process.env.APP_PIN || '4545';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://printer-upmp.vercel.app,http://127.0.0.1:5500,http://localhost:5500')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With'],
  credentials: false,
  optionsSuccessStatus: 204,
};

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
  },
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    if (origin) res.header('Access-Control-Allow-Origin', origin);
    else res.header('Access-Control-Allow-Origin', '*');
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    if (req.headers['access-control-request-private-network'] === 'true') {
      res.header('Access-Control-Allow-Private-Network', 'true');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(cors(corsOptions));
app.use(express.static(__dirname));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir, limits: { fileSize: 25 * 1024 * 1024 } });

function getLocalIpList() {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.values(nets).forEach(entries => {
    (entries || []).forEach(net => {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    });
  });
  return [...new Set(ips)];
}

function updateStatus(message, type = 'info') {
  io.emit('print-status', { message, type });
}

async function convertImageToPdf(imagePath, mimeType, originalName, orientation) {
  const imgBytes = fs.readFileSync(imagePath);
  const pdfDoc = await PDFDocument.create();
  let image;

  const isPng = (mimeType && mimeType.includes('png')) || (originalName && originalName.toLowerCase().endsWith('.png'));

  try {
    if (isPng) image = await pdfDoc.embedPng(imgBytes);
    else image = await pdfDoc.embedJpg(imgBytes);
  } catch (e) {
    try { image = await pdfDoc.embedJpg(imgBytes); }
    catch (_) { image = await pdfDoc.embedPng(imgBytes); }
  }

  let a4W = 595.28, a4H = 841.89;
  if (orientation === 'landscape') {
    a4W = 841.89;
    a4H = 595.28;
  }
  const page = pdfDoc.addPage([a4W, a4H]);
  const scale = Math.min((a4W - 40) / image.width, (a4H - 40) / image.height);
  const scaledW = image.width * scale;
  const scaledH = image.height * scale;

  page.drawImage(image, {
    x: (a4W - scaledW) / 2,
    y: (a4H - scaledH) / 2,
    width: scaledW,
    height: scaledH,
  });

  const pdfBytes = await pdfDoc.save();
  const newPdfPath = imagePath + '_converted.pdf';
  fs.writeFileSync(newPdfPath, pdfBytes);
  try { fs.unlinkSync(imagePath); } catch (_) {}
  return newPdfPath;
}

app.get('/ping', (req, res) => {
  const localIps = getLocalIpList();
  res.json({
    status: 'PrintServerActive',
    hostname: os.hostname(),
    ipHint: localIps[0] || '',
    localIps,
    version: '4.5.5',
  });
});

app.get('/connection-info', (req, res) => {
  res.json({
    hostname: os.hostname(),
    localIps: getLocalIpList(),
    allowedOrigins,
    port,
  });
});

app.get('/printers', async (req, res) => {
  try {
    res.json(await ptp.getPrinters());
  } catch (e) {
    res.status(500).send('Gagal');
  }
});

async function processPdf(filePath, pagesInput, orientation, pps) {
  const bytes = fs.readFileSync(filePath);
  let pdfDoc = await PDFDocument.load(bytes);

  if (pagesInput) {
    const total = pdfDoc.getPageCount();
    let keep = [];
    pagesInput.split(',').forEach(p => {
      if (p.includes('-')) {
        let [s, e] = p.split('-').map(n => parseInt(n.trim(), 10));
        if (Number.isNaN(s) || Number.isNaN(e)) return;
        if (s > e) [s, e] = [e, s];
        for (let i = s; i <= e; i++) if (i > 0 && i <= total) keep.push(i - 1);
      } else {
        let n = parseInt(p.trim(), 10);
        if (!Number.isNaN(n) && n > 0 && n <= total) keep.push(n - 1);
      }
    });
    keep = [...new Set(keep)];
    if (keep.length) {
      const newDoc = await PDFDocument.create();
      const copied = await newDoc.copyPages(pdfDoc, keep);
      copied.forEach(pg => newDoc.addPage(pg));
      pdfDoc = newDoc;
    }
  }

  if (orientation === 'landscape' || pps > 1) {
    const pages = pdfDoc.getPages();
    const final = await PDFDocument.create();
    let sW = 595.28, sH = 841.89; if (orientation === 'landscape') [sW, sH] = [841.89, 595.28];

    let cols = 1, rows = 1;
    if (pps === 2) {
      cols = orientation === 'landscape' ? 2 : 1;
      rows = orientation === 'landscape' ? 1 : 2;
    } else if (pps === 4) {
      cols = 2; rows = 2;
    } else if (pps === 6) {
      cols = orientation === 'landscape' ? 3 : 2;
      rows = orientation === 'landscape' ? 2 : 3;
    } else if (pps > 1) {
      cols = Math.ceil(Math.sqrt(pps));
      rows = Math.ceil(pps / cols);
    }

    const cellW = sW / cols;
    const cellH = sH / rows;
    let curPage;
    for (let i = 0; i < pages.length; i++) {
      if (i % pps === 0) curPage = final.addPage([sW, sH]);
      const emb = await final.embedPage(pages[i]);
      const rot = (cellW > cellH && emb.width < emb.height) || (cellW < cellH && emb.width > emb.height);
      const dW = rot ? emb.height : emb.width;
      const dH = rot ? emb.width : emb.height;
      const scale = Math.min((cellW - 10) / dW, (cellH - 10) / dH);
      const x = (i % pps % cols) * cellW + (cellW - dW * scale) / 2;
      const y = sH - (Math.floor(i % pps / cols) + 1) * cellH + (cellH - dH * scale) / 2;

      curPage.drawPage(emb, {
        x: x + (rot ? dH * scale : 0),
        y,
        width: emb.width * scale,
        height: emb.height * scale,
        rotate: rot ? degrees(90) : degrees(0),
      });
    }
    pdfDoc = final;
  }
  fs.writeFileSync(filePath, await pdfDoc.save());
}

app.post('/print', upload.single('document'), async (req, res) => {
  if (req.body.pin !== APP_PIN) return res.status(401).send('PIN Salah!');

  let fPath = req.file ? req.file.path : '';
  const mimeType = req.file ? req.file.mimetype : '';
  const originalName = req.file ? req.file.originalname : '';

  try {
    if (!fPath || !fs.existsSync(fPath)) throw new Error('File dokumen tidak ditemukan.');
    updateStatus('Memproses dokumen...', 'processing');

    if ((mimeType && mimeType.includes('image')) || /\.(jpg|jpeg|png)$/i.test(originalName)) {
      updateStatus('Menyesuaikan Gambar ke Kertas...', 'processing');
      fPath = await convertImageToPdf(fPath, mimeType, originalName, req.body.orientation);
    }

    await processPdf(fPath, req.body.pages, req.body.orientation, parseInt(req.body.pagesPerSheet, 10) || 1);

    const opts = {
      printer: req.body.printerName,
      monochrome: req.body.colorMode === 'monochrome',
      copies: parseInt(req.body.copies, 10) || 1,
      paperSize: req.body.paperSize === 'F4' ? '210x330mm' : 'A4',
    };

    updateStatus('Mencetak ke mesin fisik...', 'printing');
    await ptp.print(fPath, opts);
    updateStatus('Cetak Sukses!', 'success');
    res.send('OK');
  } catch (e) {
    updateStatus(`Gagal: ${e.message}`, 'error');
    res.status(500).send(e.message);
  } finally {
    if (fPath && fs.existsSync(fPath)) {
      try { fs.unlinkSync(fPath); } catch (_) {}
    }
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Print Server V4.5.5 Ready on ${port}`));
