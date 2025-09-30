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

// NUEVO: selección de cuenta y scheduler
const accountId = document.getElementById('accountId');             // NUEVO
const doSchedule = document.getElementById('doSchedule');           // NUEVO
const scheduleAt = document.getElementById('scheduleAt');           // NUEVO

let uploaded = false;

// NUEVO: mapas por cuenta para mostrar el QR correcto
const lastQRs = {};   // {accountId: dataUrl}
const readyMap = {};  // {accountId: boolean}

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

// COMPAT: el servidor ahora puede enviar {accountId,dataUrl} o un string (legado)
socket.on('qr', (payload) => {
  const isString = typeof payload === 'string';
  const aid = isString ? 'dentista' : payload.accountId;
  const dataUrl = isString ? payload : payload.dataUrl;
  lastQRs[aid] = dataUrl;
  if (aid === accountId.value) {
    setStatus(`(${aid}) Escanea el QR en tu WhatsApp > Dispositivos vinculados.`);
    drawQR(dataUrl); qrWrap.style.display = 'flex';
  }
});

// COMPAT: ahora llega {accountId}
socket.on('ready', (payload) => {
  const aid = payload?.accountId || 'dentista';
  readyMap[aid] = true;
  if (aid === accountId.value) {
    setStatus(`(${aid}) WhatsApp listo ✔`);
    qrWrap.style.display = 'none';
  }
  logLine(`Cliente WhatsApp listo (${aid}).`, 'success');
});

socket.on('status', (p) => { logLine(p.message, p.level); });

// Progreso (ahora con accountId)
socket.on('progress', (p) => {
  const tag = p.accountId ? `[${p.accountId}] ` : '';
  logLine(`${tag}(${p.index}/${p.total}) ${p.negocio} - ${p.telefono} => ${p.status}`);
});

// ⬇⬇⬇ CAMBIO 1: clamp + redondeo 0..100 ⬇⬇⬇
socket.on('percent', (p) => {
  const pct = Math.max(0, Math.min(100, Math.round(Number(p.percent ?? 0))));
  progressBar.style.width = pct + '%';
  progressText.textContent = pct + '%';
});
// ⬆⬆⬆ CAMBIO 1 ⬆⬆⬆

// Ack log (ahora con accountId)
const ACK_MAP = { "-1":"ACK_ERROR", "0":"ACK_PENDING", "1":"ACK_SERVER", "2":"ACK_DEVICE", "3":"ACK_READ", "4":"ACK_PLAYED" };
socket.on('ack', ({accountId: aid, to, ack}) => {
  const tag = aid ? `[${aid}] ` : '';
  logLine(`${tag}ACK ${ACK_MAP[String(ack)] || ack} para ${to}`);
});

socket.on('done', (info) => {
  // ⬇⬇⬇ CAMBIO 2: forzar 100% al terminar ⬇⬇⬇
  progressBar.style.width = '100%';
  progressText.textContent = '100%';
  // ⬆⬆⬆ CAMBIO 2 ⬆⬆⬆

  btnStart.disabled = false; btnStop.disabled = true; reportEl.innerHTML = '';
  const list = document.createElement('ul'); list.style.listStyle = 'none'; list.style.paddingLeft = '0';
  const mkLink = (href, text) => { const li = document.createElement('li'); const a = document.createElement('a'); a.href = href; a.textContent = text; a.setAttribute('download',''); li.appendChild(a); return li; };
  if (info.reportUrl){ list.appendChild(mkLink(info.reportUrl, `(${info.accountId || 'cuenta'}) Reporte completo (Telefono, Negocio, Mando Mensaje)`)); }
  if (info.reportValidUrl){ list.appendChild(mkLink(info.reportValidUrl, `(${info.accountId || 'cuenta'}) Números válidos/activos`)); }
  if (info.reportInvalidUrl){ list.appendChild(mkLink(info.reportInvalidUrl, `(${info.accountId || 'cuenta'}) Números inválidos`)); }
  reportEl.appendChild(list);
  logLine(`(${info.accountId || 'cuenta'}) Proceso finalizado.`, 'success');
});

