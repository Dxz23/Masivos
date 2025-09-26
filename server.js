/* eslint-disable no-console */
const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const { parse } = require('csv-parse');
const { Server } = require('socket.io');
const dayjs = require('dayjs');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

/* ---------- DATA_DIR con fallback (soluciona EACCES) ---------- */
function tryEnsureWritable(dir) {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch (e) {
    console.error('[DATA_DIR] No escribible:', dir, '-', e.message);
    return null;
  }
}

const CANDIDATES = [
  process.env.DATA_DIR,                 // lo que definas en Railway
  '/home/pptruser/data',               // HOME del usuario (recomendado para volume)
  '/data',                             // mount clásico (falla si es root:root 755)
  path.join(os.homedir(), 'data'),     // fallback en HOME
  '/tmp/masivos-data'                  // último recurso (no persistente)
];

const DATA_BASE = CANDIDATES.find(tryEnsureWritable) || '/tmp/masivos-data';
console.log('[DATA_DIR] Usando:', DATA_BASE);

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); }
  catch (e) { console.error('Error al asegurar dir:', p, '-', e.message); }
}

const SESS_DIR   = path.join(DATA_BASE, 'wwebjs_auth');
const uploadsDir = path.join(DATA_BASE, 'uploads');
const reportsDir = path.join(DATA_BASE, 'reports');
const mediaDir   = path.join(DATA_BASE, 'media');
const cacheDir   = path.join(DATA_BASE, 'wwebjs_cache');

[SESS_DIR, uploadsDir, reportsDir, mediaDir, cacheDir].forEach(ensureDir);

/* ---------- Static ---------- */
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(reportsDir));
app.use('/media', express.static(mediaDir));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* ---------- Multer (CSV) ---------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, 'contacts-' + Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

/* ---------- Detectar Chrome/Chromium ---------- */
function resolveChromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null; // deja que Puppeteer resuelva su Chromium
}
const chromePath = resolveChromePath();
console.log('[Puppeteer] executablePath =', chromePath || '(auto)');

/* ---------- Web version cache (lee variables) ---------- */
const WEB_CACHE_MODE   = (process.env.WEB_CACHE_MODE || 'remote').toLowerCase(); // 'remote' | 'local'
const WEB_CACHE_REMOTE = process.env.WEB_CACHE_REMOTE
  || 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/last.json';

const webVersionCache = WEB_CACHE_MODE === 'remote'
  ? { type: 'remote', remotePath: WEB_CACHE_REMOTE }
  : { type: 'local',  path: cacheDir };

/* ======================================================================= */
/* ===================== BLOQUE ORIGINAL (COMENTADO) ====================== */
/* =========== (se conserva para cumplir "sin quitar nada") ============== */
/*
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: SESS_DIR,
    clientId: 'masivos' // aísla sesiones entre deploys si tienes varios
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ],
    executablePath: chromePath || undefined
  },
  webVersionCache,
  takeoverOnConflict: true,
  restartOnAuthFailure: true
});

let lastQR = null;
let isReady = false;
client.on('qr', async (qr) => {
  try {
    lastQR = await QRCode.toDataURL(qr);
    io.emit('qr', lastQR);
    console.log('[QR] Nuevo QR generado.');
  } catch (e) {
    console.error('[QR] Error generando QR:', e?.message || e);
  }
});

client.on('ready', () => {
  isReady = true;
  io.emit('ready');
  console.log('[WhatsApp] Cliente listo.');
});

client.on('authenticated', () => console.log('[WhatsApp] Autenticado.'));

client.on('auth_failure', (m) => {
  console.error('[WhatsApp] Falló autenticación:', m);
  io.emit('status', { level: 'error', message: 'Autenticación fallida. Escanea el QR de nuevo.' });
});

client.on('disconnected', (reason) => {
  console.warn('[WhatsApp] Desconectado:', reason);
  isReady = false;
  io.emit('status', { level: 'warn', message: `Desconectado (${reason}). Reiniciando cliente...` });
  setTimeout(() => client.initialize().catch(() => {}), 1500);
});

client.on('message_ack', (msg, ack) => io.emit('ack', { to: msg.to, ack }));

client.initialize();
*/
/* =================== FIN BLOQUE ORIGINAL (COMENTADO) ==================== */
/* ======================================================================= */

/* ---------- Estado de datos y envío (se mantiene) ---------- */
let dataRows = [];
let sending = false;     // compat (global); ahora también habrá por cuenta
let cancelFlag = false;  // compat (global)

