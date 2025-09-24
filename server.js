/* eslint-disable no-console */
const express = require('express');
const http = require('http');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { parse } = require('csv-parse');
const { Server } = require('socket.io');
const dayjs = require('dayjs');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

/* ---------- Rutas de datos (persisten en el Volume /data) ---------- */
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }

const DATA_BASE = process.env.DATA_DIR || '/data'; // tu Volume en Railway
ensureDir(DATA_BASE);

const SESS_DIR    = path.join(DATA_BASE, 'wwebjs_auth'); // sesión persistente
const uploadsDir  = path.join(DATA_BASE, 'uploads');
const reportsDir  = path.join(DATA_BASE, 'reports');
const mediaDir    = path.join(DATA_BASE, 'media');

[SESS_DIR, uploadsDir, reportsDir, mediaDir].forEach(ensureDir);

/* ---------- Static ---------- */
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(reportsDir));
app.use('/media', express.static(mediaDir)); // opcional para ver/servir tus imágenes
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_req, res) => res.status(200).send('ok')); // útil si configuras healthcheck

/* ---------- Multer (CSV) ---------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) =>
    cb(null, 'contacts-' + Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

/* ---------- Chrome/Chromium path ---------- */
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
  return null; // Puppeteer resolverá su Chromium propio si queda null
}
const chromePath = resolveChromePath();
console.log('[Puppeteer] executablePath =', chromePath || '(auto)');

/* ---------- WhatsApp Client ---------- */
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESS_DIR }),
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
  // Evita errores de inyección por cambios de WA Web
  webVersionCache: { type: 'remote' }, // usa cache remota mantenida por wwebjs
  // Si tu número saca LOGOUT, vuelve a mostrar QR
  takeoverOnConflict: true,
  restartOnAuthFailure: true
});

let lastQR = null;
let isReady = false;
let dataRows = [];
let sending = false;
let cancelFlag = false;

/* ---------- Eventos WhatsApp ---------- */
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
  // Reintento suave tras desconexión
  setTimeout(() => client.initialize().catch(() => {}), 1500);
});

client.on('message_ack', (msg, ack) => {
  io.emit('ack', { to: msg.to, ack });
});

client.initialize();

/* ---------- Helpers negocio ---------- */
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

const EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
function findImagePath(baseName) {
  for (const ext of EXTS) {
    const p = path.join(mediaDir, baseName + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function csvEscape(v) { const s = (v ?? '').toString().replace(/"/g, '""'); return s.includes(',') ? `"${s}"` : s; }

/* ---------- Endpoints ---------- */
app.post('/upload', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo.' });
  const rows = [];
  fs.createReadStream(req.file.path)
    .pipe(parse({
      columns: true,
      skip_empty_lines: false,   // no perder filas vacías
      trim: false,               // respetar Mensaje EXACTO (sin recortar)
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
  sending = false;
  cancelFlag = false;
  res.json({ ok: true });
});

/* ---------- Socket.IO ---------- */
io.on('connection', (socket) => {
  console.log('[Socket] Cliente conectado.');
  if (lastQR) socket.emit('qr', lastQR);
  if (isReady) socket.emit('ready');

  socket.on('start-sending', async (payload) => {
    if (!isReady) return socket.emit('status', { level: 'error', message: 'WhatsApp no está listo todavía.' });
    if (sending) return socket.emit('status', { level: 'warn', message: 'Ya hay un envío en curso.' });
    if (!dataRows || dataRows.length === 0) return socket.emit('status', { level: 'error', message: 'Carga primero un CSV.' });

    const countryCode = String(payload.countryCode || '52').replace(/\D/g, '');
    const delayAfterMessageMs = Number(payload.delayAfterMessageMs || 1500);
    const delayBetweenContactsMs = Number(payload.delayBetweenContactsMs || 2500);
    const isPapeleria = !!payload.isPapeleria;

    // Carga de imágenes (papelería)
    let mediaPapeleriaList = [];
    if (isPapeleria) {
      try {
        const p1 = findImagePath('imagen_uno');
        const p2 = findImagePath('imagen_dos');
        if (p1) {
          mediaPapeleriaList.push(MessageMedia.fromFilePath(p1));
          console.log('[Media] Papelería:', path.basename(p1));
        }
        if (p2) {
          mediaPapeleriaList.push(MessageMedia.fromFilePath(p2));
          console.log('[Media] Papelería:', path.basename(p2));
        }
        if (mediaPapeleriaList.length === 0) {
          console.warn('[Media] No hay imagen_uno/imagen_dos en /data/media');
        }
      } catch (e) {
        console.warn('[Media] No se pudieron cargar imágenes:', e?.message || e);
        mediaPapeleriaList = [];
      }
    }

    sending = true;
    cancelFlag = false;

    const total = dataRows.length;
    const results = [];
    const resultsValid = [];
    const resultsInvalid = [];
    let processed = 0;

    socket.emit('status', { level: 'info', message: `Iniciando envío a ${total} filas...` });

    for (let i = 0; i < total; i++) {
      if (cancelFlag) break;

      const row = dataRows[i] || {};
      const nombre      = (row['Nombre']   ?? '').toString().trim();
      const telefonoRaw = (row['Telefono'] ?? '').toString().trim();
      const mensaje     = (row['Mensaje']  ?? '').toString(); // EXACTO (sin trim)

      let mando = 'no';
      let estadoNumero = 'invalido';
      let motivo = '-';
      let telefonoDigits = sanitizePhone(telefonoRaw);
      let telefonoE164   = telefonoRaw || '';

      try {
        if (!telefonoDigits) {
          motivo = 'vacío/descartado';
          socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'saltado' });
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
          socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'invalido' });
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
            await sleep(250); // pequeño gap para agrupar como álbum
            await client.sendMessage(numberId._serialized, mediaPapeleriaList[1]);
            socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'enviado (papelería: 2 imgs)' });
          } else {
            await client.sendMessage(numberId._serialized, mediaPapeleriaList[0], { caption: mensaje });
            socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'enviado (papelería: 1 img)' });
          }
        } else {
          await client.sendMessage(numberId._serialized, mensaje);
          socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'enviado' });
        }

        estadoNumero = 'activo';
        mando = 'si';
        await sleep(delayAfterMessageMs);
      } catch (err) {
        console.error(`[Envio] Error con ${telefonoE164}:`, err && err.message ? err.message : err);
        socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'error' });
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
        socket.emit('percent', { processed, total, percent });
        await sleep(delayBetweenContactsMs);
      }
    }

    // Reportes
    const stamp = dayjs().format('YYYYMMDD-HHmmss');
    const reportAll     = path.join(reportsDir, `report-${stamp}.csv`);
    const reportValid   = path.join(reportsDir, `report-validos-${stamp}.csv`);
    const reportInvalid = path.join(reportsDir, `report-invalidos-${stamp}.csv`);

    fs.writeFileSync(reportAll, 'Telefono,Negocio,Mando Mensaje\n' +
      results.map(r => `${csvEscape(r['Telefono'])},${csvEscape(r['Negocio'])},${csvEscape(r['Mando Mensaje'])}`).join('\n'), 'utf8');

    fs.writeFileSync(reportValid, 'Telefono,Negocio,Estado,Mando Mensaje\n' +
      resultsValid.map(r => `${csvEscape(r['Telefono'])},${csvEscape(r['Negocio'])},${csvEscape(r['Estado'])},${csvEscape(r['Mando Mensaje'])}`).join('\n'), 'utf8');

    fs.writeFileSync(reportInvalid, 'Telefono,Negocio,Estado,Motivo\n' +
      resultsInvalid.map(r => `${csvEscape(r['Telefono'])},${csvEscape(r['Negocio'])},${csvEscape(r['Estado'])},${csvEscape(r['Motivo'])}`).join('\n'), 'utf8');

    sending = false;
    socket.emit('done', {
      reportUrl: `/reports/${path.basename(reportAll)}`,
      reportValidUrl: `/reports/${path.basename(reportValid)}`,
      reportInvalidUrl: `/reports/${path.basename(reportInvalid)}`
    });
    socket.emit('status', { level: 'success', message: 'Envío finalizado.' });
  });

  socket.on('stop-sending', () => {
    if (sending) {
      cancelFlag = true;
      socket.emit('status', { level: 'warn', message: 'Cancelando envío...' });
    }
  });

  socket.on('disconnect', () => console.log('[Socket] Cliente desconectado.'));
});

/* ---------- Start ---------- */
server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
