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
const MAX_UPLOAD_MB = Math.min(500, Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '200', 10) || 200));
const LARGE_PDF_THRESHOLD_PAGES = Math.max(1, parseInt(process.env.LARGE_PDF_THRESHOLD_PAGES || '30', 10) || 30);
const LARGE_PDF_THRESHOLD_MB = Math.max(1, parseInt(process.env.LARGE_PDF_THRESHOLD_MB || '25', 10) || 25);
const LARGE_PDF_CHUNK_PAGES = Math.max(1, parseInt(process.env.LARGE_PDF_CHUNK_PAGES || '15', 10) || 15);
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
const upload = multer({ dest: uploadDir, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
const uploadDocument = upload.single('document');

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
const PREVIEW_PADDING_RATIO = 0.04; // sinkron dengan preview: 40px dari canvas tinggi 1000px
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

async function loadEmbeddedImage(pdfDoc, imagePath, mimeType, originalName) {
  const imgBytes = fs.readFileSync(imagePath);
  const isPng = (mimeType && mimeType.includes('png')) || (originalName && originalName.toLowerCase().endsWith('.png'));
  try {
    if (isPng) return await pdfDoc.embedPng(imgBytes);
    return await pdfDoc.embedJpg(imgBytes);
  } catch (e) {
    try { return await pdfDoc.embedJpg(imgBytes); }
    catch (_) { return await pdfDoc.embedPng(imgBytes); }
  }
}

function getCellPadding(outputSize, cellW, cellH) {
  const preferred = outputSize.height * PREVIEW_PADDING_RATIO;
  return Math.max(6, Math.min(preferred, cellW * 0.35, cellH * 0.35));
}

function drawImageInPdfCell(page, image, cellX, cellY, cellW, cellH, padding) {
  const shouldRotate = (cellW > cellH && image.width < image.height) || (cellW < cellH && image.width > image.height);
  const targetW = shouldRotate ? image.height : image.width;
  const targetH = shouldRotate ? image.width : image.height;
  const scale = Math.min((cellW - padding) / targetW, (cellH - padding) / targetH);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const centerX = cellX + cellW / 2;
  const centerY = cellY + cellH / 2;
  page.drawImage(image, {
    // Untuk rotasi 90°, pdf-lib memutar dari titik origin kiri-bawah.
    // Kompensasi ini membuat bounding box hasil rotasi tetap berada di tengah sel,
    // sama seperti preview canvas di frontend.
    x: shouldRotate ? centerX + drawH / 2 : centerX - drawW / 2,
    y: shouldRotate ? centerY - drawW / 2 : centerY - drawH / 2,
    width: drawW,
    height: drawH,
    rotate: shouldRotate ? degrees(90) : degrees(0),
  });
}

async function convertImageToPdf(imagePath, mimeType, originalName, paperSize, orientation, pps) {
  const pdfDoc = await PDFDocument.create();
  const image = await loadEmbeddedImage(pdfDoc, imagePath, mimeType, originalName);
  const outputSize = getPaperSizeConfig(paperSize, orientation);
  const { cols, rows } = getGrid(pps, orientation);
  const page = pdfDoc.addPage([outputSize.width, outputSize.height]);
  const cellW = outputSize.width / cols;
  const cellH = outputSize.height / rows;
  const padding = getCellPadding(outputSize, cellW, cellH);

  // Gambar tunggal ditempatkan langsung pada layout final.
  // Ini menghindari bug lama: gambar dibungkus jadi PDF full-page dulu,
  // lalu full-page PDF itu dikecilkan lagi pada mode Hal/Lembar.
  const cellX = 0;
  const cellY = outputSize.height - cellH;
  drawImageInPdfCell(page, image, cellX, cellY, cellW, cellH, padding);

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
    version: '4.5.7-syncfix',
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

app.get('/limits', (req, res) => {
  res.json({
    maxUploadMb: MAX_UPLOAD_MB,
    largePdfThresholdPages: LARGE_PDF_THRESHOLD_PAGES,
    largePdfThresholdMb: LARGE_PDF_THRESHOLD_MB,
    largePdfChunkPages: LARGE_PDF_CHUNK_PAGES,
    supportedFileTypes: ['pdf', 'png', 'jpg', 'jpeg'],
    version: '4.5.12',
  });
});

app.get('/printers', async (req, res) => {
  try {
    res.json(await ptp.getPrinters());
  } catch (e) {
    res.status(500).send('Gagal');
  }
});

function shouldProcessPdf(options) {
  // Untuk PDF panjang, jangan layout ulang bila pengaturan masih standar.
  // Ini mengurangi risiko gagal pada file puluhan/ratusan halaman.
  return Boolean(options.pages) || options.pagesPerSheet !== 1 || options.orientation !== 'portrait';
}

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
  const padding = getCellPadding(outputSize, cellW, cellH);
  let curPage;
  for (let i = 0; i < pages.length; i += 1) {
    if (i % safePps === 0) curPage = final.addPage([outputSize.width, outputSize.height]);
    const emb = await final.embedPage(pages[i]);
    const rot = (cellW > cellH && emb.width < emb.height) || (cellW < cellH && emb.width > emb.height);
    const dW = rot ? emb.height : emb.width;
    const dH = rot ? emb.width : emb.height;
    const scale = Math.min((cellW - padding) / dW, (cellH - padding) / dH);
    const x = (i % safePps % cols) * cellW + (cellW - dW * scale) / 2;
    const y = outputSize.height - (Math.floor(i % safePps / cols) + 1) * cellH + (cellH - dH * scale) / 2;
    curPage.drawPage(emb, {
      x: x + (rot ? dW * scale : 0),
      y,
      width: emb.width * scale,
      height: emb.height * scale,
      rotate: rot ? degrees(90) : degrees(0),
    });
  }
  fs.writeFileSync(filePath, await final.save());
}



async function getPdfPageCount(filePath) {
  const bytes = fs.readFileSync(filePath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return pdfDoc.getPageCount();
}

function getFileSizeMb(filePath) {
  try {
    return fs.statSync(filePath).size / (1024 * 1024);
  } catch (_) {
    return 0;
  }
}

async function splitPdfToChunkFiles(filePath, chunkSize) {
  const bytes = fs.readFileSync(filePath);
  const sourceDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const totalPages = sourceDoc.getPageCount();
  const chunks = [];

  for (let start = 0; start < totalPages; start += chunkSize) {
    const end = Math.min(start + chunkSize, totalPages);
    const outDoc = await PDFDocument.create();
    const indices = [];
    for (let i = start; i < end; i += 1) indices.push(i);
    const copied = await outDoc.copyPages(sourceDoc, indices);
    copied.forEach(page => outDoc.addPage(page));

    const outPath = `${filePath}_chunk_${start + 1}-${end}.pdf`;
    fs.writeFileSync(outPath, await outDoc.save());
    chunks.push({ path: outPath, start: start + 1, end, totalPages });
  }

  return chunks;
}

async function printPdfInChunks(filePath, opts, chunkSize) {
  const chunks = await splitPdfToChunkFiles(filePath, chunkSize);
  const cleanup = chunks.map(c => c.path);

  try {
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      updateStatus(
        `Mencetak bagian ${i + 1}/${chunks.length} halaman ${chunk.start}-${chunk.end} dari ${chunk.totalPages}...`,
        'printing'
      );
      await ptp.print(chunk.path, opts);
    }
  } finally {
    cleanup.forEach(p => {
      try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    });
  }
}

function preserveUploadedExtension(filePath, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const allowed = new Set(['.pdf', '.png', '.jpg', '.jpeg']);
  if (!filePath || !fs.existsSync(filePath) || !allowed.has(ext)) return filePath;
  if (path.extname(filePath).toLowerCase() === ext) return filePath;
  const target = `${filePath}${ext}`;
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch (_) {
    try {
      fs.copyFileSync(filePath, target);
      fs.unlinkSync(filePath);
      return target;
    } catch (_) {
      return filePath;
    }
  }
}

app.post('/print',
  (req, res, next) => {
    uploadDocument(req, res, (err) => {
      if (!err) return next();
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `Ukuran file melebihi batas ${MAX_UPLOAD_MB} MB. Kompres file atau naikkan MAX_UPLOAD_MB di environment.`
        : `Upload gagal: ${err.message}`;
      updateStatus(`Gagal: ${message}`, 'error');
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).send(message);
    });
  },
  async (req, res) => {
  if (req.body.pin !== APP_PIN) return res.status(401).send('PIN Salah!');

  let fPath = req.file ? req.file.path : '';
  const mimeType = req.file ? req.file.mimetype : '';
  const originalName = req.file ? req.file.originalname : '';
  const options = sanitizePrintOptions(req.body);
  fPath = preserveUploadedExtension(fPath, originalName);

  try {
    if (!fPath || !fs.existsSync(fPath)) throw new Error('File dokumen tidak ditemukan.');
    updateStatus('Memproses dokumen...', 'processing');

    const isImageFile = (mimeType && mimeType.includes('image')) || /\.(jpg|jpeg|png)$/i.test(originalName);
    const isPdfFile = (mimeType && mimeType.includes('pdf')) || /\.pdf$/i.test(originalName) || /\.pdf$/i.test(fPath);
    let pdfPageCount = 0;
    let pdfSizeMb = getFileSizeMb(fPath);
    let shouldChunkPdf = false;

    if (isImageFile) {
      updateStatus('Menyesuaikan Gambar ke Kertas...', 'processing');
      fPath = await convertImageToPdf(fPath, mimeType, originalName, options.paperSize, options.orientation, options.pagesPerSheet);
    } else if (isPdfFile && shouldProcessPdf(options)) {
      await processPdf(fPath, options.pages, options.paperSize, options.orientation, options.pagesPerSheet);
      pdfPageCount = await getPdfPageCount(fPath);
      pdfSizeMb = getFileSizeMb(fPath);
      shouldChunkPdf = pdfPageCount >= LARGE_PDF_THRESHOLD_PAGES || pdfSizeMb >= LARGE_PDF_THRESHOLD_MB;
    } else if (isPdfFile) {
      pdfPageCount = await getPdfPageCount(fPath);
      pdfSizeMb = getFileSizeMb(fPath);
      shouldChunkPdf = pdfPageCount >= LARGE_PDF_THRESHOLD_PAGES || pdfSizeMb >= LARGE_PDF_THRESHOLD_MB;
      updateStatus(`PDF asli: ${pdfPageCount} halaman, ${pdfSizeMb.toFixed(1)} MB. ${shouldChunkPdf ? 'Akan dicetak per bagian.' : 'Akan dikirim langsung.'}`, 'processing');
    } else {
      throw new Error('Format file tidak didukung. Gunakan PDF, JPG, JPEG, atau PNG.');
    }

    const opts = {
      printer: options.printerName,
      monochrome: options.colorMode === 'monochrome',
      copies: options.copies,
      paperSize: options.paperSize === 'F4' ? '210x330mm' : 'A4',
      scale: 'shrink',
    };

    if (isPdfFile && shouldChunkPdf) {
      updateStatus(`PDF besar terdeteksi. Mencetak per ${LARGE_PDF_CHUNK_PAGES} halaman agar spooler/printer lebih stabil...`, 'printing');
      await printPdfInChunks(fPath, opts, LARGE_PDF_CHUNK_PAGES);
    } else {
      updateStatus('Mencetak ke mesin fisik...', 'printing');
      await ptp.print(fPath, opts);
    }
    updateStatus('Cetak Sukses!', 'success');
    res.send('OK');
  } catch (e) {
    console.error('[PRINT ERROR]', e);
    updateStatus(`Gagal: ${e.message}`, 'error');
    res.status(500).send(`PRINT_FAILED: ${e.message}`);
  } finally {
    if (fPath && fs.existsSync(fPath)) {
      try { fs.unlinkSync(fPath); } catch (_) {}
    }
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.listen(port, '0.0.0.0', () => console.log(`Print Server V4.5.12 Ready on ${port}`));
