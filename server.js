// server.js
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
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'); // ← agrego MessageMedia

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- Ensure dirs exist ---
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }
const uploadsDir = path.join(__dirname, 'uploads');
const reportsDir = path.join(__dirname, 'reports');
const mediaDir   = path.join(__dirname, 'media'); // NUEVO: carpeta para imagenes
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

// --- WhatsApp client ---
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

let lastQR = null;
let isReady = false;
let dataRows = []; // parsed CSV rows kept in memory
let sending = false;
let cancelFlag = false;

client.on('qr', async (qr) => {
  lastQR = await QRCode.toDataURL(qr);
  io.emit('qr', lastQR);
  console.log('[QR] Nuevo QR generado. Escanéalo en la interfaz web.');
});
client.on('ready', () => { isReady = true; io.emit('ready'); console.log('[WhatsApp] Cliente listo.'); });
client.on('authenticated', () => console.log('[WhatsApp] Autenticado.'));
client.on('auth_failure', (m) => { console.error('[WhatsApp] Falló autenticación:', m); io.emit('status', { level: 'error', message: 'Falló autenticación. Borra .wwebjs_auth si persiste.' }); });
client.on('disconnected', (reason) => { console.warn('[WhatsApp] Desconectado:', reason); isReady = false; io.emit('status', { level: 'warn', message: 'Desconectado. Reiniciando cliente...' }); client.initialize(); });
client.initialize();

// Acks: -1 error, 0 pendiente, 1 servidor, 2 dispositivo, 3 leído, 4 reproducido
client.on('message_ack', (msg, ack) => {
  io.emit('ack', { to: msg.to, ack });
});

// --- Helpers ---
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

// Encontrar la primera imagen existente por baseName en /media
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
      skip_empty_lines: false,    // para no perder filas vacías del ejemplo
      trim: false,                // respetar mensaje EXACTO (sin recortar)
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

// NUEVO: reset endpoint
app.post('/reset', (req, res) => {
  dataRows = [];
  sending = false;
  cancelFlag = false;
  lastQR = lastQR; // dejamos el QR actual si existe
  isReady = isReady;
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
    const isPapeleria = !!payload.isPapeleria; // NUEVO

    // Pre-carga de imagen para papelería (opcional si existe)
    let mediaForPapeleria = null;
    if (isPapeleria) {
      const preferred = findImagePath('imagen_uno') || findImagePath('imagen_dos');
      if (preferred) {
        try {
          mediaForPapeleria = MessageMedia.fromFilePath(preferred);
          console.log('[Media] Imagen para papelería:', path.basename(preferred));
        } catch (e) {
          console.warn('[Media] No se pudo cargar imagen:', e?.message || e);
        }
      } else {
        console.warn('[Media] No se encontró imagen_uno/imagen_dos en /media');
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
      // Solo usamos Nombre, Telefono, Mensaje tal como pediste
      const nombre = (row['Nombre'] ?? '').toString().trim();
      const telefonoRaw = (row['Telefono'] ?? '').toString().trim();
      const mensaje = (row['Mensaje'] ?? '').toString(); // NO TRIM: exacto como viene

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

        // Envío
        if (isPapeleria && mediaForPapeleria) {
          // Papelería: imagen + texto en 1 mensaje (caption)
          await client.sendMessage(numberId._serialized, mediaForPapeleria, { caption: mensaje });
          socket.emit('progress', { index: i + 1, total, telefono: telefonoE164, negocio: nombre || '-', status: 'enviado (papelería)' });
        } else {
          // Dentista (o si no hay imagen): solo texto, como ya lo tenías
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