/* ---------- Helpers (se mantienen) ---------- */
function sanitizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();
  if (!s || s === 'nan' || s.includes('cerrado') || s.includes('cierra pronto')) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits;
}
function formatE164(countryCode, digits) {
  let d = digits;
  if (!d.startsWith(countryCode)) d = countryCode + d;
  return '+' + d;
}
async function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function csvEscape(v) { const s = (v ?? '').toString().replace(/"/g, '""'); return s.includes(',') ? `"${s}"` : s; }

const EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
function findImagePath(baseName) {
  for (const ext of EXTS) {
    const p = path.join(mediaDir, baseName + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/* ======================= NUEVO: MULTI-CUENTA WA ======================== */
const ACCOUNTS = ['dentista', 'papeleria']; // puedes cambiar nombres
const clients = {};
const ready = Object.create(null);
const lastQRs = Object.create(null);

// Estado por cuenta (permite 2 envíos en paralelo si quisieras)
const state = {};
for (const id of ACCOUNTS) state[id] = { sending: false, cancelFlag: false };

function createWaClient(accountId) {
  const c = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(SESS_DIR, accountId), // sesiones separadas
      clientId: accountId
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox','--disable-setuid-sandbox',
        '--disable-dev-shm-usage','--disable-gpu',
        '--no-zygote','--single-process'
      ],
      executablePath: chromePath || undefined
    },
    webVersionCache,
    takeoverOnConflict: true,
    restartOnAuthFailure: true
  });

  c.on('qr', async (qr) => {
    try {
      lastQRs[accountId] = await QRCode.toDataURL(qr);
      io.emit('qr', { accountId, dataUrl: lastQRs[accountId] });
      console.log(`[QR:${accountId}] nuevo QR`);
    } catch (e) {
      console.error(`[QR:${accountId}] Error QR:`, e?.message || e);
    }
  });

  c.on('ready', () => {
    ready[accountId] = true;
    io.emit('ready', { accountId });
    console.log(`[WhatsApp:${accountId}] listo`);
  });

  c.on('authenticated', () => console.log(`[WhatsApp:${accountId}] autenticado`));

  c.on('auth_failure', (m) => {
    console.error(`[WhatsApp:${accountId}] fallo auth:`, m);
    io.emit('status', { level: 'error', message: `(${accountId}) Autenticación fallida. Escanea el QR de nuevo.` });
  });

  c.on('disconnected', (reason) => {
    console.warn(`[WhatsApp:${accountId}] desconectado:`, reason);
    ready[accountId] = false;
    io.emit('status', { level: 'warn', message: `(${accountId}) Desconectado (${reason}). Reiniciando...` });
    setTimeout(() => c.initialize().catch(() => {}), 1500);
  });

  c.on('message_ack', (msg, ack) => io.emit('ack', { accountId, to: msg.to, ack }));

  return c;
}

// Inicializa ambas cuentas
for (const id of ACCOUNTS) {
  clients[id] = createWaClient(id);
  clients[id].initialize();
}

/* =================== NUEVO: FUNCIÓN DE ENVÍO POR CUENTA ================= */
async function sendCampaign(accountId, payload, socket) {
  if (!ready[accountId]) {
    socket.emit('status', { level: 'error', message: `(${accountId}) WhatsApp no está listo todavía.` });
    return;
  }
  if (state[accountId].sending) {
    socket.emit('status', { level: 'warn', message: `(${accountId}) Ya hay un envío en curso.` });
    return;
  }
  if (!dataRows || dataRows.length === 0) {
    socket.emit('status', { level: 'error', message: `(${accountId}) Carga primero un CSV.` });
    return;
  }

  const client = clients[accountId];

  const countryCode = String(payload.countryCode || '52').replace(/\D/g, '');
  const delayAfterMessageMs = Number(payload.delayAfterMessageMs || 1500);
  const delayBetweenContactsMs = Number(payload.delayBetweenContactsMs || 2500);
  const isPapeleria = !!payload.isPapeleria;

  // Carga de imágenes para Papelería (opcional)
  let mediaPapeleriaList = [];
  if (isPapeleria) {
    try {
      const p1 = findImagePath('imagen_uno');
      const p2 = findImagePath('imagen_dos');
      if (p1) mediaPapeleriaList.push(MessageMedia.fromFilePath(p1));
      if (p2) mediaPapeleriaList.push(MessageMedia.fromFilePath(p2));
      if (mediaPapeleriaList.length === 0) {
        console.warn('[Media] No hay imagen_uno/imagen_dos en', mediaDir);
      }
    } catch (e) {
      console.warn('[Media] No se pudieron cargar imágenes:', e?.message || e);
      mediaPapeleriaList = [];
    }
  }

  state[accountId].sending = true;
  state[accountId].cancelFlag = false;

  const total = dataRows.length;
  const results = [];
  const resultsValid = [];
  const resultsInvalid = [];
  let processed = 0;

  socket.emit('status', { level: 'info', message: `(${accountId}) Iniciando envío a ${total} filas...` });

  for (let i = 0; i < total; i++) {
    if (state[accountId].cancelFlag) break;

    const row = dataRows[i] || {};
    const nombre      = (row['Nombre']   ?? '').toString().trim();
    const telefonoRaw = (row['Telefono'] ?? '').toString().trim();
    const mensaje     = (row['Mensaje']  ?? '').toString(); // EXACTO

    let mando = 'no';
    let estadoNumero = 'invalido';
    let motivo = '-';
    let telefonoDigits = sanitizePhone(telefonoRaw);
    let telefonoE164   = telefonoRaw || '';

    try {
      if (!telefonoDigits) {
        motivo = 'vacío/descartado';
        socket.emit('progress', { accountId, index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'saltado' });
        results.push({ Telefono: telefonoE164, Negocio: nombre || '', 'Mando Mensaje': mando });
        resultsInvalid.push({ Telefono: telefonoE164, Negocio: nombre || '', Estado: estadoNumero, Motivo: motivo });
        processed++;
        continue;
      }

      telefonoE164 = formatE164(countryCode, telefonoDigits);

      // Verifica usuario de WhatsApp
      const numberId = await client.getNumberId(telefonoE164.replace(/\D/g, ''));
      if (!numberId) {
        motivo = 'no registrado en WhatsApp';
        socket.emit('progress', { accountId, index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'invalido' });
        results.push({ Telefono: telefonoE164, Negocio: nombre || '', 'Mando Mensaje': mando });
        resultsInvalid.push({ Telefono: telefonoE164, Negocio: nombre || '', Estado: estadoNumero, Motivo: motivo });
        processed++;
        await sleep(delayBetweenContactsMs);
        continue;
      }

      // Envío
      if (isPapeleria && mediaPapeleriaList.length > 0) {
        if (mediaPapeleriaList.length >= 2) {
          await client.sendMessage(numberId._serialized, mediaPapeleriaList[0], { caption: mensaje });
          await sleep(250);
          await client.sendMessage(numberId._serialized, mediaPapeleriaList[1]);
          socket.emit('progress', { accountId, index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'enviado (papelería: 2 imgs)' });
        } else {
          await client.sendMessage(numberId._serialized, mediaPapeleriaList[0], { caption: mensaje });
          socket.emit('progress', { accountId, index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'enviado (papelería: 1 img)' });
        }
      } else {
        await client.sendMessage(numberId._serialized, mensaje);
        socket.emit('progress', { accountId, index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'enviado' });
      }

      estadoNumero = 'activo';
      mando = 'si';
      await sleep(delayAfterMessageMs);
    } catch (err) {
      console.error(`[Envio:${accountId}] Error con ${telefonoE164}:`, err && err.message ? err.message : err);
      socket.emit('progress', { accountId, index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'error' });
      motivo = 'error envío';
    } finally {
      results.push({ Telefono: telefonoE164, Negocio: nombre || '', 'Mando Mensaje': mando });
      if (estadoNumero === 'activo') {
        resultsValid.push({ Telefono: telefonoE164, Negocio: nombre || '', Estado: estadoNumero, 'Mando Mensaje': mando });
      } else {
        resultsInvalid.push({ Telefono: telefonoE164, Negocio: nombre || '', Estado: estadoNumero, Motivo: motivo });
      }
      processed++;
      const percent = Math.round((processed / total) * 100);
      socket.emit('percent', { accountId, processed, total, percent });
      await sleep(delayBetweenContactsMs);
    }
  }

  // Reportes CSV
  const stamp = dayjs().format('YYYYMMDD-HHmmss');
  const reportAll     = path.join(reportsDir, `report-${accountId}-${stamp}.csv`);
  const reportValid   = path.join(reportsDir, `report-validos-${accountId}-${stamp}.csv`);
  const reportInvalid = path.join(reportsDir, `report-invalidos-${accountId}-${stamp}.csv`);

  fs.writeFileSync(
    reportAll,
    'Telefono,Negocio,Mando Mensaje\n' +
      results.map(r => `${csvEscape(r['Telefono'])},${csvEscape(r['Negocio'])},${csvEscape(r['Mando Mensaje'])}`).join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    reportValid,
    'Telefono,Negocio,Estado,Mando Mensaje\n' +
      resultsValid.map(r => `${csvEscape(r['Telefono'])},${csvEscape(r['Negocio'])},${csvEscape(r['Estado'])},${csvEscape(r['Mando Mensaje'])}`).join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    reportInvalid,
    'Telefono,Negocio,Estado,Motivo\n' +
      resultsInvalid.map(r => `${csvEscape(r['Telefono'])},${csvEscape(r['Negocio'])},${csvEscape(r['Estado'])},${csvEscape(r['Motivo'])}`).join('\n'),
    'utf8'
  );

  state[accountId].sending = false;
  io.emit('done', {
    accountId,
    reportUrl: `/reports/${path.basename(reportAll)}`,
    reportValidUrl: `/reports/${path.basename(reportValid)}`,
    reportInvalidUrl: `/reports/${path.basename(reportInvalid)}`
  });
  socket.emit('status', { level: 'success', message: `(${accountId}) Envío finalizado.` });
}

/* =================== NUEVO: SCHEDULER EN MEMORIA =================== */
const scheduledJobs = {}; // { jobId: { timeout, accountId, runAt, payload } }

function scheduleSend(accountId, runAtMs, payload, socket) {
  const now = Date.now();
  const delay = runAtMs - now;
  if (delay <= 0) {
    socket.emit('status', { level: 'error', message: 'La hora programada ya pasó.' });
    return;
  }
  const jobId = `job_${accountId}_${runAtMs}_${Math.random().toString(36).slice(2,7)}`;
  const timeout = setTimeout(async () => {
    io.emit('status', { level: 'info', message: `(${accountId}) Iniciando envío programado...` });
    delete scheduledJobs[jobId];
    await sendCampaign(accountId, payload, socket);
  }, delay);

  scheduledJobs[jobId] = { timeout, accountId, runAt: runAtMs, payload };
  socket.emit('scheduled', { jobId, accountId, runAt: runAtMs });
}

/* ---------- Endpoints ---------- */
app.post('/upload', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo.' });
  const rows = [];
  fs.createReadStream(req.file.path)
    .pipe(parse({
      columns: true,
      skip_empty_lines: false,
      trim: false,              // respetar el Mensaje EXACTO
      relax_quotes: true,
      relax_column_count: true
    }))
    .on('data', (row) => rows.push(row))
    .on('end', () => {
      dataRows = rows;
      console.log(`[CSV] Cargadas ${rows.length} filas.`);
      res.json({ ok: true, count: rows.length, filename: path.basename(req.file.path) });
    })
    .on('error', (err) => {
      console.error('[CSV] Error al parsear:', err);
      res.status(500).json({ ok: false, message: 'Error al parsear CSV.' });
    });
});

