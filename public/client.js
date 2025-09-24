
// Mantengo TODO lo que tenías y agrego lo nuevo marcado

const socket = io();

const statusEl = document.getElementById('status');
const qrCanvas = document.getElementById('qr');
const qrWrap = document.getElementById('qr-wrap');
const btnUpload = document.getElementById('btn-upload');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');              // NUEVO
const inputCsv = document.getElementById('csv');
const uploadInfo = document.getElementById('upload-info');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const logEl = document.getElementById('log');
const reportEl = document.getElementById('report');

const countryCode = document.getElementById('countryCode');
const delayAfterMessageMs = document.getElementById('delayAfterMessageMs');
const delayBetweenContactsMs = document.getElementById('delayBetweenContactsMs');
const isPapeleria = document.getElementById('isPapeleria');        // NUEVO

let uploaded = false;

function logLine(text, level = 'info'){
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  if (level === 'error') line.style.color = '#ef4444';
  if (level === 'warn') line.style.color = '#f59e0b';
  if (level === 'success') line.style.color = '#22c55e';
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text){ statusEl.textContent = text; }

function drawQR(dataURL){
  if (!dataURL) return;
  const ctx = qrCanvas.getContext('2d');
  const img = new Image();
  img.onload = function(){ qrCanvas.width = img.width; qrCanvas.height = img.height; ctx.drawImage(img, 0, 0); }
  img.src = dataURL;
}

socket.on('qr', (dataUrl) => { setStatus('Escanea el QR en tu WhatsApp > Dispositivos vinculados.'); drawQR(dataUrl); qrWrap.style.display = 'flex'; });
socket.on('ready', () => { setStatus('WhatsApp listo ✔'); qrWrap.style.display = 'none'; logLine('Cliente WhatsApp listo.', 'success'); });
socket.on('status', (p) => { logLine(p.message, p.level); });
socket.on('progress', (p) => { logLine(`(${p.index}/${p.total}) ${p.negocio} - ${p.telefono} => ${p.status}`); });

// ⬇⬇⬇ CAMBIO 1: clamp + redondeo 0..100 ⬇⬇⬇
socket.on('percent', (p) => {
  const pct = Math.max(0, Math.min(100, Math.round(Number(p.percent ?? 0))));
  progressBar.style.width = pct + '%';
  progressText.textContent = pct + '%';
});
// ⬆⬆⬆ CAMBIO 1 ⬆⬆⬆

// Ack log
const ACK_MAP = { "-1":"ACK_ERROR", "0":"ACK_PENDING", "1":"ACK_SERVER", "2":"ACK_DEVICE", "3":"ACK_READ", "4":"ACK_PLAYED" };
socket.on('ack', ({to, ack}) => { logLine(`ACK ${ACK_MAP[String(ack)] || ack} para ${to}`); });

socket.on('done', (info) => {
  // ⬇⬇⬇ CAMBIO 2: forzar 100% al terminar ⬇⬇⬇
  progressBar.style.width = '100%';
  progressText.textContent = '100%';
  // ⬆⬆⬆ CAMBIO 2 ⬆⬆⬆

  btnStart.disabled = false; btnStop.disabled = true; reportEl.innerHTML = '';
  const list = document.createElement('ul'); list.style.listStyle = 'none'; list.style.paddingLeft = '0';
  const mkLink = (href, text) => { const li = document.createElement('li'); const a = document.createElement('a'); a.href = href; a.textContent = text; a.setAttribute('download',''); li.appendChild(a); return li; };
  if (info.reportUrl){ list.appendChild(mkLink(info.reportUrl, 'Descargar reporte completo (Telefono, Negocio, Mando Mensaje)')); }
  if (info.reportValidUrl){ list.appendChild(mkLink(info.reportValidUrl, 'Descargar reporte: Números válidos/activos')); }
  if (info.reportInvalidUrl){ list.appendChild(mkLink(info.reportInvalidUrl, 'Descargar reporte: Números inválidos')); }
  reportEl.appendChild(list);
  logLine('Proceso finalizado.', 'success');
});

btnUpload.addEventListener('click', async () => {
  reportEl.innerHTML = '';
  if (!inputCsv.files || inputCsv.files.length === 0){ alert('Selecciona un CSV primero.'); return; }
  const fd = new FormData(); fd.append('csv', inputCsv.files[0]);
  btnUpload.disabled = true;
  try{
    const res = await fetch('/upload', { method:'POST', body: fd });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Error al subir');
    uploadInfo.textContent = `CSV cargado: ${data.count} filas.`;
    logLine(`CSV cargado (${data.count} filas).`);
    uploaded = true; btnStart.disabled = false;
  }catch(e){ logLine('Error al subir CSV: ' + e.message, 'error'); }
  finally{ btnUpload.disabled = false; }
});

btnStart.addEventListener('click', () => {
  if (!uploaded){ alert('Carga un CSV primero.'); return; }
  progressBar.style.width = '0%'; progressText.textContent = '0%'; reportEl.innerHTML = '';
  btnStart.disabled = true; btnStop.disabled = false;
  socket.emit('start-sending', {
    countryCode: countryCode.value,
    delayAfterMessageMs: Number(delayAfterMessageMs.value),
    delayBetweenContactsMs: Number(delayBetweenContactsMs.value),
    isPapeleria: !!isPapeleria.checked, // NUEVO
  });
});

btnStop.addEventListener('click', () => { socket.emit('stop-sending'); btnStop.disabled = true; btnStart.disabled = false; });

// NUEVO: reiniciar todo
btnReset.addEventListener('click', async () => {
  if (!confirm('¿Reiniciar todo? Esto limpia CSV cargado, progreso y log.')) return;
  try {
    const res = await fetch('/reset', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Error al reiniciar');
    // limpiar UI
    uploaded = false;
    inputCsv.value = '';
    uploadInfo.textContent = '';
    reportEl.innerHTML = '';
    logEl.innerHTML = '';
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    btnStart.disabled = true;
    btnStop.disabled = true;
    logLine('Aplicación reiniciada.', 'success');
  } catch (e) {
    logLine('Error al reiniciar: ' + e.message, 'error');
  }
});
