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

// --- Ensure dirs exist ---
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }
const uploadsDir = path.join(__dirname, 'uploads');
const reportsDir = path.join(__dirname, 'reports');
const mediaDir   = path.join(__dirname, 'media'); // carpeta para imágenes
ensureDir(uploadsDir); ensureDir(reportsDir); ensureDir(mediaDir);

// --- Static ---
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/reports', express.static(reportsDir));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- Multer for CSV uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, 'contacts-' + Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// --- Helper: detectar ruta de Chrome/Chromium en el contenedor ---
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
  return null; // si queda null, Puppeteer resuelve automáticamente
}
const chromePath = resolveChromePath();
console.log('[Puppeteer] executablePath =', chromePath || '(auto)');

// --- WhatsApp client (ÚNICA definición) ---
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ],
    executablePath: chromePath
  }
});

let lastQR = null;
let isReady = false;
let dataRows = []; // parsed CSV rows kept in memory
let sending = false;
let cancelFlag = false;

// Eventos de WhatsApp
client.on('qr', async (qr) => {
  lastQR = await QRCode.toDataURL(qr);
  io.emit('qr', lastQR);
  console.log('[QR] Nuevo QR generado. Escanéalo en la interfaz web.');
});
client.on('ready', () => { isReady = true; io.emit('ready'); console.log('[WhatsApp] Cliente listo.'); });
client.on('authenticated', () => console.log('[WhatsApp] Autenticado.'));
client.on('auth_failure', (m) => { console.error('[WhatsApp] Falló autenticación:', m); io.emit('status', { level: 'error', message: 'Falló autenticación. Borra .wwebjs_auth si persiste.' }); });
client.on('disconnected', (reason) => { console.warn('[WhatsApp] Desconectado:', reason); isReady = false; io.emit('status', { level: 'warn', message: 'Desconectado. Reiniciando cliente...' }); client.initialize(); });
// Acks: -1 error, 0 pendiente, 1 servidor, 2 dispositivo, 3 leído, 4 reproducido
client.on('message_ack', (msg, ack) => io.emit('ack', { to: msg.to, ack }));

// Inicializa el cliente (una sola vez)
client.initialize();

