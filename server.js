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
const PORT = parseInt(process.env.PORT || '3000', 10);
const APP_PIN = process.env.APP_PIN || '4545';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const REGISTRY_URL = (process.env.REGISTRY_URL || '').trim();
const HEARTBEAT_INTERVAL_MS = Math.max(15000, parseInt(process.env.HEARTBEAT_INTERVAL_MS || '30000', 10));
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim();
const SERVER_LABEL = (process.env.SERVER_LABEL || os.hostname()).trim();
const SERVER_TOKEN = (process.env.SERVER_TOKEN || '').trim();

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

app.use(cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Server-Token'],
}));
app.options('*', cors());
app.use(express.json());
app.use(express.static(__dirname));

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    }
  }
});

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

function updateStatus(message, type = 'info') {
  io.emit('print-status', { message, type });
}

function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const results = [];
  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) {
        results.push(item.address);
      }
    }
  }
  return [...new Set(results)];
}

function getPreferredIp() {
  return getLocalIps()[0] || '127.0.0.1';
}

function getAdvertisedBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req?.protocol || 'http';
  return `${proto}://${getPreferredIp()}:${PORT}`;
}

async function sendHeartbeat() {
  if (!REGISTRY_URL) return;
  try {
    const target = new URL('/api/heartbeat', REGISTRY_URL).toString();
    const payload = {
      label: SERVER_LABEL,
      hostname: os.hostname(),
      ip: getPreferredIp(),
      ips: getLocalIps(),
      port: PORT,
      pingUrl: `${getAdvertisedBaseUrl()}/ping`,
      printersUrl: `${getAdvertisedBaseUrl()}/printers`,
      lastSeenAt: new Date().toISOString(),
      token: SERVER_TOKEN || undefined,
    };
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.warn('Heartbeat gagal:', response.status, await response.text());
    }
  } catch (error) {
    console.warn('Heartbeat error:', error.message);
  }
}

async function convertImageToPdf(imagePath, mimeType, originalName, orientation) {
  const imgBytes = fs.readFileSync(imagePath);
  const pdfDoc = await PDFDocument.create();
  let image;

  const isPng = (mimeType && mimeType.includes('png')) || (originalName && originalName.toLowerCase().endsWith('.png'));

  try {
    if (isPng) image = await pdfDoc.embedPng(imgBytes);
    else image = await pdfDoc.embedJpg(imgBytes);
  } catch(e) {
    try { image = await pdfDoc.embedJpg(imgBytes); }
    catch(e2) { image = await pdfDoc.embedPng(imgBytes); }
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
    height: scaledH
  });

  const pdfBytes = await pdfDoc.save();
  const newPdfPath = imagePath + '_converted.pdf';
  fs.writeFileSync(newPdfPath, pdfBytes);

  try { fs.unlinkSync(imagePath); } catch(e){}
  return newPdfPath;
}

app.get('/ping', (req, res) => {
  res.json({
    status: 'PrintServerActive',
    hostname: os.hostname(),
    label: SERVER_LABEL,
    ipHint: getPreferredIp(),
    ips: getLocalIps(),
    port: PORT,
    registryEnabled: !!REGISTRY_URL,
    advertisedBaseUrl: getAdvertisedBaseUrl(req),
  });
});

app.get('/connection-info', (req, res) => {
  res.json({
    ok: true,
    label: SERVER_LABEL,
    hostname: os.hostname(),
    ipHint: getPreferredIp(),
    ips: getLocalIps(),
    port: PORT,
    pingUrl: `${getAdvertisedBaseUrl(req)}/ping`,
    printersUrl: `${getAdvertisedBaseUrl(req)}/printers`,
    registryUrl: REGISTRY_URL || null,
  });
});

app.get('/printers', async (req, res) => {
  try { res.json(await ptp.getPrinters()); } catch (e) { res.status(500).send('Gagal'); }
});

async function processPdf(filePath, pagesInput, orientation, pps) {
  const bytes = fs.readFileSync(filePath);
  let pdfDoc = await PDFDocument.load(bytes);

  if (pagesInput) {
    const total = pdfDoc.getPageCount();
    let keep = [];
    pagesInput.split(',').forEach(p => {
      if (p.includes('-')) {
        let [s, e] = p.split('-').map(n => parseInt(n.trim()));
        for (let i = s; i <= e; i++) if (i <= total) keep.push(i - 1);
      } else {
        let n = parseInt(p.trim());
        if (n <= total) keep.push(n - 1);
      }
    });
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
    let sW = 595.28, sH = 841.89;
    if (orientation === 'landscape') [sW, sH] = [841.89, 595.28];

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

    let cellW = sW / cols;
    let cellH = sH / rows;

    let curPage;
    for (let i = 0; i < pages.length; i++) {
      if (i % pps === 0) curPage = final.addPage([sW, sH]);
      const emb = await final.embedPage(pages[i]);
      let rot = (cellW > cellH && emb.width < emb.height) || (cellW < cellH && emb.width > emb.height);
      let dW = rot ? emb.height : emb.width;
      let dH = rot ? emb.width : emb.height;
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
  let mimeType = req.file ? req.file.mimetype : '';
  let originalName = req.file ? req.file.originalname : '';

  try {
    if (!fPath || !fs.existsSync(fPath)) throw new Error('File dokumen tidak ditemukan.');

    updateStatus('Memproses dokumen...', 'processing');

    if (mimeType.includes('image') || originalName.match(/\.(jpg|jpeg|png)$/i)) {
      updateStatus('Menyesuaikan Gambar ke Kertas...', 'processing');
      fPath = await convertImageToPdf(fPath, mimeType, originalName, req.body.orientation);
    }

    await processPdf(fPath, req.body.pages, req.body.orientation, parseInt(req.body.pagesPerSheet));

    const opts = {
      printer: req.body.printerName,
      monochrome: req.body.colorMode === 'monochrome',
      copies: parseInt(req.body.copies) || 1,
      paperSize: req.body.paperSize === 'F4' ? '210x330mm' : 'A4'
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

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Print Server V4.5.2 Heartbeat - Ready on ${PORT}`);
  if (REGISTRY_URL) {
    await sendHeartbeat();
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    console.log(`Heartbeat aktif ke: ${REGISTRY_URL}`);
  } else {
    console.log('Heartbeat nonaktif. Set REGISTRY_URL untuk registry pusat.');
  }
});
