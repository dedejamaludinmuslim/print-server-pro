const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ptp = require('pdf-to-printer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument, degrees, rgb, StandardFonts } = require('pdf-lib');
const { Server } = require('socket.io');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
let Bonjour = null;
let QRCode = null;
try { ({ Bonjour } = require('bonjour-service')); } catch (_) {}
try { QRCode = require('qrcode'); } catch (_) {}

const app = express();
const server = http.createServer(app);
const port = 3000;
const APP_PIN = process.env.APP_PIN || '4545';
const MAX_UPLOAD_MB = Math.min(500, Math.max(1, parseInt(process.env.MAX_UPLOAD_MB || '200', 10) || 200));
const LARGE_PDF_THRESHOLD_PAGES = Math.max(1, parseInt(process.env.LARGE_PDF_THRESHOLD_PAGES || '30', 10) || 30);
const LARGE_PDF_THRESHOLD_MB = Math.max(1, parseInt(process.env.LARGE_PDF_THRESHOLD_MB || '25', 10) || 25);
const LARGE_PDF_CHUNK_PAGES = Math.max(1, parseInt(process.env.LARGE_PDF_CHUNK_PAGES || '15', 10) || 15);
const DOCX_CONVERT_TIMEOUT_MS = Math.max(30000, parseInt(process.env.DOCX_CONVERT_TIMEOUT_MS || '180000', 10) || 180000);
const LIBREOFFICE_PATH = process.env.LIBREOFFICE_PATH || '';
const WORD_CONVERT_TIMEOUT_MS = Math.max(30000, parseInt(process.env.WORD_CONVERT_TIMEOUT_MS || '180000', 10) || 180000);
const WORD_CONVERTER_ENABLED = String(process.env.WORD_CONVERTER_ENABLED || 'true').toLowerCase() !== 'false';
const PRINTER_CAPABILITY_CACHE_MS = Math.max(5000, parseInt(process.env.PRINTER_CAPABILITY_CACHE_MS || '60000', 10) || 60000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://print-server-pro.vercel.app,https://dedejamaludinmuslim.github.io,http://127.0.0.1:5500,http://localhost:5500')
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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
const uploadDocument = upload.single('document');

function getLocalIpList() {
  return getLocalInterfaceDetails().map(item => item.address);
}

function getLocalInterfaceDetails() {
  let nets = {};
  try { nets = os.networkInterfaces() || {}; }
  catch (_) { return []; }
  const interfaces = [];
  Object.entries(nets).forEach(([name, entries]) => {
    (entries || []).forEach(net => {
      if (net.family !== 'IPv4' || net.internal) return;
      const prefix = String(net.address || '').split('.').slice(0, 3).join('.');
      interfaces.push({
        name,
        address: net.address,
        netmask: net.netmask || '',
        cidr: net.cidr || '',
        mac: net.mac || '',
        scanPrefix: /^\d{1,3}(?:\.\d{1,3}){2}$/.test(prefix) ? prefix : '',
      });
    });
  });
  return interfaces.filter((item,index,list)=>list.findIndex(other=>other.address===item.address)===index);
}

function connectionInfoPayload() {
  const interfaces = getLocalInterfaceDetails();
  const localIps = interfaces.map(item => item.address);
  const hostname = os.hostname();
  const urls = localIps.map(ip => `http://${ip}:${port}/?server=${encodeURIComponent(ip)}`);
  return {
    hostname,
    localIps,
    interfaces,
    hostnames: [`${hostname}.local`, hostname],
    urls,
    recommendedUrl: urls[0] || `http://localhost:${port}`,
    allowedOrigins,
    port,
    discovery: { mdns: Boolean(Bonjour), qr: Boolean(QRCode), service: '_printserverpro._tcp.local' },
    version: '4.6.8',
  };
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
  return ['fit', 'shrink', 'actual', 'custom', 'fill'].includes(scaleMode) ? scaleMode : 'shrink';
}
function computePlacement(sourceWidth, sourceHeight, cellWidth, cellHeight, padding, scaleMode, allowRotate = true, customScalePercent = 100) {
  const rotate=allowRotate&&((cellWidth>cellHeight&&sourceWidth<sourceHeight)||(cellWidth<cellHeight&&sourceWidth>sourceHeight));
  const placedSourceW=rotate?sourceHeight:sourceWidth, placedSourceH=rotate?sourceWidth:sourceHeight;
  const availableW=Math.max(1,cellWidth-padding), availableH=Math.max(1,cellHeight-padding);
  const fitScale=Math.min(availableW/placedSourceW,availableH/placedSourceH), fillScale=Math.max(availableW/placedSourceW,availableH/placedSourceH);
  let scale=fitScale; if(scaleMode==='shrink')scale=Math.min(1,fitScale); else if(scaleMode==='actual')scale=1; else if(scaleMode==='custom')scale=Math.max(.1,Math.min(4,Number(customScalePercent||100)/100)); else if(scaleMode==='fill')scale=fillScale;
  return {rotate,scale,width:placedSourceW*scale,height:placedSourceH*scale};
}
function marginModeToPoints(options){
  const mmToPt=72/25.4, presets={none:{top:0,right:0,bottom:0,left:0},narrow:{top:6.35,right:6.35,bottom:6.35,left:6.35},normal:{top:12.7,right:12.7,bottom:12.7,left:12.7},wide:{top:25.4,right:25.4,bottom:25.4,left:25.4}};
  const mm=options.marginMode==='custom'?{top:options.marginTop,right:options.marginRight,bottom:options.marginBottom,left:options.marginLeft}:(presets[options.marginMode]||presets.none);
  return {top:mm.top*mmToPt,right:mm.right*mmToPt,bottom:mm.bottom*mmToPt,left:mm.left*mmToPt};
}
function getSlotPosition(slot,cols,rows,order){ if(order==='column-ttb')return{col:Math.floor(slot/rows),row:slot%rows}; if(order==='row-rtl')return{col:cols-1-(slot%cols),row:Math.floor(slot/cols)}; return{col:slot%cols,row:Math.floor(slot/cols)}; }
function makeBookletSequence(indices){ const seq=[...indices]; while(seq.length%4!==0)seq.push(null); const out=[]; let left=0,right=seq.length-1; while(left<right){out.push(seq[right],seq[left]);left++;right--;out.push(seq[left],seq[right]);left++;right--;} return out; }
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
  const scaleMode = ['fit', 'shrink', 'actual', 'custom', 'fill'].includes(body.scaleMode) ? body.scaleMode : 'shrink';
  const customScale = Math.min(400, Math.max(10, parseFloat(body.customScale) || 100));
  const colorMode = body.colorMode === 'monochrome' ? 'monochrome' : 'color';
  const copies = Math.min(MAX_COPIES, Math.max(1, parseInt(body.copies, 10) || 1));
  const pagesPerSheetRaw = parseInt(body.pagesPerSheet, 10) || 1;
  const pagesPerSheet = SUPPORTED_PPS.has(pagesPerSheetRaw) ? pagesPerSheetRaw : 1;
  const requestedDuplexMode = ['simplex','duplexlong','duplexshort','manual-long','manual-short'].includes(body.duplexMode) ? body.duplexMode : 'simplex';
  const duplexMode = requestedDuplexMode.startsWith('manual-') ? 'simplex' : requestedDuplexMode;
  const pageSubset = ['all', 'odd', 'even'].includes(body.pageSubset) ? body.pageSubset : 'all';
  const pageOrder = body.pageOrder === 'reverse' ? 'reverse' : 'normal';
  let collate = body.collateMode !== 'uncollated';
  if (duplexMode !== 'simplex') collate = true;
  const marginMode=['none','narrow','normal','wide','custom'].includes(body.marginMode)?body.marginMode:'none';
  const clampMargin=v=>Math.min(80,Math.max(0,parseFloat(v)||0));
  const marginTop=clampMargin(body.marginTop),marginRight=clampMargin(body.marginRight),marginBottom=clampMargin(body.marginBottom),marginLeft=clampMargin(body.marginLeft);
  const autoRotate=body.autoRotateMode!=='off';
  const contentAlign=body.contentAlign==='top-left'?'top-left':'center';
  const nupBorder=['none','thin','medium'].includes(body.nupBorder)?body.nupBorder:'none';
  const nupOrder=['row-ltr','column-ttb','row-rtl'].includes(body.nupOrder)?body.nupOrder:'row-ltr';
  const booklet=body.bookletMode==='on';
  const poster=body.posterMode==='on';
  const posterCols=Math.min(6,Math.max(1,parseInt(body.posterCols,10)||2)),posterRows=Math.min(6,Math.max(1,parseInt(body.posterRows,10)||2));
  const posterOverlap=Math.min(30,Math.max(0,parseFloat(body.posterOverlap)||0)),posterCutMarks=body.posterCutMarks==='on';
  const transformMode=['none','mirror-h','flip-v','both'].includes(body.transformMode)?body.transformMode:'none';
  const cropMode=body.cropMode==='custom'?'custom':'off',clampCrop=v=>Math.min(100,Math.max(0,parseFloat(v)||0));
  const cropTop=clampCrop(body.cropTop),cropRight=clampCrop(body.cropRight),cropBottom=clampCrop(body.cropBottom),cropLeft=clampCrop(body.cropLeft);
  const watermarkMode=body.watermarkMode==='on',watermarkText=String(body.watermarkText||'DRAFT').slice(0,80),watermarkOpacity=Math.min(.8,Math.max(.05,(parseFloat(body.watermarkOpacity)||20)/100)),watermarkAngle=[-45,0,45].includes(parseInt(body.watermarkAngle,10))?parseInt(body.watermarkAngle,10):-45;
  const headerText=String(body.headerText||'').slice(0,120),footerText=String(body.footerText||'').slice(0,120);
  const pageNumberMode=['off','bottom-center','bottom-right','top-right'].includes(body.pageNumberMode)?body.pageNumberMode:'off',pageNumberStart=Math.min(9999,Math.max(1,parseInt(body.pageNumberStart,10)||1));
  const transformsBaked=String(body.transformsBaked||'false')==='true';
  const driverBin=String(body.driverBin||'').trim().slice(0,160);
  const driverPaperKind=Math.min(65535,Math.max(0,parseInt(body.driverPaperKind,10)||0));
  const driverMediaType=String(body.driverMediaType||'default').slice(0,100);
  const driverQuality=String(body.driverQuality||'default').slice(0,100);
  const driverBorderless=['default','off','on'].includes(body.driverBorderless)?body.driverBorderless:'default';
  const driverEconomy=['default','off','on'].includes(body.driverEconomy)?body.driverEconomy:'default';
  const driverExecutionMode=body.driverExecutionMode==='dialog'?'dialog':'direct';
  const bindingMode=['off','left','right','top','mirror'].includes(body.bindingMode)?body.bindingMode:'off';
  const gutterMm=Math.min(50,Math.max(0,parseFloat(body.gutterMm)||0));
  const blankPageMode=['preserve','remove-detected','pad-even'].includes(body.blankPageMode)?body.blankPageMode:'preserve';
  const pageRotationMode=['none','90','180','270','custom'].includes(body.pageRotationMode)?body.pageRotationMode:'none';
  const pageRotationRules=String(body.pageRotationRules||'').slice(0,200);
  const scaleXPercent=Math.min(150,Math.max(50,parseFloat(body.scaleXPercent)||100));
  const scaleYPercent=Math.min(150,Math.max(50,parseFloat(body.scaleYPercent)||100));
  const offsetXmm=Math.min(50,Math.max(-50,parseFloat(body.offsetXmm)||0));
  const offsetYmm=Math.min(50,Math.max(-50,parseFloat(body.offsetYmm)||0));
  const separatorMode=['off','cover','between-copies'].includes(body.separatorMode)?body.separatorMode:'off';
  const startCopyNewSheet=body.startCopyNewSheet==='on';
  const safetySheetLimit=Math.min(5000,Math.max(0,parseInt(body.safetySheetLimit,10)||0));
  const safetyConfirmed=String(body.safetyConfirmed||'false')==='true';
  const signatureMode=['auto','16','32','48','custom'].includes(body.signatureMode)?body.signatureMode:'auto';
  const signaturePages=Math.min(200,Math.max(4,Math.ceil((parseInt(body.signaturePages,10)||16)/4)*4));
  const creepMode=['off','auto','custom'].includes(body.creepMode)?body.creepMode:'off';
  const creepMm=Math.min(3,Math.max(0,parseFloat(body.creepMm)||0.25));
  const pdfPageBox=['media','crop','trim','bleed','art'].includes(body.pdfPageBox)?body.pdfPageBox:'crop';
  const bleedMode=['off','3','5','custom'].includes(body.bleedMode)?body.bleedMode:'off';
  const bleedMm=Math.min(20,Math.max(0,bleedMode==='custom'?(parseFloat(body.bleedMm)||0):(parseFloat(bleedMode)||0)));
  const prepressMarks=['off','crop','center','registration','all'].includes(body.prepressMarks)?body.prepressMarks:'off';
  const impositionMode=['normal','repeat-2','repeat-4','repeat-custom'].includes(body.impositionMode)?body.impositionMode:'normal';
  const repeatCount=[2,4,6,9,16].includes(parseInt(body.repeatCount,10))?parseInt(body.repeatCount,10):2;
  const nupGapXmm=Math.min(30,Math.max(0,parseFloat(body.nupGapXmm)||0));
  const nupGapYmm=Math.min(30,Math.max(0,parseFloat(body.nupGapYmm)||0));
  const calibrationXmm=Math.min(20,Math.max(-20,parseFloat(body.calibrationXmm)||0));
  const calibrationYmm=Math.min(20,Math.max(-20,parseFloat(body.calibrationYmm)||0));
  return {
    orientation,
    paperSize,
    scaleMode,
    customScale,
    colorMode,
    copies,
    pagesPerSheet,
    duplexMode,
    pageSubset,
    pageOrder,
    collate,
    marginMode, marginTop, marginRight, marginBottom, marginLeft,
    autoRotate, contentAlign, nupBorder, nupOrder, booklet, poster,posterCols,posterRows,posterOverlap,posterCutMarks,transformMode,cropMode,cropTop,cropRight,cropBottom,cropLeft,watermarkMode,watermarkText,watermarkOpacity,watermarkAngle,headerText,footerText,pageNumberMode,pageNumberStart,transformsBaked,
    driverBin,driverPaperKind,driverMediaType,driverQuality,driverBorderless,driverEconomy,driverExecutionMode,
    bindingMode,gutterMm,blankPageMode,pageRotationMode,pageRotationRules,scaleXPercent,scaleYPercent,offsetXmm,offsetYmm,separatorMode,startCopyNewSheet,safetySheetLimit,safetyConfirmed,
    signatureMode,signaturePages,creepMode,creepMm,pdfPageBox,bleedMode,bleedMm,prepressMarks,impositionMode,repeatCount,nupGapXmm,nupGapYmm,calibrationXmm,calibrationYmm,
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

function drawImageInPdfCell(page,image,cellX,cellY,cellW,cellH,padding,scaleMode,customScalePercent=100,allowRotate=true,contentAlign='center'){
  const sourceWPt=image.width*72/96,sourceHPt=image.height*72/96;
  const placement=computePlacement(sourceWPt,sourceHPt,cellW,cellH,padding,scaleMode,allowRotate,customScalePercent);
  const rawW=image.width*72/96*placement.scale,rawH=image.height*72/96*placement.scale;
  let centerX=cellX+cellW/2,centerY=cellY+cellH/2;
  if(contentAlign==='top-left'){const placedW=placement.rotate?rawH:rawW,placedH=placement.rotate?rawW:rawH;centerX=cellX+placedW/2;centerY=cellY+cellH-placedH/2;}
  page.drawImage(image,{x:placement.rotate?centerX+rawH/2:centerX-rawW/2,y:placement.rotate?centerY-rawW/2:centerY-rawH/2,width:rawW,height:rawH,rotate:placement.rotate?degrees(90):degrees(0)});
}

async function convertImageToPdf(imagePath,mimeType,originalName,options){
  const doc=await PDFDocument.create(),image=await loadEmbeddedImage(doc,imagePath,mimeType,originalName),w=image.width*72/96,h=image.height*72/96,p=doc.addPage([w,h]);p.drawImage(image,{x:0,y:0,width:w,height:h});const newPath=imagePath+'_source.pdf';fs.writeFileSync(newPath,await doc.save());try{fs.unlinkSync(imagePath)}catch(_){};const result=await processPdf(newPath,{...options,transformMode:'none',cropMode:'off'});return {filePath:newPath,outputPaperKey:result.outputPaperKey,resolvedOrientation:result.resolvedOrientation};
}

app.get('/ping', (req, res) => {
  const localIps = getLocalIpList();
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.json({
    status: 'PrintServerActive',
    hostname: os.hostname(),
    ipHint: localIps[0] || '',
    localIps,
    version: '4.6.8',
  });
});

app.get('/connection-info', (req, res) => {
  res.json(connectionInfoPayload());
});

app.get('/pairing-info', (req, res) => {
  res.json(connectionInfoPayload());
});

app.get('/pairing-qr', async (req, res) => {
  try {
    if (!QRCode) return res.status(503).send('QR generator tidak tersedia. Jalankan npm install.');
    const info = connectionInfoPayload();
    const requested = String(req.query.host || '').trim().slice(0, 260);
    const allowedHosts = new Set([...info.localIps, ...info.hostnames, 'localhost', '127.0.0.1']);
    const host = allowedHosts.has(requested) ? requested : (info.localIps[0] || `${info.hostname}.local`);
    const target = `http://${host}:${port}/?server=${encodeURIComponent(host)}`;
    const png = await QRCode.toBuffer(target, { type: 'png', width: 340, margin: 2, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Pairing-Target', encodeURIComponent(target));
    res.setHeader('Access-Control-Expose-Headers', 'X-Pairing-Target');
    res.send(png);
  } catch (error) {
    res.status(500).send(`PAIRING_QR_FAILED: ${error.message}`);
  }
});

app.get('/docx-converter-status', async (req, res) => {
  const word = await detectMicrosoftWordDesktop();
  const libreOfficeExecutable = findLibreOfficeExecutable();
  res.json({
    available: Boolean(word.available || libreOfficeExecutable),
    primary: word.available ? 'microsoft-word' : (libreOfficeExecutable ? 'libreoffice' : null),
    microsoftWord: {
      enabled: WORD_CONVERTER_ENABLED,
      available: Boolean(word.available),
      version: word.version || null,
      reason: word.reason || null,
      timeoutSeconds: Math.round(WORD_CONVERT_TIMEOUT_MS / 1000),
    },
    libreOffice: {
      available: Boolean(libreOfficeExecutable),
      executable: libreOfficeExecutable || null,
      timeoutSeconds: Math.round(DOCX_CONVERT_TIMEOUT_MS / 1000),
    },
    version: '4.6.8',
  });
});

app.get('/limits', (req, res) => {
  res.json({
    maxUploadMb: MAX_UPLOAD_MB,
    largePdfThresholdPages: LARGE_PDF_THRESHOLD_PAGES,
    largePdfThresholdMb: LARGE_PDF_THRESHOLD_MB,
    largePdfChunkPages: LARGE_PDF_CHUNK_PAGES,
    supportedFileTypes: ['pdf', 'png', 'jpg', 'jpeg', 'docx'],
    version: '4.6.8',
  });
});

app.get('/printers', async (req, res) => {
  try {
    res.json(await ptp.getPrinters());
  } catch (e) {
    res.status(500).send('Gagal');
  }
});

const printerCapabilityCache = new Map();

function emptyPrinterCapabilities(printerName, reason = '') {
  return {
    name: printerName || '', platform: process.platform, detected: false, reliable: false,
    source: 'unavailable', reason, supportsColor: null, canDuplex: null, maxCopies: null,
    trays: [], paperSizes: [], resolutions: [], mediaTypes: [], borderless: [],
    outputQualities: [], duplexCapabilities: [], colorCapabilities: [], economySupported: null,
  };
}

async function readWindowsPrinterCapabilities(printerName) {
  if (process.platform !== 'win32') return emptyPrinterCapabilities(printerName, 'Deteksi driver hanya tersedia pada server Windows.');
  const ps = findPowerShellExecutable();
  if (!ps) throw new Error('PowerShell tidak ditemukan.');
  const safeName = String(printerName || '').trim().slice(0, 260).replace(/'/g, "''");
  const script = `
$ErrorActionPreference='Stop'
$n='${safeName}'
Add-Type -AssemblyName System.Drawing
$settings=New-Object System.Drawing.Printing.PrinterSettings
if([string]::IsNullOrWhiteSpace($n)){
  $n=[string]$settings.PrinterName
  if([string]::IsNullOrWhiteSpace($n)){
    try{$n=[string](Get-CimInstance Win32_Printer | Where-Object {$_.Default} | Select-Object -First 1 -ExpandProperty Name)}catch{}
  }
}
if([string]::IsNullOrWhiteSpace($n)){throw 'Printer default tidak ditemukan'}
$p=Get-Printer -Name $n -ErrorAction Stop
if(-not $p){throw 'Printer tidak ditemukan'}
$n=$p.Name
$c=$null; try{$c=Get-PrintConfiguration -PrinterName $n -ErrorAction Stop}catch{}
$settings.PrinterName=$n
if(-not $settings.IsValid){throw 'PrinterSettings tidak valid untuk printer ini'}
$trays=@(); foreach($x in $settings.PaperSources){$trays += [pscustomobject]@{name=[string]$x.SourceName;rawKind=[int]$x.RawKind}}
$papers=@(); foreach($x in $settings.PaperSizes){$papers += [pscustomobject]@{name=[string]$x.PaperName;rawKind=[int]$x.RawKind;widthMm=[math]::Round($x.Width*0.254,1);heightMm=[math]::Round($x.Height*0.254,1)}}
$res=@(); foreach($x in $settings.PrinterResolutions){$label=[string]$x.Kind; if($x.X -gt 0 -and $x.Y -gt 0){$label += (' • '+$x.X+'×'+$x.Y+' DPI')}; $res += [pscustomobject]@{kind=[string]$x.Kind;x=[int]$x.X;y=[int]$x.Y;label=$label;value=([string]$x.Kind+'|'+$x.X+'x'+$x.Y)}}
$media=@();$border=@();$quality=@();$sysDuplex=@();$sysColors=@()
try{
  Add-Type -AssemblyName ReachFramework
  $lps=New-Object System.Printing.LocalPrintServer
  $q=$lps.GetPrintQueue($n)
  $caps=$q.GetPrintCapabilities()
  if($caps.PageMediaTypeCapability){$media=@($caps.PageMediaTypeCapability | ForEach-Object {[string]$_})}
  if($caps.PageBorderlessCapability){$border=@($caps.PageBorderlessCapability | ForEach-Object {[string]$_})}
  if($caps.OutputQualityCapability){$quality=@($caps.OutputQualityCapability | ForEach-Object {[string]$_})}
  if($caps.DuplexingCapability){$sysDuplex=@($caps.DuplexingCapability | ForEach-Object {[string]$_})}
  if($caps.OutputColorCapability){$sysColors=@($caps.OutputColorCapability | ForEach-Object {[string]$_})}
}catch{}
[pscustomobject]@{
  detected=$true;reliable=$true;source='Windows driver';detectedAt=(Get-Date).ToString('o');
  name=$p.Name;driverName=$p.DriverName;portName=$p.PortName;status=[string]$p.PrinterStatus;shared=[bool]$p.Shared;
  color=if($c){[bool]$c.Color}else{$null};duplexingMode=if($c){[string]$c.DuplexingMode}else{$null};paperSize=if($c){[string]$c.PaperSize}else{$null};
  supportsColor=[bool]$settings.SupportsColor;canDuplex=[bool]$settings.CanDuplex;maxCopies=[int]$settings.MaximumCopies;
  trays=$trays;paperSizes=$papers;resolutions=$res;mediaTypes=$media;borderless=$border;outputQualities=$quality;duplexCapabilities=$sysDuplex;colorCapabilities=$sysColors;economySupported=$null
} | ConvertTo-Json -Depth 6 -Compress`;
  const result = await runProcess(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command', script], 30000);
  const raw = String(result.stdout || '').trim();
  if (!raw) throw new Error(result.stderr || 'Tidak ada data kemampuan printer.');
  const start = raw.indexOf('{');
  if (start < 0) throw new Error(raw);
  return JSON.parse(raw.slice(start));
}

async function getWindowsPrinterCapabilities(printerName, force = false) {
  const key = String(printerName || '').trim().toLocaleLowerCase();
  const cached = printerCapabilityCache.get(key);
  if (!force && cached && Date.now() - cached.at < PRINTER_CAPABILITY_CACHE_MS) return cached.data;
  const data = await readWindowsPrinterCapabilities(printerName);
  printerCapabilityCache.set(key, { at: Date.now(), data });
  return data;
}


app.get('/calibration-sheet', async (req,res) => {
  try{
    const key=['A4','F4','LETTER','LEGAL'].includes(String(req.query.paperSize||'').toUpperCase())?String(req.query.paperSize).toUpperCase():'A4';
    const base=PAPER_DIMENSIONS[key]||PAPER_DIMENSIONS.A4,landscape=String(req.query.orientation||'portrait')==='landscape';
    const size=landscape?{width:base.height,height:base.width}:base,doc=await PDFDocument.create(),p=doc.addPage([size.width,size.height]),font=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold),c=rgb(.08,.08,.08),mm=72/25.4;
    p.drawText('LEMBAR KALIBRASI PRINT SERVER',{x:30,y:size.height-35,size:14,font:bold,color:c});
    p.drawText('Cetak pada skala 100%. Ukur posisi garis 10 mm dari tepi dan kotak 100 × 100 mm.',{x:30,y:size.height-55,size:8,font,color:c});
    const line=(x1,y1,x2,y2,t=.45)=>p.drawLine({start:{x:x1,y:y1},end:{x:x2,y:y2},thickness:t,color:c});
    for(let x=10;x*mm<size.width-10*mm;x+=10){const X=x*mm;line(X,10*mm,X,(x%50===0?20:15)*mm);p.drawText(String(x),{x:X-5,y:6*mm,size:6,font,color:c});}
    for(let y=10;y*mm<size.height-10*mm;y+=10){const Y=y*mm;line(10*mm,Y,(y%50===0?20:15)*mm,Y);p.drawText(String(y),{x:4*mm,y:Y-2,size:6,font,color:c});}
    p.drawRectangle({x:30*mm,y:30*mm,width:100*mm,height:100*mm,borderWidth:.8,borderColor:c});
    line(size.width/2-12*mm,size.height/2,size.width/2+12*mm,size.height/2,.8);line(size.width/2,size.height/2-12*mm,size.width/2,size.height/2+12*mm,.8);
    p.drawCircle({x:size.width/2,y:size.height/2,size:4*mm,borderWidth:.8,borderColor:c});
    p.drawText('100 mm',{x:70*mm,y:132*mm,size:7,font,color:c});p.drawText('Pusat Kertas',{x:size.width/2-18*mm,y:size.height/2+15*mm,size:7,font,color:c});
    const bytes=await doc.save();res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition',`inline; filename="calibration-${key}.pdf"`);res.send(Buffer.from(bytes));
  }catch(e){res.status(500).send(`CALIBRATION_FAILED: ${e.message}`);}
});

app.get('/printer-capabilities', async (req,res) => {
  try { res.json(await getWindowsPrinterCapabilities(String(req.query.name || ''), String(req.query.refresh || '') === '1')); }
  catch (e) { res.status(500).send(`CAPABILITY_FAILED: ${e.message}`); }
});

app.post('/printer-properties', async (req,res) => {
  try {
    if (process.platform !== 'win32') return res.status(400).send('Properti driver hanya tersedia di Windows.');
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).send('Pilih printer spesifik terlebih dahulu.');
    const child = spawn('rundll32.exe', ['printui.dll,PrintUIEntry','/p','/n',name], { detached:true, stdio:'ignore', windowsHide:false });
    child.unref();
    res.json({ok:true,name});
  } catch(e) { res.status(500).send(`DRIVER_PROPERTIES_FAILED: ${e.message}`); }
});

function getCropBoxForPage(page,options){return getPrepressSourceBox(page,options);}
function formatOverlayText(text,options,pageNo,totalPages){const d=new Date();return String(text||'').replaceAll('{file}',options.sourceName||'').replaceAll('{date}',d.toLocaleDateString()).replaceAll('{time}',d.toLocaleTimeString()).replaceAll('{page}',String(pageNo)).replaceAll('{pages}',String(totalPages));}


function safePageBox(page,kind){
  try{
    if(kind==='media'&&page.getMediaBox)return page.getMediaBox();
    if(kind==='trim'&&page.getTrimBox)return page.getTrimBox();
    if(kind==='bleed'&&page.getBleedBox)return page.getBleedBox();
    if(kind==='art'&&page.getArtBox)return page.getArtBox();
    if(page.getCropBox)return page.getCropBox();
  }catch(_){}
  const s=page.getSize();return {x:0,y:0,width:s.width,height:s.height};
}
function getPrepressSourceBox(page,options){
  const media=safePageBox(page,'media'),base=safePageBox(page,options.pdfPageBox||'crop'),mm=72/25.4,bleed=(options.bleedMm||0)*mm;
  let left=base.x-bleed,bottom=base.y-bleed,right=base.x+base.width+bleed,top=base.y+base.height+bleed;
  left=Math.max(media.x,left);bottom=Math.max(media.y,bottom);right=Math.min(media.x+media.width,right);top=Math.min(media.y+media.height,top);
  if(options.cropMode==='custom'){
    left+=options.cropLeft*mm;right-=options.cropRight*mm;bottom+=options.cropBottom*mm;top-=options.cropTop*mm;
  }
  if(right<=left+1)right=left+1;if(top<=bottom+1)top=bottom+1;
  return {left,bottom,right,top,width:right-left,height:top-bottom};
}
function signaturePageCount(options,total){
  if(options.signatureMode==='auto')return Math.max(4,Math.ceil(total/4)*4);
  if(options.signatureMode==='custom')return options.signaturePages||16;
  return Number(options.signatureMode)||16;
}
function makeSignatureBookletSequence(indices,options){
  const sigSize=signaturePageCount(options,indices.length),out=[];
  for(let start=0;start<indices.length;start+=sigSize){
    const chunk=indices.slice(start,start+sigSize);while(chunk.length%4!==0)chunk.push(null);
    const seq=makeBookletSequence(chunk);
    seq.forEach((idx,pos)=>out.push({idx,posInSignature:pos,signatureSize:chunk.length,signatureNo:Math.floor(start/sigSize)+1}));
  }
  return out;
}
function creepOffsetPt(record,slot,options){
  if(!record||options.creepMode==='off')return 0;
  const per=options.creepMode==='auto'?0.25:(options.creepMm||0);
  const sheetDepth=Math.floor(record.posInSignature/4),pt=sheetDepth*per*72/25.4;
  return slot%2===0?-pt:pt;
}
function drawPrepressMarks(page,x,y,w,h,mode){
  if(!mode||mode==='off')return;
  const c=rgb(.15,.15,.15),L=12,g=7;
  const line=(x1,y1,x2,y2)=>page.drawLine({start:{x:x1,y:y1},end:{x:x2,y:y2},thickness:.55,color:c});
  if(mode==='crop'||mode==='all'){
    line(x-g-L,y,x-g,y);line(x,y-g-L,x,y-g);line(x+w+g,y,x+w+g+L,y);line(x+w,y-g-L,x+w,y-g);
    line(x-g-L,y+h,x-g,y+h);line(x,y+h+g,x,y+h+g+L);line(x+w+g,y+h,x+w+g+L,y+h);line(x+w,y+h+g,x+w,y+h+g+L);
  }
  if(mode==='center'||mode==='all'){
    line(x+w/2-10,y-g-8,x+w/2+10,y-g-8);line(x-g-8,y+h/2-10,x-g-8,y+h/2+10);
    line(x+w/2-10,y+h+g+8,x+w/2+10,y+h+g+8);line(x+w+g+8,y+h/2-10,x+w+g+8,y+h/2+10);
  }
  if(mode==='registration'||mode==='all'){
    const pts=[[x-g-14,y-g-14],[x+w+g+14,y-g-14],[x-g-14,y+h+g+14],[x+w+g+14,y+h+g+14]];
    pts.forEach(([cx,cy])=>{page.drawCircle({x:cx,y:cy,size:4,borderWidth:.6,borderColor:c});line(cx-7,cy,cx+7,cy);line(cx,cy-7,cx,cy+7);});
  }
}
function parseRotationRules(text){
  const map=new Map();
  String(text||'').split(',').map(v=>v.trim()).filter(Boolean).forEach(part=>{
    const m=part.match(/^(\d+)(?:\s*-\s*(\d+))?\s*:\s*(90|180|270)$/);
    if(!m)return;let a=Number(m[1]),b=Number(m[2]||m[1]),deg=Number(m[3]);if(a>b)[a,b]=[b,a];
    for(let n=a;n<=b&&n<=10000;n++)map.set(n,deg);
  });
  return map;
}
function pageRotationFor(originalPageNumber,options,ruleMap){
  if(['90','180','270'].includes(options.pageRotationMode))return Number(options.pageRotationMode);
  if(options.pageRotationMode==='custom')return ruleMap.get(originalPageNumber)||0;
  return 0;
}
function isProbablyBlankPdfPage(page){
  try{
    const contents=page.node.Contents();
    if(!contents)return true;
    const s=String(contents).replace(/\s+/g,'');
    return !s || s==='[]';
  }catch(_){return false;}
}
function productionMarginsForSheet(base,options,sheetNumber){
  const m={...base},g=(options.gutterMm||0)*72/25.4;
  if(options.bindingMode==='left')m.left+=g;
  else if(options.bindingMode==='right')m.right+=g;
  else if(options.bindingMode==='top')m.top+=g;
  else if(options.bindingMode==='mirror'){if(sheetNumber%2===1)m.left+=g;else m.right+=g;}
  return m;
}
function drawEmbeddedWithRotation(out,emb,cellX,cellY,cellW,cellH,options,rotationDeg){
  let rot=((rotationDeg%360)+360)%360;
  let srcW=(rot===90||rot===270)?emb.height:emb.width,srcH=(rot===90||rot===270)?emb.width:emb.height;
  if(options.autoRotate&&((cellW>cellH&&srcW<srcH)||(cellW<cellH&&srcW>srcH))){
    rot=(rot+90)%360;srcW=(rot===90||rot===270)?emb.height:emb.width;srcH=(rot===90||rot===270)?emb.width:emb.height;
  }
  const placement=computePlacement(srcW,srcH,cellW,cellH,0,options.scaleMode,false,options.customScale);
  const sx=(options.scaleXPercent||100)/100,sy=(options.scaleYPercent||100)/100;
  const finalW=placement.width*sx,finalH=placement.height*sy;
  let left=options.contentAlign==='top-left'?cellX:cellX+(cellW-finalW)/2;
  let bottom=options.contentAlign==='top-left'?cellY+cellH-finalH:cellY+(cellH-finalH)/2;
  left+=((options.offsetXmm||0)+(options.calibrationXmm||0))*72/25.4;bottom+=((options.offsetYmm||0)+(options.calibrationYmm||0))*72/25.4;
  let widthParam=finalW,heightParam=finalH,x=left,y=bottom;
  if(rot===90){widthParam=finalH;heightParam=finalW;x=left+finalW;y=bottom;}
  else if(rot===180){x=left+finalW;y=bottom+finalH;}
  else if(rot===270){widthParam=finalH;heightParam=finalW;x=left;y=bottom+finalH;}
  out.drawPage(emb,{x,y,width:widthParam,height:heightParam,rotate:degrees(rot)});
}
async function addJobTicketPage(doc,options,size,title='JOB TICKET'){
  const p=doc.insertPage(0,[size.width,size.height]),font=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
  const lines=[
    title,
    `Dokumen: ${options.sourceName||'Dokumen'}`,
    `Printer: ${options.printerName||'Default Printer'}`,
    `Copy: ${options.copies||1}`,
    `Duplex: ${options.duplexMode||'simplex'}`,
    `Kertas: ${options.paperSize||'SOURCE'}`,
    `Waktu: ${new Date().toLocaleString()}`
  ];
  p.drawText(lines[0],{x:42,y:size.height-70,size:24,font:bold,color:rgb(.1,.1,.1)});
  let y=size.height-115;for(const line of lines.slice(1)){p.drawText(line,{x:42,y,size:11,font,color:rgb(.25,.25,.25),maxWidth:size.width-84});y-=23;}
}
async function ensureEvenPdfPages(filePath){
  const bytes=fs.readFileSync(filePath),doc=await PDFDocument.load(bytes,{ignoreEncryption:true});
  if(doc.getPageCount()%2===1){const p=doc.getPage(doc.getPageCount()-1),sz=p.getSize();doc.addPage([sz.width,sz.height]);fs.writeFileSync(filePath,await doc.save());return true;}
  return false;
}
async function createSeparatorPdf(filePath,options,outputPaperKey){
  const base=PAPER_DIMENSIONS[outputPaperKey]||PAPER_DIMENSIONS.A4;
  const landscape=options.orientation==='landscape';
  const size=landscape?{width:base.height,height:base.width}:base;
  const doc=await PDFDocument.create(),p=doc.addPage([size.width,size.height]),font=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
  p.drawText('SEPARATOR COPY',{x:42,y:size.height-75,size:24,font:bold,color:rgb(.1,.1,.1)});
  p.drawText(options.sourceName||'Dokumen',{x:42,y:size.height-120,size:12,font,color:rgb(.25,.25,.25),maxWidth:size.width-84});
  p.drawText(`Printer: ${options.printerName||'Default'} • ${new Date().toLocaleString()}`,{x:42,y:size.height-148,size:10,font,color:rgb(.35,.35,.35),maxWidth:size.width-84});
  fs.writeFileSync(filePath,await doc.save());
}

async function applyDocumentOverlays(doc,options){
  const pages=doc.getPages(); if(!pages.length)return; const font=await doc.embedFont(StandardFonts.Helvetica),bold=await doc.embedFont(StandardFonts.HelveticaBold);
  for(let i=0;i<pages.length;i++){const p=pages[i],{width,height}=p.getSize(),num=i+1,total=pages.length;
    const header=formatOverlayText(options.headerText,options,num,total),footer=formatOverlayText(options.footerText,options,num,total); const fs=9,edge=10;
    if(header)p.drawText(header,{x:edge,y:height-edge-fs,size:fs,font,color:rgb(.15,.15,.15),maxWidth:width-edge*2});
    if(footer)p.drawText(footer,{x:edge,y:edge,size:fs,font,color:rgb(.15,.15,.15),maxWidth:width-edge*2});
    if(options.pageNumberMode!=='off'){const label=String(options.pageNumberStart+i),tw=font.widthOfTextAtSize(label,fs);let x=width/2-tw/2,y=edge;if(options.pageNumberMode==='bottom-right'){x=width-edge-tw;y=edge;}else if(options.pageNumberMode==='top-right'){x=width-edge-tw;y=height-edge-fs;}p.drawText(label,{x,y,size:fs,font,color:rgb(.15,.15,.15)});}
    if(options.watermarkMode&&options.watermarkText){const size=Math.max(34,Math.min(110,width/7)),tw=bold.widthOfTextAtSize(options.watermarkText,size);p.drawText(options.watermarkText,{x:width/2-tw/2,y:height/2-size/3,size,font:bold,color:rgb(.15,.15,.15),opacity:options.watermarkOpacity,rotate:degrees(options.watermarkAngle)});}
  }
}
function drawCutMarks(page,x,y,w,h){const c=rgb(.35,.35,.35),L=12;page.drawLine({start:{x,y:y+L},end:{x,y},thickness:.6,color:c});page.drawLine({start:{x,y},end:{x:x+L,y},thickness:.6,color:c});page.drawLine({start:{x:x+w-L,y},end:{x:x+w,y},thickness:.6,color:c});page.drawLine({start:{x:x+w,y},end:{x:x+w,y:y+L},thickness:.6,color:c});page.drawLine({start:{x,y:y+h-L},end:{x,y:y+h},thickness:.6,color:c});page.drawLine({start:{x,y:y+h},end:{x:x+L,y:y+h},thickness:.6,color:c});page.drawLine({start:{x:x+w-L,y:y+h},end:{x:x+w,y:y+h},thickness:.6,color:c});page.drawLine({start:{x:x+w,y:y+h},end:{x:x+w,y:y+h-L},thickness:.6,color:c});}
async function processPdfPoster(filePath,options){
  const bytes=fs.readFileSync(filePath),src=await PDFDocument.load(bytes,{ignoreEncryption:true}),total=src.getPageCount();let indices=parsePagesInput(options.pages,total);if(!indices.length)indices=Array.from({length:total},(_,i)=>i);if(options.pageSubset==='odd')indices=indices.filter(i=>(i+1)%2===1);else if(options.pageSubset==='even')indices=indices.filter(i=>(i+1)%2===0);if(options.pageOrder==='reverse')indices.reverse();
  const first=src.getPage(indices[0]||0),fsz=first.getSize(),std=detectStandardPaper(fsz.width,fsz.height),orient=resolveOrientation(options.orientation,fsz.width,fsz.height,1),outSize=resolvePaperSize(options.paperSize,orient,fsz.width,fsz.height,std),m=marginModeToPoints(options),cw=Math.max(1,outSize.width-m.left-m.right),ch=Math.max(1,outSize.height-m.top-m.bottom),doc=await PDFDocument.create(),ovPt=options.posterOverlap*72/25.4;
  for(const idx of indices){const pg=src.getPage(idx),box=getCropBoxForPage(pg,options),tileW=box.width/options.posterCols,tileH=box.height/options.posterRows;for(let row=0;row<options.posterRows;row++){for(let col=0;col<options.posterCols;col++){const ovX=(ovPt*tileW/cw)/2,ovY=(ovPt*tileH/ch)/2;let left=box.left+col*tileW-(col>0?ovX:0),right=box.left+(col+1)*tileW+(col<options.posterCols-1?ovX:0),bottom=box.bottom+(options.posterRows-1-row)*tileH-(row<options.posterRows-1?ovY:0),top=box.bottom+(options.posterRows-row)*tileH+(row>0?ovY:0);left=Math.max(box.left,left);right=Math.min(box.right,right);bottom=Math.max(box.bottom,bottom);top=Math.min(box.top,top);const emb=await doc.embedPage(pg,{left,bottom,right,top});const out=doc.addPage([outSize.width,outSize.height]),scale=Math.min(cw/emb.width,ch/emb.height),w=emb.width*scale,h=emb.height*scale,x=m.left+(cw-w)/2,y=m.bottom+(ch-h)/2;out.drawPage(emb,{x,y,width:w,height:h});if(options.posterCutMarks)drawCutMarks(out,m.left,m.bottom,cw,ch);}}}
  if(options.separatorMode==='cover')await addJobTicketPage(doc,options,outSize,'JOB TICKET / COVER');
  if((options.blankPageMode==='pad-even'||options.startCopyNewSheet)&&options.duplexMode!=='simplex'&&doc.getPageCount()%2===1)doc.addPage([outSize.width,outSize.height]);
  await applyDocumentOverlays(doc,options);fs.writeFileSync(filePath,await doc.save());return {outputPaperKey:outSize.key,resolvedOrientation:orient};
}
function shouldProcessPdf(options){return true;}

async function processPdf(filePath,options){
  if(options.poster)return await processPdfPoster(filePath,options);
  const bytes=fs.readFileSync(filePath),sourceDoc=await PDFDocument.load(bytes,{ignoreEncryption:true}),totalPages=sourceDoc.getPageCount();
  let baseIndices=parsePagesInput(options.pages,totalPages);if(!baseIndices.length)baseIndices=Array.from({length:totalPages},(_,i)=>i);
  if(options.blankPageMode==='remove-detected')baseIndices=baseIndices.filter(i=>!isProbablyBlankPdfPage(sourceDoc.getPage(i)));
  if(options.pageSubset==='odd')baseIndices=baseIndices.filter(i=>(i+1)%2===1);else if(options.pageSubset==='even')baseIndices=baseIndices.filter(i=>(i+1)%2===0);
  if(options.pageOrder==='reverse')baseIndices.reverse();
  if(!baseIndices.length)throw new Error('Tidak ada halaman yang sesuai.');

  let records;
  if(options.booklet){
    records=makeSignatureBookletSequence(baseIndices,options);
    options.pagesPerSheet=2;options.orientation='landscape';options.duplexMode='duplexshort';options.nupOrder='row-ltr';
  }else{
    let repeat=1;if(options.impositionMode==='repeat-2')repeat=2;else if(options.impositionMode==='repeat-4')repeat=4;else if(options.impositionMode==='repeat-custom')repeat=options.repeatCount||2;
    if(repeat>1)options.pagesPerSheet=repeat;
    records=[];for(const idx of baseIndices)for(let r=0;r<repeat;r++)records.push({idx,posInSignature:0,signatureSize:0});
  }

  const firstIndex=(records.find(r=>r.idx!==null)||{idx:0}).idx,firstSize=sourceDoc.getPage(firstIndex).getSize(),std=detectStandardPaper(firstSize.width,firstSize.height),
        orient=resolveOrientation(options.orientation,firstSize.width,firstSize.height,options.pagesPerSheet),
        outSize=resolvePaperSize(options.paperSize,orient,firstSize.width,firstSize.height,std),
        grid=getGrid(options.pagesPerSheet,orient),baseMargins=marginModeToPoints(options),
        ruleMap=parseRotationRules(options.pageRotationRules),doc=await PDFDocument.create(),
        gapX=(options.nupGapXmm||0)*72/25.4,gapY=(options.nupGapYmm||0)*72/25.4;
  let out=null,physicalSide=0;
  for(let i=0;i<records.length;i++){
    if(i%grid.safePps===0){out=doc.addPage([outSize.width,outSize.height]);physicalSide++;}
    const margins=productionMarginsForSheet(baseMargins,options,physicalSide),
          contentW=Math.max(1,outSize.width-margins.left-margins.right),
          contentH=Math.max(1,outSize.height-margins.top-margins.bottom),
          cellW=Math.max(1,(contentW-gapX*(grid.cols-1))/grid.cols),cellH=Math.max(1,(contentH-gapY*(grid.rows-1))/grid.rows),
          slot=i%grid.safePps,pos=getSlotPosition(slot,grid.cols,grid.rows,options.nupOrder),
          creep=options.booklet?creepOffsetPt(records[i],slot,options):0,
          cellX=margins.left+pos.col*(cellW+gapX)+creep,cellY=margins.bottom+(grid.rows-1-pos.row)*(cellH+gapY);
    if(options.nupBorder!=='none'&&options.pagesPerSheet>1)out.drawRectangle({x:cellX,y:cellY,width:cellW,height:cellH,borderWidth:options.nupBorder==='medium'?1.5:.7,borderColor:rgb(.6,.6,.6)});
    drawPrepressMarks(out,cellX,cellY,cellW,cellH,options.prepressMarks);
    const idx=records[i].idx;if(idx===null)continue;
    const pg=sourceDoc.getPage(idx),box=getPrepressSourceBox(pg,options),emb=await doc.embedPage(pg,box),manualRot=pageRotationFor(idx+1,options,ruleMap);
    drawEmbeddedWithRotation(out,emb,cellX,cellY,cellW,cellH,{...options,scaleMode:getEffectiveScaleMode(options.scaleMode,options.pagesPerSheet)},manualRot);
  }
  if(options.separatorMode==='cover')await addJobTicketPage(doc,options,outSize,'JOB TICKET / COVER');
  if((options.blankPageMode==='pad-even'||options.startCopyNewSheet)&&options.duplexMode!=='simplex'&&doc.getPageCount()%2===1)doc.addPage([outSize.width,outSize.height]);
  await applyDocumentOverlays(doc,options);fs.writeFileSync(filePath,await doc.save());
  return {outputPaperKey:outSize.key,resolvedOrientation:orient};
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

async function printOneDocument(filePath, baseOpts, options) {
  const copies = Math.max(1, options.copies || 1);
  if (copies === 1) {
    await ptp.print(filePath, { ...baseOpts, copies: 1 });
    return;
  }

  if (options.collate) {
    for (let c = 1; c <= copies; c += 1) {
      updateStatus(`Mencetak copy ${c}/${copies} (Collate)...`, 'printing');
      await ptp.print(filePath, { ...baseOpts, copies: 1 });
      if(options.separatorMode==='between-copies'&&options.separatorFilePath&&c<copies){
        updateStatus(`Mencetak separator copy ${c}/${copies}...`,'printing');
        await ptp.print(options.separatorFilePath,{...baseOpts,copies:1,side:'simplex'});
      }
    }
    return;
  }

  const pageCount = await getPdfPageCount(filePath);
  for (let p = 1; p <= pageCount; p += 1) {
    updateStatus(`Mencetak halaman ${p}/${pageCount}, ${copies} copy (Uncollated)...`, 'printing');
    await ptp.print(filePath, { ...baseOpts, pages: String(p), copies });
  }
}

async function printPdfInChunks(filePath, baseOpts, chunkSize, options) {
  const chunks = await splitPdfToChunkFiles(filePath, chunkSize);
  const cleanup = chunks.map(c => c.path);
  try {
    if (options.collate && options.copies > 1) {
      for (let c = 1; c <= options.copies; c += 1) {
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          updateStatus(`Copy ${c}/${options.copies} • bagian ${i + 1}/${chunks.length} • halaman ${chunk.start}-${chunk.end}...`, 'printing');
          await ptp.print(chunk.path, { ...baseOpts, copies: 1 });
        }
        if(options.separatorMode==='between-copies'&&options.separatorFilePath&&c<options.copies){
          updateStatus(`Mencetak separator copy ${c}/${options.copies}...`,'printing');
          await ptp.print(options.separatorFilePath,{...baseOpts,copies:1,side:'simplex'});
        }
      }
    } else if (!options.collate && options.copies > 1) {
      await printOneDocument(filePath, baseOpts, options);
    } else {
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        updateStatus(`Mencetak bagian ${i + 1}/${chunks.length} halaman ${chunk.start}-${chunk.end} dari ${chunk.totalPages}...`, 'printing');
        await ptp.print(chunk.path, { ...baseOpts, copies: 1 });
      }
    }
  } finally {
    cleanup.forEach(p => {
      try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    });
  }
}



function findPowerShellExecutable() {
  const candidates = [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '',
    'powershell.exe',
    'pwsh.exe',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'powershell.exe' || candidate === 'pwsh.exe') return candidate;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return '';
}

async function detectMicrosoftWordDesktop() {
  if (!WORD_CONVERTER_ENABLED || process.platform !== 'win32') {
    return { available: false, reason: 'Word converter hanya aktif di Windows.' };
  }

  const powershell = findPowerShellExecutable();
  if (!powershell) return { available: false, reason: 'PowerShell tidak ditemukan.' };

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$word = $null",
    "try {",
    "  $word = New-Object -ComObject Word.Application",
    "  $version = $word.Version",
    "  Write-Output ('AVAILABLE|' + $version)",
    "} catch {",
    "  Write-Output ('UNAVAILABLE|' + $_.Exception.Message)",
    "} finally {",
    "  if ($null -ne $word) { try { $word.Quit() } catch {} }",
    "  [System.GC]::Collect()",
    "  [System.GC]::WaitForPendingFinalizers()",
    "}",
  ].join('; ');

  try {
    const result = await runProcess(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      30000
    );
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    const availableLine = output.split(/\r?\n/).find(line => line.startsWith('AVAILABLE|'));
    if (availableLine) return { available: true, version: availableLine.split('|').slice(1).join('|') || null };
    const unavailableLine = output.split(/\r?\n/).find(line => line.startsWith('UNAVAILABLE|'));
    return {
      available: false,
      reason: unavailableLine ? unavailableLine.split('|').slice(1).join('|') : 'Microsoft Word desktop tidak dapat diakses melalui COM.',
    };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

async function convertDocxWithMicrosoftWord(docxPath, outputPdfPath) {
  if (!WORD_CONVERTER_ENABLED) throw new Error('Converter Microsoft Word dinonaktifkan.');
  if (process.platform !== 'win32') throw new Error('Converter Microsoft Word hanya tersedia di Windows.');

  const powershell = findPowerShellExecutable();
  if (!powershell) throw new Error('PowerShell tidak ditemukan.');

  const input = escapePowerShellSingleQuoted(path.resolve(docxPath));
  const output = escapePowerShellSingleQuoted(path.resolve(outputPdfPath));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$word = $null",
    "$doc = $null",
    "try {",
    "  $word = New-Object -ComObject Word.Application",
    "  $word.Visible = $false",
    "  $word.DisplayAlerts = 0",
    `  $doc = $word.Documents.Open('${input}', $false, $true, $false)`,
    "  $wdExportFormatPDF = 17",
    "  $wdExportOptimizeForPrint = 0",
    "  $wdExportAllDocument = 0",
    "  $wdExportDocumentContent = 0",
    `  $doc.ExportAsFixedFormat('${output}', $wdExportFormatPDF, $false, $wdExportOptimizeForPrint, $wdExportAllDocument, 1, 1, $wdExportDocumentContent, $true, $true, 0, $true, $true, $false)`,
    "  Write-Output 'WORD_CONVERSION_OK'",
    "} finally {",
    "  if ($null -ne $doc) { try { $doc.Close($false) } catch {} }",
    "  if ($null -ne $word) { try { $word.Quit() } catch {} }",
    "  if ($null -ne $doc) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null }",
    "  if ($null -ne $word) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null }",
    "  [System.GC]::Collect()",
    "  [System.GC]::WaitForPendingFinalizers()",
    "}",
  ].join('; ');

  updateStatus('Mengonversi DOCX dengan Microsoft Word...', 'processing');
  const result = await runProcess(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    WORD_CONVERT_TIMEOUT_MS
  );

  if (!fs.existsSync(outputPdfPath)) {
    throw new Error(`Microsoft Word selesai berjalan tetapi PDF tidak ditemukan. ${result.stderr || result.stdout || ''}`.trim());
  }
  return { engine: 'microsoft-word', details: result.stdout.trim() };
}

function findLibreOfficeExecutable() {
  const candidates = [
    LIBREOFFICE_PATH,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'LibreOffice', 'program', 'soffice.exe') : '',
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'LibreOffice', 'program', 'soffice.exe') : '',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    'soffice',
    'libreoffice',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'soffice' || candidate === 'libreoffice') return candidate;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return '';
}

function pathToLibreOfficeFileUrl(folderPath) {
  const resolved = path.resolve(folderPath).replace(/\\/g, '/');
  return `file:///${encodeURI(resolved)}`;
}

function runProcess(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => finish(err));
    child.on('close', code => {
      if (code === 0) finish(null, { code, stdout, stderr });
      else finish(new Error(`LibreOffice keluar dengan kode ${code}. ${stderr || stdout}`.trim()));
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(new Error(`Konversi DOCX melewati batas waktu ${Math.round(timeoutMs / 1000)} detik.`));
    }, timeoutMs);
  });
}

