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

const SUPPORTED_PPS = new Set([1, 2, 4, 6, 9, 16]);
const MAX_COPIES = 50;
const PAPER_DIMENSIONS = {
  A4: { portrait: { width: 595.28, height: 841.89 }, landscape: { width: 841.89, height: 595.28 } },
  F4: { portrait: { width: 595.28, height: 935.43 }, landscape: { width: 935.43, height: 595.28 } },
};
function getPaperSizeConfig(paperSize = 'A4', orientation = 'portrait') {
  const paper = PAPER_DIMENSIONS[paperSize] || PAPER_DIMENSIONS.A4;
  return paper[orientation] || paper.portrait;
}
function getGrid(pps = 1, orientation = 'portrait') {
  const safePps = SUPPORTED_PPS.has(pps) ? pps : 1;
  let cols = 1, rows = 1;
  if (safePps === 2) { cols = orientation === 'landscape' ? 2 : 1; rows = orientation === 'landscape' ? 1 : 2; }
  else if (safePps === 4) { cols = 2; rows = 2; }
  else if (safePps === 6) { cols = orientation === 'landscape' ? 3 : 2; rows = orientation === 'landscape' ? 2 : 3; }
  else if (safePps > 1) { cols = Math.ceil(Math.sqrt(safePps)); rows = Math.ceil(safePps / cols); }
  return { cols, rows, safePps };
}
function parsePagesInput(pagesInput, total) {
  if (!pagesInput || !String(pagesInput).trim()) return [];
  const keep = [];
  String(pagesInput).split(',').forEach(part => {
    const p = part.trim();
    if (!p) return;
    if (p.includes('-')) {
      let [s, e] = p.split('-').map(n => parseInt(n.trim(), 10));
      if (Number.isNaN(s) || Number.isNaN(e) || s < 1 || e < 1) return;
      if (s > e) [s, e] = [e, s];
      for (let i = s; i <= e; i += 1) if (i <= total) keep.push(i - 1);
    } else {
      const n = parseInt(p, 10);
      if (!Number.isNaN(n) && n > 0 && n <= total) keep.push(n - 1);
    }
  });
  return [...new Set(keep)].sort((a, b) => a - b);
}
function sanitizePrintOptions(body) {
  const orientation = body.orientation === 'landscape' ? 'landscape' : 'portrait';
  const paperSize = body.paperSize === 'F4' ? 'F4' : 'A4';
  const colorMode = body.colorMode === 'monochrome' ? 'monochrome' : 'color';
  const copies = Math.min(MAX_COPIES, Math.max(1, parseInt(body.copies, 10) || 1));
  const pagesPerSheetRaw = parseInt(body.pagesPerSheet, 10) || 1;
  const pagesPerSheet = SUPPORTED_PPS.has(pagesPerSheetRaw) ? pagesPerSheetRaw : 1;
  return { orientation, paperSize, colorMode, copies, pagesPerSheet, pages: String(body.pages || '').trim(), printerName: body.printerName || '' };
}

async function convertImageToPdf(imagePath, mimeType, originalName, paperSize, orientation) {
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
  const pageSize = getPaperSizeConfig(paperSize, orientation);
  const page = pdfDoc.addPage([pageSize.width, pageSize.height]);
  const shouldRotate = (pageSize.width > pageSize.height && image.width < image.height) || (pageSize.width < pageSize.height && image.width > image.height);
  const targetW = shouldRotate ? image.height : image.width;
  const targetH = shouldRotate ? image.width : image.height;
  const scale = Math.min((pageSize.width - 40) / targetW, (pageSize.height - 40) / targetH);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const centerX = pageSize.width / 2;
  const centerY = pageSize.height / 2;
  page.drawImage(image, {
    // pdf-lib rotates around the image's lower-left origin, so the x/y compensation
    // for 90deg rotation must differ from the non-rotated case to stay centered.
    x: shouldRotate ? centerX + drawH / 2 : centerX - drawW / 2,
    y: shouldRotate ? centerY - drawW / 2 : centerY - drawH / 2,
    width: drawW,
    height: drawH,
    rotate: shouldRotate ? degrees(90) : degrees(0),
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
    version: '4.5.7-imagefix',
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

async function processPdf(filePath, pagesInput, paperSize, orientation, pps) {
  const bytes = fs.readFileSync(filePath);
  let pdfDoc = await PDFDocument.load(bytes);
  const keep = parsePagesInput(pagesInput, pdfDoc.getPageCount());
  if (keep.length) {
    const newDoc = await PDFDocument.create();
    const copied = await newDoc.copyPages(pdfDoc, keep);
    copied.forEach(pg => newDoc.addPage(pg));
    pdfDoc = newDoc;
  }
  const { cols, rows, safePps } = getGrid(pps, orientation);
  const outputSize = getPaperSizeConfig(paperSize, orientation);
  const pages = pdfDoc.getPages();
  const final = await PDFDocument.create();
  const cellW = outputSize.width / cols;
  const cellH = outputSize.height / rows;
  let curPage;
  for (let i = 0; i < pages.length; i += 1) {
    if (i % safePps === 0) curPage = final.addPage([outputSize.width, outputSize.height]);
    const emb = await final.embedPage(pages[i]);
    const rot = (cellW > cellH && emb.width < emb.height) || (cellW < cellH && emb.width > emb.height);
    const dW = rot ? emb.height : emb.width;
    const dH = rot ? emb.width : emb.height;
    const scale = Math.min((cellW - 10) / dW, (cellH - 10) / dH);
    const x = (i % safePps % cols) * cellW + (cellW - dW * scale) / 2;
    const y = outputSize.height - (Math.floor(i % safePps / cols) + 1) * cellH + (cellH - dH * scale) / 2;
    curPage.drawPage(emb, {
      x: x + (rot ? dH * scale : 0),
      y,
      width: emb.width * scale,
      height: emb.height * scale,
      rotate: rot ? degrees(90) : degrees(0),
    });
  }
  fs.writeFileSync(filePath, await final.save());
}

app.post('/print', upload.single('document'), async (req, res) => {
  if (req.body.pin !== APP_PIN) return res.status(401).send('PIN Salah!');

  let fPath = req.file ? req.file.path : '';
  const mimeType = req.file ? req.file.mimetype : '';
  const originalName = req.file ? req.file.originalname : '';
  const options = sanitizePrintOptions(req.body);

  try {
    if (!fPath || !fs.existsSync(fPath)) throw new Error('File dokumen tidak ditemukan.');
    updateStatus('Memproses dokumen...', 'processing');

    if ((mimeType && mimeType.includes('image')) || /\.(jpg|jpeg|png)$/i.test(originalName)) {
      updateStatus('Menyesuaikan Gambar ke Kertas...', 'processing');
      fPath = await convertImageToPdf(fPath, mimeType, originalName, options.paperSize, options.orientation);
    }

    await processPdf(fPath, options.pages, options.paperSize, options.orientation, options.pagesPerSheet);

    const opts = {
      printer: options.printerName,
      monochrome: options.colorMode === 'monochrome',
      copies: options.copies,
      paperSize: options.paperSize === 'F4' ? '210x330mm' : 'A4',
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

server.listen(port, '0.0.0.0', () => console.log(`Print Server V4.5.7 Ready on ${port}`));
