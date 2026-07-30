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
const PREVIEW_PADDING_RATIO = 0.04;
const PAPER_DIMENSIONS = {
  A4: { width: 595.28, height: 841.89 },
  F4: { width: 595.28, height: 935.43 },
  LETTER: { width: 612, height: 792 },
  LEGAL: { width: 612, height: 1008 },
};

function normalizeDimensions(width, height) {
  return width <= height ? { width, height } : { width: height, height: width };
}
function detectStandardPaper(width, height) {
  const n = normalizeDimensions(width, height);
  let best = 'A4';
  let bestError = Infinity;
  Object.entries(PAPER_DIMENSIONS).forEach(([key, dim]) => {
    const error = Math.abs(n.width - dim.width) + Math.abs(n.height - dim.height);
    if (error < bestError) { best = key; bestError = error; }
  });
  return bestError <= 30 ? best : 'CUSTOM';
}
function resolveOrientation(requested, sourceWidth, sourceHeight, pps) {
  if (requested === 'portrait' || requested === 'landscape') return requested;
  if (pps === 2 || pps === 6) return 'landscape';
  return sourceWidth > sourceHeight ? 'landscape' : 'portrait';
}
function resolvePaperSize(paperSize, orientation, sourceWidth, sourceHeight, sourceStandard) {
  let base;
  let resolvedKey = paperSize;
  if (paperSize === 'SOURCE') {
    if (sourceStandard && PAPER_DIMENSIONS[sourceStandard]) {
      resolvedKey = sourceStandard;
      base = PAPER_DIMENSIONS[sourceStandard];
    } else if (sourceWidth && sourceHeight) {
      const n = normalizeDimensions(sourceWidth, sourceHeight);
      base = { width: n.width, height: n.height };
      resolvedKey = 'CUSTOM';
    } else {
      resolvedKey = 'A4';
      base = PAPER_DIMENSIONS.A4;
    }
  } else {
    resolvedKey = PAPER_DIMENSIONS[paperSize] ? paperSize : 'A4';
    base = PAPER_DIMENSIONS[resolvedKey];
  }
  const dimensions = orientation === 'landscape'
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height };
  return { ...dimensions, key: resolvedKey };
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
function getEffectiveScaleMode(scaleMode, pps) {
  if ((scaleMode === 'actual' || scaleMode === 'fill') && pps > 1) return 'shrink';
  return ['fit', 'shrink', 'actual', 'fill'].includes(scaleMode) ? scaleMode : 'shrink';
}
function computePlacement(sourceWidth, sourceHeight, cellWidth, cellHeight, padding, scaleMode, allowRotate = true) {
  const rotate = allowRotate && ((cellWidth > cellHeight && sourceWidth < sourceHeight) || (cellWidth < cellHeight && sourceWidth > sourceHeight));
  const placedSourceW = rotate ? sourceHeight : sourceWidth;
  const placedSourceH = rotate ? sourceWidth : sourceHeight;
  const availableW = Math.max(1, cellWidth - padding);
  const availableH = Math.max(1, cellHeight - padding);
  const fitScale = Math.min(availableW / placedSourceW, availableH / placedSourceH);
  const fillScale = Math.max(availableW / placedSourceW, availableH / placedSourceH);
  let scale = fitScale;
  if (scaleMode === 'shrink') scale = Math.min(1, fitScale);
  else if (scaleMode === 'actual') scale = 1;
  else if (scaleMode === 'fill') scale = fillScale;
  return { rotate, scale, width: placedSourceW * scale, height: placedSourceH * scale };
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
  const orientation = ['auto', 'portrait', 'landscape'].includes(body.orientation) ? body.orientation : 'auto';
  const paperSize = ['SOURCE', 'A4', 'F4', 'LETTER', 'LEGAL'].includes(body.paperSize) ? body.paperSize : 'SOURCE';
  const scaleMode = ['fit', 'shrink', 'actual', 'fill'].includes(body.scaleMode) ? body.scaleMode : 'shrink';
  const colorMode = body.colorMode === 'monochrome' ? 'monochrome' : 'color';
  const copies = Math.min(MAX_COPIES, Math.max(1, parseInt(body.copies, 10) || 1));
  const pagesPerSheetRaw = parseInt(body.pagesPerSheet, 10) || 1;
  const pagesPerSheet = SUPPORTED_PPS.has(pagesPerSheetRaw) ? pagesPerSheetRaw : 1;
  return {
    orientation,
    paperSize,
    scaleMode,
    colorMode,
    copies,
    pagesPerSheet,
    pages: String(body.pages || '').trim(),
    printerName: body.printerName || ''
  };
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

function drawImageInPdfCell(page, image, cellX, cellY, cellW, cellH, padding, scaleMode) {
  const sourceWPt = image.width * 72 / 96;
  const sourceHPt = image.height * 72 / 96;
  const placement = computePlacement(sourceWPt, sourceHPt, cellW, cellH, padding, scaleMode, true);
  const centerX = cellX + cellW / 2;
  const centerY = cellY + cellH / 2;
  const rawDrawW = image.width * 72 / 96 * placement.scale;
  const rawDrawH = image.height * 72 / 96 * placement.scale;
  page.drawImage(image, {
    x: placement.rotate ? centerX + rawDrawH / 2 : centerX - rawDrawW / 2,
    y: placement.rotate ? centerY - rawDrawW / 2 : centerY - rawDrawH / 2,
    width: rawDrawW,
    height: rawDrawH,
    rotate: placement.rotate ? degrees(90) : degrees(0),
  });
}

async function convertImageToPdf(imagePath, mimeType, originalName, options) {
  const pdfDoc = await PDFDocument.create();
  const image = await loadEmbeddedImage(pdfDoc, imagePath, mimeType, originalName);
  const sourceWPt = image.width * 72 / 96;
  const sourceHPt = image.height * 72 / 96;
  const resolvedOrientation = resolveOrientation(options.orientation, sourceWPt, sourceHPt, options.pagesPerSheet);
  const outputSize = resolvePaperSize(
    options.paperSize,
    resolvedOrientation,
    sourceWPt,
    sourceHPt,
    options.paperSize === 'SOURCE' ? 'A4' : options.paperSize
  );
  const scaleMode = getEffectiveScaleMode(options.scaleMode, options.pagesPerSheet);
  const { cols, rows } = getGrid(options.pagesPerSheet, resolvedOrientation);
  const page = pdfDoc.addPage([outputSize.width, outputSize.height]);
  const cellW = outputSize.width / cols;
  const cellH = outputSize.height / rows;
  const padding = getCellPadding(outputSize, cellW, cellH);
  drawImageInPdfCell(page, image, 0, outputSize.height - cellH, cellW, cellH, padding, scaleMode);

  const pdfBytes = await pdfDoc.save();
  const newPdfPath = imagePath + '_converted.pdf';
  fs.writeFileSync(newPdfPath, pdfBytes);
  try { fs.unlinkSync(imagePath); } catch (_) {}
  return { filePath: newPdfPath, outputPaperKey: outputSize.key, resolvedOrientation };
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
    version: '4.5.13',
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
  return Boolean(options.pages)
    || options.pagesPerSheet !== 1
    || options.orientation !== 'auto'
    || options.paperSize !== 'SOURCE'
    || options.scaleMode !== 'shrink';
}

async function processPdf(filePath, options) {
  const bytes = fs.readFileSync(filePath);
  let pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const keep = parsePagesInput(options.pages, pdfDoc.getPageCount());
  if (keep.length) {
    const newDoc = await PDFDocument.create();
    const copied = await newDoc.copyPages(pdfDoc, keep);
    copied.forEach(pg => newDoc.addPage(pg));
    pdfDoc = newDoc;
  }

  const pages = pdfDoc.getPages();
  if (!pages.length) throw new Error('PDF tidak memiliki halaman.');
  const first = pages[0];
  const firstSize = first.getSize();
  const sourceStandard = detectStandardPaper(firstSize.width, firstSize.height);
  const resolvedOrientation = resolveOrientation(options.orientation, firstSize.width, firstSize.height, options.pagesPerSheet);
  const outputSize = resolvePaperSize(options.paperSize, resolvedOrientation, firstSize.width, firstSize.height, sourceStandard);
  const scaleMode = getEffectiveScaleMode(options.scaleMode, options.pagesPerSheet);
  const { cols, rows, safePps } = getGrid(options.pagesPerSheet, resolvedOrientation);

  const final = await PDFDocument.create();
  const cellW = outputSize.width / cols;
  const cellH = outputSize.height / rows;
  const padding = getCellPadding(outputSize, cellW, cellH);
  let curPage;

  for (let i = 0; i < pages.length; i += 1) {
    if (i % safePps === 0) curPage = final.addPage([outputSize.width, outputSize.height]);
    const emb = await final.embedPage(pages[i]);
    const placement = computePlacement(emb.width, emb.height, cellW, cellH, padding, scaleMode, true);
    const slot = i % safePps;
    const cellX = (slot % cols) * cellW;
    const cellY = outputSize.height - (Math.floor(slot / cols) + 1) * cellH;
    const x = cellX + (cellW - placement.width) / 2;
    const y = cellY + (cellH - placement.height) / 2;

    curPage.drawPage(emb, {
      x: x + (placement.rotate ? emb.height * placement.scale : 0),
      y,
      width: emb.width * placement.scale,
      height: emb.height * placement.scale,
      rotate: placement.rotate ? degrees(90) : degrees(0),
    });
  }

  fs.writeFileSync(filePath, await final.save());
  return { outputPaperKey: outputSize.key, resolvedOrientation };
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
    let outputPaperKey = options.paperSize === 'SOURCE' ? 'A4' : options.paperSize;

    if (isImageFile) {
      updateStatus('Menyesuaikan Gambar ke Kertas...', 'processing');
      const imageResult = await convertImageToPdf(fPath, mimeType, originalName, options);
      fPath = imageResult.filePath;
      outputPaperKey = imageResult.outputPaperKey;
    } else if (isPdfFile && shouldProcessPdf(options)) {
      const pdfResult = await processPdf(fPath, options);
      outputPaperKey = pdfResult.outputPaperKey;
      pdfPageCount = await getPdfPageCount(fPath);
      pdfSizeMb = getFileSizeMb(fPath);
      shouldChunkPdf = pdfPageCount >= LARGE_PDF_THRESHOLD_PAGES || pdfSizeMb >= LARGE_PDF_THRESHOLD_MB;
    } else if (isPdfFile) {
      const sourceBytes = fs.readFileSync(fPath);
      const sourcePdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
      pdfPageCount = sourcePdf.getPageCount();
      const firstSize = sourcePdf.getPage(0).getSize();
      const detected = detectStandardPaper(firstSize.width, firstSize.height);
      outputPaperKey = detected === 'CUSTOM' ? 'A4' : detected;
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
      paperSize: outputPaperKey === 'F4'
        ? '210x330mm'
        : outputPaperKey === 'LETTER'
          ? 'Letter'
          : outputPaperKey === 'LEGAL'
            ? 'Legal'
            : 'A4',
      // Layout/skala sudah dibentuk di PDF final; driver hanya mengecilkan bila area printable lebih sempit.
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

server.listen(port, '0.0.0.0', () => console.log(`Print Server V4.5.13 Ready on ${port}`));