async function convertDocxWithLibreOffice(docxPath, originalName) {
  const executable = findLibreOfficeExecutable();
  if (!executable) {
    throw new Error(
      'LibreOffice tidak ditemukan. Instal LibreOffice atau atur environment LIBREOFFICE_PATH ke soffice.exe.'
    );
  }

  const jobId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jobDir = path.join(uploadDir, `docx-${jobId}`);
  const outputDir = path.join(jobDir, 'output');
  const profileDir = path.join(jobDir, 'profile');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const safeBase = path.basename(originalName || 'document.docx', path.extname(originalName || 'document.docx'))
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .slice(0, 120) || 'document';
  const inputPath = path.join(jobDir, `${safeBase}.docx`);
  fs.copyFileSync(docxPath, inputPath);

  const args = [
    '--headless',
    '--nologo',
    '--nodefault',
    '--nofirststartwizard',
    `-env:UserInstallation=${pathToLibreOfficeFileUrl(profileDir)}`,
    '--convert-to',
    'pdf:writer_pdf_Export',
    '--outdir',
    outputDir,
    inputPath,
  ];

  try {
    updateStatus('Mengonversi DOCX menjadi PDF...', 'processing');
    await runProcess(executable, args, DOCX_CONVERT_TIMEOUT_MS);

    const expected = path.join(outputDir, `${safeBase}.pdf`);
    let pdfPath = expected;
    if (!fs.existsSync(pdfPath)) {
      const found = fs.readdirSync(outputDir).find(name => name.toLowerCase().endsWith('.pdf'));
      if (found) pdfPath = path.join(outputDir, found);
    }

    if (!fs.existsSync(pdfPath)) {
      throw new Error('LibreOffice selesai berjalan, tetapi file PDF hasil konversi tidak ditemukan.');
    }

    const finalPdfPath = path.join(uploadDir, `converted-${jobId}.pdf`);
    fs.copyFileSync(pdfPath, finalPdfPath);
    return {
      pdfPath: finalPdfPath,
      outputName: `${safeBase}.pdf`,
      cleanupDir: jobDir,
      engine: 'libreoffice',
    };
  } catch (error) {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
    throw error;
  }
}