// --- Helpers de negocio ---
function sanitizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();
  if (!s || s === 'nan' || s.includes('cerrado') || s.includes('cierra pronto')) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits;
}
function formatE164(countryCode, digits){
  let d = digits;
  if (!d.startsWith(countryCode)) {
    if (d.length === 10) d = countryCode + d;
    else d = countryCode + d;
  }
  return '+' + d;
}
async function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function csvEscape(v) { const s = (v ?? '').toString().replace(/"/g, '""'); return s.includes(',') ? `"${s}"` : s; }

// Buscar imágenes existentes por nombre base en /media
const EXTS = ['.jpg','.jpeg','.png','.webp'];
function findImagePath(baseName){
  for (const ext of EXTS) {
    const p = path.join(mediaDir, baseName + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// --- Upload endpoint ---
app.post('/upload', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió archivo.' });
  const rows = [];
  fs.createReadStream(req.file.path)
    .pipe(parse({
      columns: true,
      skip_empty_lines: false, // mantener filas vacías del ejemplo
      trim: false,             // NO recortar: respetar el Mensaje EXACTO
      relax_quotes: true,
      relax_column_count: true
    }))
    .on('data', (row) => rows.push(row))
    .on('end', () => {
      dataRows = rows;
      console.log(`[CSV] Cargadas ${rows.length} filas.`);
      res.json({ ok: true, count: rows.length, filename: path.basename(req.file.path) });
    })
    .on('error', (err) => { console.error('[CSV] Error al parsear:', err); res.status(500).json({ ok: false, message: 'Error al parsear CSV.' }); });
});

// Reset endpoint (para botón "Reiniciar todo")
app.post('/reset', (req, res) => {
  dataRows = [];
  sending = false;
  cancelFlag = false;
  return res.json({ ok: true });
});

// --- Socket.IO ---
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

    // Pre-carga de IMÁGENES para Papelería: intenta uno y dos
    let mediaPapeleriaList = [];
    if (isPapeleria) {
      const p1 = findImagePath('imagen_uno');
      const p2 = findImagePath('imagen_dos');
      try {
        if (p1) {
          mediaPapeleriaList.push(MessageMedia.fromFilePath(p1));
          console.log('[Media] Imagen para papelería:', path.basename(p1));
        }
        if (p2) {
          mediaPapeleriaList.push(MessageMedia.fromFilePath(p2));
          console.log('[Media] Imagen para papelería:', path.basename(p2));
        }
        if (mediaPapeleriaList.length === 0) {
          console.warn('[Media] No se encontró imagen_uno/imagen_dos en /media');
        }
      } catch (e) {
        console.warn('[Media] No se pudieron cargar imágenes:', e?.message || e);
        mediaPapeleriaList = [];
      }
    }

    sending = true; cancelFlag = false;

    const total = dataRows.length;
    const results = [];        // completo (Telefono, Negocio, Mando Mensaje)
    const resultsValid = [];   // válidos
    const resultsInvalid = []; // inválidos
    let processed = 0;

    socket.emit('status', { level: 'info', message: `Iniciando envío a ${total} filas...` });

    for (let i = 0; i < total; i++) {
      if (cancelFlag) break;
      const row = dataRows[i] || {};
      // Solo usamos Nombre, Telefono, Mensaje tal cual
      const nombre = (row['Nombre'] ?? '').toString().trim();
      const telefonoRaw = (row['Telefono'] ?? '').toString().trim();
      const mensaje = (row['Mensaje'] ?? '').toString(); // EXACTO, sin trim

      let mando = 'no';
      let estadoNumero = 'invalido';
      let motivo = '-';
      let telefonoDigits = sanitizePhone(telefonoRaw);
      let telefonoE164 = telefonoRaw || '';

      try {
        if (!telefonoDigits) {
          motivo = 'vacío/descartado';
          socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'saltado' });
          results.push({ Telefono: telefonoE164, Negocio: nombre || '', "Mando Mensaje": mando });
          resultsInvalid.push({ Telefono: telefonoE164, Negocio: nombre || '', Estado: estadoNumero, Motivo: motivo });
          processed++; continue;
        }

        telefonoE164 = formatE164(countryCode, telefonoDigits);

        // Verifica si es usuario de WhatsApp y usa la serialización devuelta
        const numberId = await client.getNumberId(telefonoE164.replace(/\D/g, ''));
        if (!numberId) {
          motivo = 'no registrado en WhatsApp';
          socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'invalido' });
          results.push({ Telefono: telefonoE164, Negocio: nombre || '', "Mando Mensaje": mando });
          resultsInvalid.push({ Telefono: telefonoE164, Negocio: nombre || '', Estado: estadoNumero, Motivo: motivo });
          processed++;
          await sleep(delayBetweenContactsMs);
          continue;
        }

        // Envío según modo
        if (isPapeleria && mediaPapeleriaList.length > 0) {
          // Si hay DOS imágenes: 1) primera con caption (MENSAJE EXACTO), 2) segunda sin caption
          if (mediaPapeleriaList.length >= 2) {
            await client.sendMessage(numberId._serialized, mediaPapeleriaList[0], { caption: mensaje });
            await sleep(250); // pausa corta para que WhatsApp agrupe
            await client.sendMessage(numberId._serialized, mediaPapeleriaList[1]);
            socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'enviado (papelería: 2 imgs)' });
          } else {
            // Solo una imagen disponible
            await client.sendMessage(numberId._serialized, mediaPapeleriaList[0], { caption: mensaje });
            socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'enviado (papelería: 1 img)' });
          }
        } else {
          // Modo Dentista (o sin imágenes): solo TEXTO
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
        results.push({ Telefono: telefonoE164, Negocio: nombre || '', "Mando Mensaje": mando });
        if (estadoNumero === 'activo') {
          resultsValid.push({ Telefono: telefonoE164, Negocio: nombre || '', Estado: estadoNumero, "Mando Mensaje": mando });
        } else {
          resultsInvalid.push({ Telefono: telefonoE164, Negocio: nombre || '', Estado: estadoNumero, Motivo: motivo });
        }
        processed++;
        const percent = Math.round((processed / total) * 100);
        socket.emit('percent', { processed, total, percent });
        await sleep(delayBetweenContactsMs);
      }
    }

    // --- Reportes ---
    const stamp = dayjs().format('YYYYMMDD-HHmmss');
    const reportAll = path.join(reportsDir, `report-${stamp}.csv`);
    const reportValid = path.join(reportsDir, `report-validos-${stamp}.csv`);
    const reportInvalid = path.join(reportsDir, `report-invalidos-${stamp}.csv`);

    fs.writeFileSync(reportAll, 'Telefono,Negocio,Mando Mensaje\n' + results.map(r => `${csvEscape(r['Telefono'])},${csvEscape(r['Negocio'])},${csvEscape(r['Mando Mensaje'])}`).join('\n'), 'utf8');
    fs.writeFileSync(reportValid, 'Telefono,Negocio,Estado,Mando Mensaje\n' + resultsValid.map(r => `${csvEscape(r['Telefono'])},${csvEscape(r['Negocio'])},${csvEscape(r['Estado'])},${csvEscape(r['Mando Mensaje'])}`).join('\n'), 'utf8');
    fs.writeFileSync(reportInvalid, 'Telefono,Negocio,Estado,Motivo\n' + resultsInvalid.map(r => `${csvEscape(r['Telefono'])},${csvEscape(r['Negocio'])},${csvEscape(r['Estado'])},${csvEscape(r['Motivo'])}`).join('\n'), 'utf8');

    sending = false;
    socket.emit('done', { 
      reportUrl: `/reports/${path.basename(reportAll)}`,
      reportValidUrl: `/reports/${path.basename(reportValid)}`,
      reportInvalidUrl: `/reports/${path.basename(reportInvalid)}`
    });
    socket.emit('status', { level: 'success', message: `Envío finalizado.` });
  });

  socket.on('stop-sending', () => { if (sending) { cancelFlag = true; socket.emit('status', { level: 'warn', message: 'Cancelando envío...' }); } });
  socket.on('disconnect', () => console.log('[Socket] Cliente desconectado.'));
});

server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