app.post('/reset', (_req, res) => {
  dataRows = [];
  sending = false;     // compat
  cancelFlag = false;  // compat
  for (const id of ACCOUNTS) {
    state[id].sending = false;
    state[id].cancelFlag = false;
  }
  res.json({ ok: true });
});

/* ---------- Socket.IO ---------- */
io.on('connection', (socket) => {
  console.log('[Socket] Cliente conectado.');

  // Emitir estado/QR por cada cuenta
  for (const id of ACCOUNTS) {
    if (lastQRs[id]) socket.emit('qr', { accountId: id, dataUrl: lastQRs[id] });
    if (ready[id]) socket.emit('ready', { accountId: id });
  }

  // Envío inmediato (con cuenta)
  socket.on('start-sending', async (payload = {}) => {
    const accountId = (payload.accountId || 'dentista');
    await sendCampaign(accountId, payload, socket);
  });

  // Programar envío
  socket.on('schedule-sending', (payload = {}) => {
    const accountId = (payload.accountId || 'dentista');
    const runAtMs = Number(payload.scheduleAtMs || 0);
    if (!runAtMs || Number.isNaN(runAtMs)) {
      socket.emit('status', { level: 'error', message: 'Fecha/hora inválida.' });
      return;
    }
    scheduleSend(accountId, runAtMs, {
      countryCode: payload.countryCode,
      delayAfterMessageMs: payload.delayAfterMessageMs,
      delayBetweenContactsMs: payload.delayBetweenContactsMs,
      isPapeleria: payload.isPapeleria
    }, socket);
  });

  // Cancelar un envío programado
  socket.on('cancel-schedule', ({ jobId }) => {
    const job = scheduledJobs[jobId];
    if (!job) return socket.emit('status', { level: 'warn', message: 'No existe ese job.' });
    clearTimeout(job.timeout);
    delete scheduledJobs[jobId];
    socket.emit('status', { level: 'success', message: `Programación cancelada (${jobId}).` });
    socket.emit('schedule-cancelled', { jobId });
  });

  // Detener envío en curso (si no se especifica cuenta, cancela todas)
  socket.on('stop-sending', (payload = {}) => {
    const aid = payload.accountId;
    if (aid && state[aid]?.sending) {
      state[aid].cancelFlag = true;
      socket.emit('status', { level: 'warn', message: `(${aid}) Cancelando envío...` });
      return;
    }
    let any = false;
    for (const id of ACCOUNTS) {
      if (state[id].sending) {
        state[id].cancelFlag = true;
        any = true;
      }
    }
    socket.emit('status', { level: any ? 'warn' : 'info', message: any ? 'Cancelando envíos...' : 'No hay envíos en curso.' });
  });

  socket.on('disconnect', () => console.log('[Socket] Cliente desconectado.'));
});

/* ---------- Start ---------- */
server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