async function convertDocxToPdf(docxPath, originalName) {
  const jobId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeBase = path.basename(originalName || 'document.docx', path.extname(originalName || 'document.docx'))
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .slice(0, 120) || 'document';

  const wordOutputPath = path.join(uploadDir, `word-converted-${jobId}.pdf`);
  let wordError = null;

  if (WORD_CONVERTER_ENABLED && process.platform === 'win32') {
    try {
      const wordResult = await convertDocxWithMicrosoftWord(docxPath, wordOutputPath);
      return {
        pdfPath: wordOutputPath,
        outputName: `${safeBase}.pdf`,
        cleanupDir: '',
        engine: wordResult.engine,
      };
    } catch (error) {
      wordError = error;
      console.error('[WORD CONVERSION ERROR]', error);
      try { if (fs.existsSync(wordOutputPath)) fs.unlinkSync(wordOutputPath); } catch (_) {}
      updateStatus('Konversi Microsoft Word gagal. Mencoba LibreOffice...', 'processing');
    }
  }

  try {
    return await convertDocxWithLibreOffice(docxPath, originalName);
  } catch (libreOfficeError) {
    const details = [
      wordError ? `Microsoft Word: ${wordError.message}` : 'Microsoft Word: tidak tersedia atau dinonaktifkan.',
      `LibreOffice: ${libreOfficeError.message}`,
    ].join(' | ');
    throw new Error(`Semua converter DOCX gagal. ${details}`);
  }
}

