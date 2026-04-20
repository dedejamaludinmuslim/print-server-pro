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
const port = parseInt(process.env.PORT || '3000', 10);
const APP_PIN = process.env.APP_PIN || '4545';
const DEFAULT_ALLOWED_ORIGINS = ['https://printer-upmp.vercel.app'];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

const corsOptionsDelegate = function (req, callback) {
  const origin = req.header('Origin');
  const corsOptions = {
    origin: isOriginAllowed(origin) ? origin || true : false,
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    optionsSuccessStatus: 204
  };
  callback(null, corsOptions);
};

app.use(cors(corsOptionsDelegate));
app.options(/.*/, cors(corsOptionsDelegate));
app.use((req, res, next) => {
  const origin = req.header('Origin');
  if (isOriginAllowed(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      callback(new Error('Origin not allowed by Socket.IO CORS'));
    },
    methods: ['GET', 'POST']
  }
});

app.use(express.static(__dirname));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir });

function getLocalIps() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return [...new Set(out)];
}

function updateStatus(message, type = 'info') {
  io.emit('print-status', { message, type });
}

async function convertImageToPdf(imagePath, mimeType, originalName, orientation, paperSize) {
  const imgBytes = fs.readFileSync(imagePath);
  const pdfDoc = await PDFDocument.create();
  let image;

  const isPng = (mimeType && mimeType.includes('png')) || (originalName && originalName.toLowerCase().endsWith('.png'));

  try {
    if (isPng) image = await pdfDoc.embedPng(imgBytes);
    else image = await pdfDoc.embedJpg(imgBytes);
  } catch (e) {
    try { image = await pdfDoc.embedJpg(imgBytes); }
    catch (e2) { image = await pdfDoc.embedPng(imgBytes); }
  }

  let pageW = 595.28, pageH = (paperSize === 'F4' ? 935.43 : 841.89);
  if (orientation === 'landscape') [pageW, pageH] = [pageH, pageW];
  const page = pdfDoc.addPage([pageW, pageH]);

  const scale = Math.min((pageW - 40) / image.width, (pageH - 40) / image.height);
  const scaledW = image.width * scale;
  const scaledH = image.height * scale;

  page.drawImage(image, {
    x: (pageW - scaledW) / 2,
    y: (pageH - scaledH) / 2,
    width: scaledW,
    height: scaledH
  });

  const pdfBytes = await pdfDoc.save();
  const newPdfPath = imagePath + '_converted.pdf';
  fs.writeFileSync(newPdfPath, pdfBytes);
  try { fs.unlinkSync(imagePath); } catch (e) {}
  return newPdfPath;
}

app.get('/ping', (req, res) => {
  const ips = getLocalIps();
  res.json({
    status: 'PrintServerActive',
    hostname: os.hostname(),
    ipHint: ips[0] || null,
    localIps: ips,
    port,
    allowedOrigins: ALLOWED_ORIGINS
  });
});

app.get('/connection-info', (req, res) => {
  res.json({
    hostname: os.hostname(),
    localIps: getLocalIps(),
    port,
    allowedOrigins: ALLOWED_ORIGINS
  });
});

app.get('/printers', async (req, res) => {
  try { res.json(await ptp.getPrinters()); }
  catch (e) { res.status(500).send('Gagal'); }
});

async function processPdf(filePath, pagesInput, orientation, pps, paperSize) {
  const bytes = fs.readFileSync(filePath);
  let pdfDoc = await PDFDocument.load(bytes);

  if (pagesInput) {
    const total = pdfDoc.getPageCount();
    const keepSet = new Set();
    pagesInput.split(',').forEach(p => {
      const raw = p.trim();
      if (!raw) return;
      if (raw.includes('-')) {
        let [s, e] = raw.split('-').map(n => parseInt(n.trim(), 10));
        if (Number.isFinite(s) && Number.isFinite(e)) {
          if (s > e) [s, e] = [e, s];
          for (let i = s; i <= e; i++) if (i >= 1 && i <= total) keepSet.add(i - 1);
        }
      } else {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n >= 1 && n <= total) keepSet.add(n - 1);
      }
    });
    const keep = [...keepSet].sort((a, b) => a - b);
    if (keep.length) {
      const newDoc = await PDFDocument.create();
      const copied = await newDoc.copyPages(pdfDoc, keep);
      copied.forEach(pg => newDoc.addPage(pg));
      pdfDoc = newDoc;
    }
  }

  if (orientation === 'landscape' || pps > 1 || paperSize === 'F4') {
    const pages = pdfDoc.getPages();
    const final = await PDFDocument.create();
    let sW = 595.28, sH = (paperSize === 'F4' ? 935.43 : 841.89);
    if (orientation === 'landscape') [sW, sH] = [sH, sW];

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
        rotate: rot ? degrees(90) : degrees(0)
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

    const orientation = req.body.orientation === 'landscape' ? 'landscape' : 'portrait';
    const paperSize = req.body.paperSize === 'F4' ? 'F4' : 'A4';
    const pagesPerSheet = Math.max(1, parseInt(req.body.pagesPerSheet, 10) || 1);

    updateStatus('Memproses dokumen...', 'processing');

    if (mimeType.includes('image') || /\.(jpg|jpeg|png)$/i.test(originalName)) {
      updateStatus('Menyesuaikan Gambar ke Kertas...', 'processing');
      fPath = await convertImageToPdf(fPath, mimeType, originalName, orientation, paperSize);
    }

    await processPdf(fPath, req.body.pages, orientation, pagesPerSheet, paperSize);

    const opts = {
      printer: req.body.printerName,
      monochrome: req.body.colorMode === 'monochrome',
      copies: parseInt(req.body.copies, 10) || 1,
      paperSize: paperSize === 'F4' ? '210x330mm' : 'A4'
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
      try { fs.unlinkSync(fPath); } catch (err) {}
    }
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Print Server V4.5.3 - Ready on port ${port}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`Local IPs: ${getLocalIps().join(', ')}`);
});