// Cambiar UI de QR/estado al cambiar cuenta
accountId.addEventListener('change', () => {
  const aid = accountId.value;
  if (readyMap[aid]) {
    setStatus(`(${aid}) WhatsApp listo ✔`);
    qrWrap.style.display = 'none';
  } else if (lastQRs[aid]) {
    setStatus(`(${aid}) Escanea el QR en tu WhatsApp > Dispositivos vinculados.`);
    drawQR(lastQRs[aid]);
    qrWrap.style.display = 'flex';
  } else {
    setStatus(`(${aid}) Esperando QR...`);
    qrWrap.style.display = 'flex';
  }
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

// Enviar ahora o programar
btnStart.addEventListener('click', () => {
  if (!uploaded){ alert('Carga un CSV primero.'); return; }
  progressBar.style.width = '0%'; progressText.textContent = '0%'; reportEl.innerHTML = '';
  btnStart.disabled = true; btnStop.disabled = false;

  const payload = {
    accountId: accountId.value,
    countryCode: countryCode.value,
    delayAfterMessageMs: Number(delayAfterMessageMs.value),
    delayBetweenContactsMs: Number(delayBetweenContactsMs.value),
    isPapeleria: !!isPapeleria.checked, // NUEVO
  };

  if (doSchedule.checked) {
    if (!scheduleAt.value) {
      alert('Selecciona fecha/hora.');
      btnStart.disabled = false; btnStop.disabled = true;
      return;
    }
    const whenMs = new Date(scheduleAt.value).getTime();
    socket.emit('schedule-sending', { ...payload, scheduleAtMs: whenMs });
    // No bloqueamos botones; es una programación futura
    btnStart.disabled = false; btnStop.disabled = true;
  } else {
    socket.emit('start-sending', payload);
  }
});

btnStop.addEventListener('click', () => {
  socket.emit('stop-sending', { accountId: accountId.value }); // cancelar la cuenta actual
  btnStop.disabled = true; btnStart.disabled = false;
});

// NUEVO: feedback de scheduler
socket.on('scheduled', ({ jobId, accountId: aid, runAt }) => {
  const d = new Date(runAt);
  logLine(`(${aid}) Programado ${jobId} para ${d.toLocaleString()}`, 'success');
});

socket.on('schedule-cancelled', ({ jobId }) => {
  logLine(`Programación cancelada: ${jobId}`, 'warn');
});

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

/* === NUEVO: hidratar estado al conectar desde otro dispositivo/navegador === */
socket.on('hydrate', (s) => {
  if (s?.hasUpload) {
    uploaded = true;
    uploadInfo.textContent = `CSV cargado: ${s.csvCount} filas.`;
    btnStart.disabled = false;
  }
  if (s?.accounts && s.accounts[accountId.value]) {
    const p = s.accounts[accountId.value];
    const pct = Math.max(0, Math.min(100, Math.round(Number(p.percent || 0))));
    progressBar.style.width = pct + '%';
    progressText.textContent = pct + '%';

    if (p.ready) {
      setStatus(`(${accountId.value}) WhatsApp listo ✔`);
      qrWrap.style.display = 'none';
    } else if (lastQRs[accountId.value]) {
      setStatus(`(${accountId.value}) Escanea el QR en tu WhatsApp > Dispositivos vinculados.`);
      drawQR(lastQRs[accountId.value]);
      qrWrap.style.display = 'flex';
    } else {
      setStatus(`(${accountId.value}) Esperando QR...`);
      qrWrap.style.display = 'flex';
    }

    btnStop.disabled = !p.sending;
    if (!p.sending && uploaded) btnStart.disabled = false;
  }

  if (Array.isArray(s?.scheduled)) {
    s.scheduled.forEach(j => {
      logLine(`(${j.accountId}) Programado ${j.jobId} para ${new Date(j.runAt).toLocaleString()}`, 'success');
    });
  }
});