function preserveUploadedExtension(filePath, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const allowed = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.docx']);
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

app.post('/convert-docx',
  (req, res, next) => {
    uploadDocument(req, res, (err) => {
      if (!err) return next();
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `Ukuran file melebihi batas ${MAX_UPLOAD_MB} MB.`
        : `Upload gagal: ${err.message}`;
      updateStatus(`Gagal: ${message}`, 'error');
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).send(message);
    });
  },
  async (req, res) => {
    let uploadedPath = req.file ? req.file.path : '';
    let convertedPath = '';
    let cleanupDir = '';

    try {
      if (!req.file || !uploadedPath || !fs.existsSync(uploadedPath)) {
        throw new Error('File DOCX tidak ditemukan.');
      }

      const originalName = req.file.originalname || 'document.docx';
      const mimeType = req.file.mimetype || '';
      const isDocx = /\.docx$/i.test(originalName)
        || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

      if (!isDocx) {
        throw new Error('Endpoint ini hanya menerima file DOCX.');
      }

      uploadedPath = preserveUploadedExtension(uploadedPath, originalName);
      const result = await convertDocxToPdf(uploadedPath, originalName);
      convertedPath = result.pdfPath;
      cleanupDir = result.cleanupDir;

      const stat = fs.statSync(convertedPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(result.outputName)}"`);
      res.setHeader('X-Converted-Filename', encodeURIComponent(result.outputName));
      res.setHeader('X-Converter-Engine', result.engine || 'unknown');
      res.setHeader('Access-Control-Expose-Headers', 'X-Converted-Filename, X-Converter-Engine, Content-Disposition');
      updateStatus(`Konversi DOCX berhasil melalui ${result.engine === 'microsoft-word' ? 'Microsoft Word' : 'LibreOffice'}. PDF siap dipreview dan dicetak.`, 'success');

      const stream = fs.createReadStream(convertedPath);
      stream.on('error', (streamError) => {
        console.error('[DOCX PDF STREAM ERROR]', streamError);
        updateStatus(`Gagal mengirim PDF hasil konversi: ${streamError.message}`, 'error');
        if (!res.headersSent) {
          res.status(500).send(`DOCX_STREAM_FAILED: ${streamError.message}`);
        } else {
          res.destroy(streamError);
        }
      });
      stream.pipe(res);
    } catch (error) {
      console.error('[DOCX CONVERSION ERROR]', error);
      updateStatus(`Gagal konversi DOCX: ${error.message}`, 'error');
      if (!res.headersSent) res.status(500).send(`DOCX_CONVERSION_FAILED: ${error.message}`);
    } finally {
      res.on('finish', () => {
        try { if (uploadedPath && fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch (_) {}
        try { if (convertedPath && fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath); } catch (_) {}
        try { if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch (_) {}
      });
    }
  }
);


// ===== v4.5.35 Central Print Queue & Job Management =====
const JOB_RETENTION_MS = Math.max(60 * 60 * 1000, parseInt(process.env.JOB_RETENTION_MS || String(24 * 60 * 60 * 1000), 10));
const DUPLICATE_WINDOW_MS = Math.max(3000, parseInt(process.env.DUPLICATE_WINDOW_MS || '15000', 10));
const MAX_JOB_HISTORY = Math.max(20, parseInt(process.env.MAX_JOB_HISTORY || '100', 10));
const jobStoreDir = path.join(os.tmpdir(), 'print-server-pro-job-cache');
if (!fs.existsSync(jobStoreDir)) fs.mkdirSync(jobStoreDir, { recursive: true });
const printJobs = new Map();
const printerWorkers = new Map();
let queuePaused = false;

const PRIORITY_WEIGHT = { normal: 0, priority: 1, urgent: 2 };
function makeJobId() { return `J${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function printerQueueKey(job) { return String(job.options.printerName || '__DEFAULT__'); }
function publicJob(job) {
  return {
    id: job.id, name: job.originalName, printerName: job.options.printerName || 'Default Printer',
    status: job.status, stage: job.stage || '', priority: job.priority, hold: job.status === 'held',
    createdAt: job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
    attempts: job.attempts || 0, error: job.error || '', cancelRequested: Boolean(job.cancelRequested),
    pages: job.metrics?.pages || null, outputPages: job.metrics?.outputPages || null,
    sheets: job.metrics?.sheets || null, copies: job.options.copies || 1,
    duplex: job.options.duplexMode || 'simplex', colorMode: job.options.colorMode || 'color',
    pagesPerSheet: job.options.pagesPerSheet || 1, fileSizeMb: job.fileSizeMb || 0,
    device: job.device || '', sourceRetained: Boolean(job.sourcePath && fs.existsSync(job.sourcePath)),
    spoolerCancel: job.spoolerCancel || null,
  };
}
function emitQueueUpdate(job) {
  io.emit('queue-update', { job: job ? publicJob(job) : null, paused: queuePaused, timestamp: Date.now() });
}
function setJobStatus(job, status, stage = '', error = '') {
  job.status = status; job.stage = stage || status; job.error = error || '';
  if (status === 'processing' && !job.startedAt) job.startedAt = Date.now();
  if (['success','failed','cancelled'].includes(status)) job.finishedAt = Date.now();
  emitQueueUpdate(job);
}
function createCompletion(job) {
  job.completion = new Promise((resolve, reject) => { job._resolve = resolve; job._reject = reject; });
  job.completion.catch(() => {});
}
function settleCompletion(job, error = null) {
  if (error && job._reject) job._reject(error); else if (!error && job._resolve) job._resolve(publicJob(job));
  job._resolve = null; job._reject = null;
}
function copyToJobStore(uploadedPath, originalName, jobId) {
  const ext = path.extname(originalName || '') || path.extname(uploadedPath || '') || '.bin';
  const target = path.join(jobStoreDir, `${jobId}-source${ext.toLowerCase()}`);
  fs.copyFileSync(uploadedPath, target);
  try { fs.unlinkSync(uploadedPath); } catch (_) {}
  return target;
}
function jobFingerprint(originalName, size, options) {
  const stable = {
    name: String(originalName || '').toLowerCase(), size, printer: options.printerName || '', copies: options.copies,
    color: options.colorMode, paper: options.paperSize, orientation: options.orientation, pps: options.pagesPerSheet,
    duplex: options.duplexMode, pages: options.pages, scale: options.scaleMode, customScale: options.customScale,
  };
  return crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex');
}
function findRecentDuplicate(fingerprint) {
  const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
  return [...printJobs.values()].find(j => j.fingerprint === fingerprint && j.createdAt >= cutoff && !['cancelled','failed'].includes(j.status));
}
function nextQueuedJobForPrinter(key) {
  return [...printJobs.values()]
    .filter(j => printerQueueKey(j) === key && j.status === 'queued')
    .sort((a,b) => (PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]) || (a.createdAt - b.createdAt))[0] || null;
}
function enqueueJob(job) {
  if (!job.completion) createCompletion(job);
  printJobs.set(job.id, job);
  emitQueueUpdate(job);
  startPrinterWorker(printerQueueKey(job));
}
function startPrinterWorker(key) {
  if (printerWorkers.get(key)) return;
  printerWorkers.set(key, true);
  (async () => {
    try {
      while (true) {
        if (queuePaused) { await new Promise(r => setTimeout(r, 500)); continue; }
        const job = nextQueuedJobForPrinter(key);
        if (!job) break;
        if (job.cancelRequested) { setJobStatus(job, 'cancelled', 'cancelled'); settleCompletion(job, new Error('JOB_CANCELLED')); continue; }
        try {
          job.attempts = (job.attempts || 0) + 1;
          setJobStatus(job, 'processing', 'preparing');
          await executePrintJob(job);
          if (job.cancelRequested) {
            setJobStatus(job, 'cancelled', 'cancelled');
            settleCompletion(job, new Error('JOB_CANCELLED'));
          } else {
            setJobStatus(job, 'success', 'completed');
            settleCompletion(job);
          }
        } catch (err) {
          console.error(`[QUEUE JOB ${job.id}]`, err);
          setJobStatus(job, job.cancelRequested ? 'cancelled' : 'failed', job.cancelRequested ? 'cancelled' : 'failed', err.message);
          settleCompletion(job, err);
        }
      }
    } finally {
      printerWorkers.delete(key);
      if (!queuePaused && nextQueuedJobForPrinter(key)) startPrinterWorker(key);
    }
  })();
}
function resumeAllWorkers() {
  const keys = new Set([...printJobs.values()].filter(j => j.status === 'queued').map(printerQueueKey));
  keys.forEach(startPrinterWorker);
}
function estimateSheets(outputPages, copies, duplexMode) {
  const sides = Math.max(0, Number(outputPages || 0));
  const perCopy = duplexMode !== 'simplex' ? Math.ceil(sides / 2) : sides;
  return perCopy * Math.max(1, Number(copies || 1));
}
async function safeOriginalPageCount(filePath, mimeType, originalName) {
  try {
    if ((mimeType && mimeType.includes('image')) || /\.(jpg|jpeg|png)$/i.test(originalName || '')) return 1;
    if ((mimeType && mimeType.includes('pdf')) || /\.pdf$/i.test(originalName || '') || /\.pdf$/i.test(filePath || '')) return await getPdfPageCount(filePath);
  } catch (_) {}
  return null;
}
async function tryCancelSpoolerJob(job) {
  if (process.platform !== 'win32' || !job.options.printerName) return { attempted:false, cancelled:0, reason:'Spooler cancel only available on Windows with a named printer.' };
  const ps = findPowerShellExecutable(); if (!ps) return { attempted:false, cancelled:0, reason:'PowerShell not found.' };
  const printer = String(job.options.printerName).replace(/'/g,"''");
  const base = path.basename(job.originalName || '', path.extname(job.originalName || '')).replace(/'/g,"''").slice(0,80);
  const jid = String(job.id || '').replace(/'/g,"''");
  const cutoff = new Date((job.startedAt || job.createdAt || Date.now()) - 15000).toISOString();
  const script = `$ErrorActionPreference='Stop';$n='${printer}';$needle='${base}';$jid='${jid}';$cut=[datetime]'${cutoff}';$jobs=@(Get-PrintJob -PrinterName $n -ErrorAction Stop | Where-Object { $_.SubmittedTime -ge $cut -and (([string]$_.DocumentName -like ('*'+$needle+'*')) -or ([string]$_.DocumentName -like ('*'+$jid+'*'))) });$count=0;foreach($j in $jobs){try{Remove-PrintJob -PrinterName $n -ID $j.ID -ErrorAction Stop;$count++}catch{}};Write-Output $count`;
  try { const r=await runProcess(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],15000); const count=parseInt(String(r.stdout||'').trim(),10)||0; return {attempted:true,cancelled:count}; }
  catch(e){ return {attempted:true,cancelled:0,reason:e.message}; }
}

function printerSupportsPaper(capabilities, paperKey) {
  const targets = {
    A4: [210, 297], F4: [210, 330], LETTER: [215.9, 279.4], LEGAL: [215.9, 355.6],
  };
  const target = targets[String(paperKey || '').toUpperCase()];
  if (!target || !(capabilities.paperSizes || []).length) return null;
  return capabilities.paperSizes.some(item => {
    const width = Number(item.widthMm), height = Number(item.heightMm);
    return (Math.abs(width - target[0]) <= 2 && Math.abs(height - target[1]) <= 2)
      || (Math.abs(width - target[1]) <= 2 && Math.abs(height - target[0]) <= 2);
  });
}

async function assertPrintOptionsSupported(options, outputPaperKey) {
  let cap;
  try { cap = await getWindowsPrinterCapabilities(options.printerName || ''); }
  catch (_) { return; }
  if (!cap || cap.detected === false || cap.reliable === false) return;
  const printerLabel = cap.name || options.printerName || 'printer aktif';
  if (options.colorMode === 'color' && cap.supportsColor === false) {
    throw new Error(`CAPABILITY_UNSUPPORTED: ${printerLabel} hanya mendukung cetak monokrom.`);
  }
  if (options.duplexMode !== 'simplex' && cap.canDuplex === false) {
    throw new Error(`CAPABILITY_UNSUPPORTED: ${printerLabel} tidak mendukung duplex otomatis. Gunakan satu sisi atau duplex manual.`);
  }
  if (options.driverBin && (cap.trays || []).length) {
    const requested = String(options.driverBin).toLocaleLowerCase();
    const trayExists = cap.trays.some(item => String(item.name || '').toLocaleLowerCase() === requested);
    if (!trayExists) throw new Error(`CAPABILITY_UNSUPPORTED: tray "${options.driverBin}" tidak tersedia pada ${printerLabel}.`);
  }
  if (options.driverPaperKind > 0 && (cap.paperSizes || []).length) {
    const kindExists = cap.paperSizes.some(item => Number(item.rawKind) === Number(options.driverPaperKind));
    if (!kindExists) throw new Error(`CAPABILITY_UNSUPPORTED: Paper Kind ${options.driverPaperKind} tidak tersedia pada ${printerLabel}.`);
  } else {
    const paperSupported = printerSupportsPaper(cap, outputPaperKey);
    if (paperSupported === false) {
      throw new Error(`CAPABILITY_UNSUPPORTED: ukuran ${outputPaperKey} tidak dilaporkan oleh driver ${printerLabel}.`);
    }
  }
}

async function executePrintJob(job) {
  const options = { ...job.options };
  let fPath = '';
  try {
    if (!job.sourcePath || !fs.existsSync(job.sourcePath)) throw new Error('File sumber job tidak tersedia lagi.');
    const ext = path.extname(job.sourcePath) || path.extname(job.originalName || '') || '.bin';
    const safeBase = path.basename(job.originalName || 'document', path.extname(job.originalName || '')).replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,60) || 'document';
    fPath = path.join(jobStoreDir, `${job.id}-work-${safeBase}-${Date.now()}${ext}`);
    fs.copyFileSync(job.sourcePath, fPath);
    updateStatus(`[${job.id}] Memproses ${job.originalName}...`, 'processing');
    job.stage='processing'; emitQueueUpdate(job);

    const mimeType=job.mimeType||'', originalName=job.originalName||'';
    const isImageFile=(mimeType&&mimeType.includes('image'))||/\.(jpg|jpeg|png)$/i.test(originalName);
    const isPdfFile=(mimeType&&mimeType.includes('pdf'))||/\.pdf$/i.test(originalName)||/\.pdf$/i.test(fPath);
    job.metrics = job.metrics || {};
    job.metrics.pages = await safeOriginalPageCount(fPath,mimeType,originalName);
    let pdfPageCount=0, pdfSizeMb=getFileSizeMb(fPath), shouldChunkPdf=false;
    let outputPaperKey=options.paperSize==='SOURCE'?'A4':options.paperSize;

    if (job.cancelRequested) throw new Error('JOB_CANCELLED');
    if (isImageFile) {
      const result=await convertImageToPdf(fPath,mimeType,originalName,options); fPath=result.filePath; outputPaperKey=result.outputPaperKey;
      pdfPageCount=await getPdfPageCount(fPath);
    } else if (isPdfFile && shouldProcessPdf(options)) {
      const result=await processPdf(fPath,options); outputPaperKey=result.outputPaperKey;
      pdfPageCount=await getPdfPageCount(fPath); pdfSizeMb=getFileSizeMb(fPath);
      shouldChunkPdf=pdfPageCount>=LARGE_PDF_THRESHOLD_PAGES||pdfSizeMb>=LARGE_PDF_THRESHOLD_MB;
    } else if (isPdfFile) {
      const sourcePdf=await PDFDocument.load(fs.readFileSync(fPath),{ignoreEncryption:true}); pdfPageCount=sourcePdf.getPageCount();
      const firstSize=sourcePdf.getPage(0).getSize(),detected=detectStandardPaper(firstSize.width,firstSize.height);outputPaperKey=detected==='CUSTOM'?'A4':detected;
      shouldChunkPdf=pdfPageCount>=LARGE_PDF_THRESHOLD_PAGES||pdfSizeMb>=LARGE_PDF_THRESHOLD_MB;
    } else throw new Error('Format file tidak didukung. Gunakan PDF, JPG, JPEG, atau PNG.');

    job.metrics.outputPages=pdfPageCount||1;
    job.metrics.sheets=estimateSheets(job.metrics.outputPages,options.copies,options.duplexMode);
    if(options.separatorMode==='between-copies'&&options.copies>1)job.metrics.sheets+=options.copies-1;
    emitQueueUpdate(job);
    if(options.safetySheetLimit>0&&job.metrics.sheets>options.safetySheetLimit&&!options.safetyConfirmed){
      throw new Error(`SAFETY_CONFIRM_REQUIRED: estimasi ${job.metrics.sheets} lembar melebihi batas ${options.safetySheetLimit}.`);
    }
    if(options.separatorMode==='between-copies'&&options.copies>1){
      options.separatorFilePath=path.join(jobStoreDir,`${job.id}-separator.pdf`);
      await createSeparatorPdf(options.separatorFilePath,options,outputPaperKey);
    }
    if (job.cancelRequested) throw new Error('JOB_CANCELLED');

    await assertPrintOptionsSupported(options, outputPaperKey);

    const opts={
      printer:options.printerName, monochrome:options.colorMode==='monochrome', side:options.duplexMode,
      paperSize:outputPaperKey==='F4'?'210x330mm':outputPaperKey==='LETTER'?'Letter':outputPaperKey==='LEGAL'?'Legal':'A4',
      scale:'shrink', silent:options.driverExecutionMode!=='dialog', printDialog:options.driverExecutionMode==='dialog'
    };
    if(options.driverBin)opts.bin=options.driverBin;
    if(options.driverPaperKind>0){opts.paperkind=options.driverPaperKind;delete opts.paperSize;}
    const vendorSelected=options.driverMediaType!=='default'||options.driverQuality!=='default'||options.driverBorderless!=='default'||options.driverEconomy!=='default';
    if(vendorSelected&&options.driverExecutionMode!=='dialog')throw new Error('Media Type / Quality / Borderless / Economy membutuhkan Mode Eksekusi Driver: Dialog Printer.');

    setJobStatus(job,'processing','spooling');
    updateStatus(`[${job.id}] Dikirim ke ${options.printerName||'printer default'}...`,'printing');
    if(isPdfFile&&shouldChunkPdf) await printPdfInChunks(fPath,opts,options.duplexMode==='simplex'?LARGE_PDF_CHUNK_PAGES:Math.max(2,LARGE_PDF_CHUNK_PAGES-(LARGE_PDF_CHUNK_PAGES%2)),options);
    else await printOneDocument(fPath,opts,options);
    updateStatus(`[${job.id}] Cetak selesai.`,'success');
  } finally {
    try { if(fPath&&fs.existsSync(fPath))fs.unlinkSync(fPath); } catch(_){}
    try {
      for(const p of fs.readdirSync(jobStoreDir)) if(p.startsWith(`${job.id}-work-`)) fs.unlinkSync(path.join(jobStoreDir,p));
    } catch(_){}
  }
}
function cleanupOldJobs() {
  const now=Date.now();
  const completed=[...printJobs.values()].filter(j=>['success','failed','cancelled'].includes(j.status)).sort((a,b)=>(b.finishedAt||0)-(a.finishedAt||0));
  completed.forEach((job,index)=>{
    if((job.finishedAt&&now-job.finishedAt>JOB_RETENTION_MS)||index>=MAX_JOB_HISTORY){
      try{if(job.sourcePath&&fs.existsSync(job.sourcePath))fs.unlinkSync(job.sourcePath)}catch(_){}
      printJobs.delete(job.id);
    }
  });
}
setInterval(cleanupOldJobs,10*60*1000).unref?.();

app.get('/queue',(req,res)=>{
  cleanupOldJobs();
  const jobs=[...printJobs.values()].sort((a,b)=>b.createdAt-a.createdAt).map(publicJob);
  res.json({paused:queuePaused,jobs,active:jobs.filter(j=>['processing'].includes(j.status)).length,waiting:jobs.filter(j=>j.status==='queued').length,held:jobs.filter(j=>j.status==='held').length});
});
app.post('/queue/pause',(req,res)=>{queuePaused=true;emitQueueUpdate();res.json({ok:true,paused:true});});
app.post('/queue/resume',(req,res)=>{queuePaused=false;emitQueueUpdate();resumeAllWorkers();res.json({ok:true,paused:false});});
app.post('/queue/:id/release',(req,res)=>{const j=printJobs.get(req.params.id);if(!j)return res.status(404).send('JOB_NOT_FOUND');if(j.status!=='held')return res.status(409).send('JOB_NOT_HELD');j.status='queued';j.stage='queued';emitQueueUpdate(j);startPrinterWorker(printerQueueKey(j));res.json(publicJob(j));});
app.post('/queue/:id/priority',(req,res)=>{const j=printJobs.get(req.params.id);if(!j)return res.status(404).send('JOB_NOT_FOUND');const p=['normal','priority','urgent'].includes(req.body.priority)?req.body.priority:'normal';j.priority=p;emitQueueUpdate(j);if(j.status==='queued')startPrinterWorker(printerQueueKey(j));res.json(publicJob(j));});
app.post('/queue/:id/cancel',async(req,res)=>{const j=printJobs.get(req.params.id);if(!j)return res.status(404).send('JOB_NOT_FOUND');if(['success','failed','cancelled'].includes(j.status))return res.status(409).send('JOB_ALREADY_FINISHED');j.cancelRequested=true;if(['queued','held'].includes(j.status)){setJobStatus(j,'cancelled','cancelled');settleCompletion(j,new Error('JOB_CANCELLED'));return res.json({job:publicJob(j),spooler:null});}j.spoolerCancel=await tryCancelSpoolerJob(j);emitQueueUpdate(j);res.json({job:publicJob(j),spooler:j.spoolerCancel});});
app.post('/queue/:id/retry',(req,res)=>{const old=printJobs.get(req.params.id);if(!old)return res.status(404).send('JOB_NOT_FOUND');if(!old.sourcePath||!fs.existsSync(old.sourcePath))return res.status(410).send('SOURCE_EXPIRED');if(['queued','held','processing'].includes(old.status))return res.status(409).send('JOB_STILL_ACTIVE');const id=makeJobId(),ext=path.extname(old.sourcePath)||'.bin',retrySource=path.join(jobStoreDir,`${id}-source${ext}`);fs.copyFileSync(old.sourcePath,retrySource);const job={...old,id,sourcePath:retrySource,status:'queued',stage:'queued',createdAt:Date.now(),startedAt:null,finishedAt:null,error:'',cancelRequested:false,spoolerCancel:null,attempts:0,fingerprint:`${old.fingerprint}-retry-${id}`,completion:null,_resolve:null,_reject:null};createCompletion(job);enqueueJob(job);res.status(202).json(publicJob(job));});
app.get('/printer-status',async(req,res)=>{try{const name=String(req.query.name||'');const cap=await getWindowsPrinterCapabilities(name);const jobs=[...printJobs.values()].filter(j=>(j.options.printerName||'')===name&&!['success','failed','cancelled'].includes(j.status));res.json({name:cap.name||name,status:cap.status||'Unknown',offline:/offline/i.test(String(cap.status||'')),canDuplex:cap.canDuplex,supportsColor:cap.supportsColor,queued:jobs.filter(j=>j.status==='queued').length,printing:jobs.filter(j=>j.status==='processing').length,held:jobs.filter(j=>j.status==='held').length,paused:queuePaused});}catch(e){res.status(500).send(`PRINTER_STATUS_FAILED: ${e.message}`);}});

app.post('/print',
  (req,res,next)=>uploadDocument(req,res,err=>{if(!err)return next();const message=err.code==='LIMIT_FILE_SIZE'?`Ukuran file melebihi batas ${MAX_UPLOAD_MB} MB.`:`Upload gagal: ${err.message}`;return res.status(err.code==='LIMIT_FILE_SIZE'?413:400).send(message);}),
  async(req,res)=>{
    let uploaded=req.file?req.file.path:'';
    try{
      if(req.body.pin!==APP_PIN)throw Object.assign(new Error('PIN Salah!'),{statusCode:401});
      if(!req.file||!uploaded||!fs.existsSync(uploaded))throw new Error('File dokumen tidak ditemukan.');
      const originalName=req.file.originalname||'document',mimeType=req.file.mimetype||'',options=sanitizePrintOptions(req.body);options.sourceName=originalName;
      if(options.poster){options.booklet=false;options.impositionMode='normal';options.pagesPerSheet=1;options.duplexMode='simplex';}
      if(options.booklet){options.impositionMode='normal';options.pagesPerSheet=2;options.orientation='landscape';options.duplexMode='duplexshort';options.collate=true;options.pageSubset='all';options.pageOrder='normal';options.nupOrder='row-ltr';}
      if(options.impositionMode==='repeat-2')options.pagesPerSheet=2;
      else if(options.impositionMode==='repeat-4')options.pagesPerSheet=4;
      else if(options.impositionMode==='repeat-custom')options.pagesPerSheet=options.repeatCount;
      if(options.startCopyNewSheet||options.separatorMode==='between-copies')options.collate=true;
      const size=fs.statSync(uploaded).size,fingerprint=jobFingerprint(originalName,size,options),duplicate=findRecentDuplicate(fingerprint);
      if(duplicate&&String(req.body.allowDuplicate||'false')!=='true'){try{fs.unlinkSync(uploaded)}catch(_){};uploaded='';return res.status(409).json({code:'DUPLICATE_JOB',message:'Dokumen dengan printer dan pengaturan yang sama baru saja dikirim.',existingJob:publicJob(duplicate)});}
      const id=makeJobId(),sourcePath=copyToJobStore(uploaded,originalName,id);uploaded='';
      const priority=['normal','priority','urgent'].includes(req.body.jobPriority)?req.body.jobPriority:'normal';
      const hold=String(req.body.holdJob||'false')==='true';
      const device=String(req.headers['user-agent']||'').slice(0,160);
      const job={id,originalName,mimeType,sourcePath,fileSizeMb:Math.round(size/104857.6)/10,options,priority,status:hold?'held':'queued',stage:hold?'held':'queued',createdAt:Date.now(),startedAt:null,finishedAt:null,attempts:0,error:'',cancelRequested:false,device,fingerprint,metrics:{}};
      createCompletion(job);enqueueJob(job);
      if(hold||queuePaused)return res.status(202).json({queued:true,held:hold,paused:queuePaused,job:publicJob(job)});
      try{const result=await job.completion;res.setHeader('X-Print-Job-Id',job.id);return res.status(200).json({ok:true,job:result});}
      catch(e){return res.status(e.message==='JOB_CANCELLED'?409:500).send(e.message==='JOB_CANCELLED'?'JOB_CANCELLED':`PRINT_FAILED: ${e.message}`);}
    }catch(e){console.error('[PRINT SUBMIT ERROR]',e);if(uploaded){try{fs.unlinkSync(uploaded)}catch(_){}}return res.status(e.statusCode||500).send(e.message||'PRINT_FAILED');}
  }
);


server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

let bonjourInstances = [];
let bonjourServices = [];

function startLocalDiscovery() {
  if (!Bonjour) {
    console.warn('[DISCOVERY] mDNS tidak aktif. Jalankan npm install untuk memasang bonjour-service.');
    return;
  }
  const interfaces = getLocalInterfaceDetails();
  if (!interfaces.length) {
    console.warn('[DISCOVERY] mDNS dilewati karena tidak ada interface IPv4 non-loopback yang dapat dibaca.');
    return;
  }
  try {
    const hostname = os.hostname();
    const txt = { version: '4.6.8', path: '/', role: 'print-server-pro' };
    interfaces.forEach(item => {
      const instance = new Bonjour({ interface: item.address, bind: '0.0.0.0' }, error => {
        console.warn(`[DISCOVERY] mDNS ${item.address}: ${error.message}`);
      });
      instance.server?.mdns?.on?.('warning', error => console.warn(`[DISCOVERY] mDNS warning ${item.address}: ${error.message}`));
      instance.server?.mdns?.on?.('error', error => console.warn(`[DISCOVERY] mDNS error ${item.address}: ${error.message}`));
      bonjourInstances.push(instance);
      bonjourServices.push(
        instance.publish({ name: `Print Server Pro - ${hostname}`, type: 'printserverpro', protocol: 'tcp', port, host: `${hostname}.local`, txt }),
        instance.publish({ name: `Print Server Pro - ${hostname}`, type: 'http', protocol: 'tcp', port, host: `${hostname}.local`, txt }),
      );
    });
    console.log(`[DISCOVERY] mDNS aktif pada ${interfaces.length} interface: ${hostname}.local:${port}`);
  } catch (error) {
    console.warn(`[DISCOVERY] mDNS gagal: ${error.message}`);
    stopLocalDiscovery();
  }
}

function stopLocalDiscovery() {
  for (const service of bonjourServices) { try { service.stop?.(); } catch (_) {} }
  bonjourServices = [];
  for (const instance of bonjourInstances) { try { instance.destroy?.(); } catch (_) {} }
  bonjourInstances = [];
}

server.listen(port, '0.0.0.0', () => {
  console.log(`Print Server V4.6.8 Ready on ${port}`);
  const info = connectionInfoPayload();
  info.urls.forEach(url => console.log(`[NETWORK] ${url}`));
  startLocalDiscovery();
});

for (const signal of ['SIGINT','SIGTERM']) {
  process.on(signal, () => {
    stopLocalDiscovery();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  });
}
