'use strict';

const config = require('../config');

/**
 * Vista del panel administrativo (HTML server-side).
 * El dashboard usa JS del lado del cliente para refrescar desde la API.
 */

function layout(title, body, active) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Transfer Bot</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0; --muted:#94a3b8; --green:#22c55e; --red:#ef4444; --amber:#f59e0b; --blue:#3b82f6; }
  * { box-sizing:border-box }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--txt) }
  nav { display:flex; gap:16px; padding:14px 24px; background:#0b1220; border-bottom:1px solid var(--line); align-items:center }
  nav a { color:var(--txt); text-decoration:none; padding:6px 12px; border-radius:6px; font-weight:600 }
  nav a.active, nav a:hover { background:var(--card); color:#fff }
  main { padding:24px; max-width:1200px; margin:0 auto }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin-bottom:24px }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px }
  .card .num { font-size:34px; font-weight:800 }
  .card .lbl { color:var(--muted); font-size:13px; margin-top:4px }
  .status { display:inline-block; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:700 }
  .status.ok { background:rgba(34,197,94,.15); color:var(--green) }
  .status.bad { background:rgba(239,68,68,.15); color:var(--red) }
  .status.warn { background:rgba(245,158,11,.15); color:var(--amber) }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:12px; overflow:hidden; border:1px solid var(--line) }
  th, td { padding:10px 14px; text-align:left; border-bottom:1px solid var(--line); font-size:14px }
  th { background:#16213b; color:var(--muted); font-weight:600; text-transform:uppercase; font-size:11px }
  tr:hover td { background:#1a2744 }
  a { color:var(--blue) }
  h1 { font-size:22px } h2 { font-size:17px; margin-top:28px }
  .section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin-bottom:20px }
  .muted { color:var(--muted); font-size:13px }
  .pill { font-size:13px }
  .error-list li { margin-bottom:6px }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px }
  @media (max-width:700px){ .grid2 { grid-template-columns:1fr } }
  .badge-s { background:#164e63; color:#7dd3fc; padding:2px 8px; border-radius:6px; font-size:12px }
  .badge-f { background:#7f1d1d; color:#fca5a5; padding:2px 8px; border-radius:6px; font-size:12px }
  .badge-p { background:#713f12; color:#fde68a; padding:2px 8px; border-radius:6px; font-size:12px }
  .badge-o { background:#14532d; color:#86efac; padding:2px 8px; border-radius:6px; font-size:12px }
  .filters { display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap }
  .filters input, .filters select { background:#0b1220; color:var(--txt); border:1px solid var(--line); padding:8px; border-radius:8px }
  .btn { background:#1d4ed8; color:#fff; border:none; padding:8px 14px; border-radius:8px; cursor:pointer }
</style>
</head>
<body>
<nav>
  <strong style="color:#fff">🚛 Transfer Bot</strong>
  <a href="/" class="${active==='dash'?'active':''}">Dashboard</a>
  <a href="/history" class="${active==='hist'?'active':''}">Historial</a>
  <a href="/numbers" class="${active==='numbers'?'active':''}">Números autorizados</a>
</nav>
<main>${body}</main>
</body>
</html>`;
}

function renderDashboard() {
  const body = `
  <h1>Dashboard</h1>
  <div class="cards">
    <div class="card"><div class="num" id="c-success">-</div><div class="lbl">Traslados exitosos</div></div>
    <div class="card"><div class="num" id="c-pending">-</div><div class="lbl">Pendientes</div></div>
    <div class="card"><div class="num" id="c-processing">-</div><div class="lbl">En proceso</div></div>
    <div class="card"><div class="num" id="c-failed">-</div><div class="lbl">Fallidos</div></div>
    <div class="card"><div class="num" id="c-today">-</div><div class="lbl">Del día</div></div>
  </div>

  <div class="grid2">
    <div class="section">
      <h2>Estado del sistema</h2>
      <table>
        <tr><td>WhatsApp</td><td id="wa-status">-</td></tr>
        <tr><td>Worker</td><td id="worker-status">-</td></tr>
        <tr><td>Navegador</td><td id="browser-status">-</td></tr>
        <tr><td>Reconexiones WhatsApp</td><td id="wa-reconn">-</td></tr>
      </table>
    </div>
    <div class="section">
      <h2>QR de WhatsApp</h2>
      <div id="qr-container" style="text-align:center;min-height:200px;display:flex;align-items:center;justify-content:center;">
        <p class="muted">Esperando QR...</p>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Errores recientes</h2>
    <ul id="errors"><li class="muted">cargando...</li></ul>
  </div>

  <script>
  async function refresh(){
    try{
      const r = await fetch('/api/dashboard'); if(!r.ok) throw new Error(r.status);
      const d = await r.json();
      document.getElementById('c-success').textContent = d.counts.success;
      document.getElementById('c-pending').textContent = d.counts.pending;
      document.getElementById('c-processing').textContent = d.counts.processing;
      document.getElementById('c-failed').textContent = d.counts.failed;
      document.getElementById('c-today').textContent = d.today;
      const st = (b,ok,warn)=> b ? \`<span class="status ok">\${ok}</span>\` : \`<span class="status \${warn?'warn':'bad'}">\${warn?'reintentando...':'desconectado'}</span>\`;
      document.getElementById('wa-status').innerHTML = st(d.whatsapp.connected,'Conectado', d.whatsapp.reconnectCount>0);
      document.getElementById('worker-status').innerHTML = d.worker.running ? '<span class="status ok">Activo</span>' : '<span class="status bad">Detenido</span>';
      document.getElementById('browser-status').innerHTML = d.browser.launched ? '<span class="status ok">Lanzado</span>' : '<span class="status warn">Inactivo</span>';
      document.getElementById('wa-reconn').textContent = d.whatsapp.reconnectCount || 0;
      const el = document.getElementById('errors');
      if(el && d.recentErrors && d.recentErrors.length){
        el.innerHTML = d.recentErrors.slice(0,8).map(e=>{
          let metaText = '';
          try{ if(e.meta) metaText = ' <span class="muted">'+JSON.stringify(JSON.parse(e.meta))+'</span>'; }catch(_){ }
          return \`<li><span class="badge-p">\${e.level}</span> <span class="muted">\${(e.component||'').replace(/^whatsapp\\./,'')}</span> \${e.message}\${metaText}</li>\`;
        }).join('');
      } else if(el) el.innerHTML = '<li class="muted">Sin errores recientes</li>';

      // QR: solo se muestra mientras WhatsApp no está conectado.
      try{
        const container = document.getElementById('qr-container');
        if(d.whatsapp.connected){
          container.innerHTML = '<p class="muted">WhatsApp conectado. No se requiere QR.</p>';
        } else {
          const qrRes = await fetch('/api/qr');
          if(qrRes.ok){
            const qrData = await qrRes.json();
            if(qrData.qr && qrData.qr.dataUrl){
              container.innerHTML = '<img src="'+qrData.qr.dataUrl+'" style="max-width:300px;border:2px solid #333;border-radius:8px;" alt="QR WhatsApp"><p class="muted" style="margin-top:8px;">Escanea con WhatsApp Web</p>';
            } else {
              container.innerHTML = '<p class="muted">Generando QR...</p>';
            }
          }
        }
      }catch(_){}
    }catch(e){ document.getElementById('wa-status').textContent = 'API no disponible: '+e.message; }
  }
  refresh(); setInterval(refresh, 5000);
  </script>`;
  return layout('Dashboard', body, 'dash');
}

function renderHistory() {
  const body = `
  <h1>Historial de traslados</h1>
  <div class="filters">
    <select id="f-status">
      <option value="">Todos los estados</option>
      <option value="SUCCESS">Exitoso</option>
      <option value="FAILED">Fallido</option>
      <option value="PROCESSING">En proceso</option>
      <option value="PENDING">Pendiente</option>
    </select>
    <input id="f-doc" placeholder="Documento">
    <button class="btn" onclick="load()">Filtrar</button>
  </div>
  <table id="tbl"><thead><tr>
    <th>Fecha</th><th>Documento</th><th>De</th><th>Hacia</th><th>Estado</th><th>Error</th><th></th>
  </tr></thead><tbody><tr><td colspan="7" class="muted">cargando...</td></tr></tbody></table>
  <p class="muted" id="count"></p>

  <script>
  async function load(){
    const status = document.getElementById('f-status').value;
    const doc = document.getElementById('f-doc').value.trim();
    const qs = new URLSearchParams();
    if(status) qs.set('status',status);
    if(doc) qs.set('document',doc);
    qs.set('limit','100');
    try{
      const r = await fetch('/api/history?'+qs); if(!r.ok) throw new Error(r.status);
      const d = await r.json();
      const tb = document.querySelector('#tbl tbody');
      if(!d.items.length){ tb.innerHTML='<tr><td colspan="7" class="muted">Sin registros</td></tr>'; document.getElementById('count').textContent=''; return; }
      tb.innerHTML = d.items.map(x=>{
        const badge = x.status==='SUCCESS'?'badge-o' : x.status==='FAILED'?'badge-f' : x.status==='PROCESSING'?'badge-p':'badge-s';
        return \`<tr>
          <td>\${(x.created_at||'').replace('T',' ')}</td>
          <td>\${x.document||'-'}</td>
          <td>\${x.source_branch||'-'}</td>
          <td>\${x.destination_branch||'-'}</td>
          <td><span class="\${badge}">\${x.status}</span></td>
          <td class="muted">\${(x.error_message||'').slice(0,40)}</td>
          <td><a href="/history/\${x.id}">ver</a></td>
        </tr>\`;
      }).join('');
      document.getElementById('count').textContent = d.total + ' registro(s)';
    }catch(e){ document.querySelector('#tbl tbody').innerHTML='<tr><td colspan="7">Error: '+e.message+'</td></tr>'; }
  }
  load(); setInterval(load, 8000);
  </script>`;
  return layout('Historial', body, 'hist');
}

function renderDetail(id) {
  const body = `
  <h1>Detalle de operación #${id}</h1>
  <div class="section" id="detail"><p class="muted">cargando...</p></div>
  <div class="section"><h2>Logs</h2><div id="logs"><p class="muted">cargando...</p></div></div>
  <p><a href="/history">← Volver</a></p>
  <script>
  (async()=>{
    try{
      const r = await fetch('/api/history/${id}'); if(!r.ok) throw new Error(r.status);
      const d = await r.json(); const t = d.transfer;
      document.getElementById('detail').innerHTML = \`
        <table><tr><td>ID</td><td>\${t.id}</td></tr>
        <tr><td>Message ID</td><td>\${t.message_id}</td></tr>
        <tr><td>Teléfono</td><td>\${t.phone_number}</td></tr>
        <tr><td>Documento</td><td>\${t.document}</td></tr>
        <tr><td>Sucursal anterior</td><td>\${t.source_branch||'-'}</td></tr>
        <tr><td>Sucursal nueva</td><td>\${t.destination_branch}</td></tr>
        <tr><td>Estado</td><td><span class="badge-\${t.status==='SUCCESS'?'o':t.status==='FAILED'?'f':'p'}">\${t.status}</span></td></tr>
        <tr><td>Error</td><td>\${t.error_message||'-'}</td></tr>
        <tr><td>Iniciado</td><td>\${t.started_at||'-'}</td></tr>
        <tr><td>Completado</td><td>\${t.completed_at||'-'}</td></tr>
        <tr><td>Creado</td><td>\${t.created_at}</td></tr>
      </table>\`;
      const logs = d.logs||[];
      document.getElementById('logs').innerHTML = logs.length
        ? '<pre style="white-space:pre-wrap;font-size:12px">'+logs.map(l=>\`[\${l.created_at}] \${l.level.toUpperCase()} \${l.component||''} \${l.message}\${l.meta?' '+l.meta:''}\`).join('\\n')+'</pre>'
        : '<p class="muted">Sin logs</p>';
    }catch(e){ document.getElementById('detail').innerHTML='Error: '+e.message; }
  })();
  </script>`;
  return layout('Detalle', body, 'hist');
}

function renderNumbers() {
  const body = `
  <h1>Números autorizados</h1>
  <p class="muted">Solo los números registrados aquí pueden solicitar traslados por WhatsApp (el indicativo de país es opcional; se comparan los últimos 10 dígitos).</p>
  <div class="section">
    <div class="filters">
      <input id="n-phone" placeholder="Número (solo dígitos, con indicativo)">
      <input id="n-label" placeholder="Etiqueta (opcional, ej: Juan Pérez)">
      <button class="btn" onclick="addNumber()">Agregar</button>
    </div>
    <table id="tbl-numbers"><thead><tr><th>Número</th><th>Etiqueta</th><th>Agregado</th><th></th></tr></thead>
    <tbody><tr><td colspan="4" class="muted">cargando...</td></tr></tbody></table>
  </div>

  <script>
  async function loadNumbers(){
    try{
      const r = await fetch('/api/allowed-numbers'); if(!r.ok) throw new Error(r.status);
      const d = await r.json();
      const tb = document.querySelector('#tbl-numbers tbody');
      if(!d.items.length){ tb.innerHTML = '<tr><td colspan="4" class="muted">Sin números registrados (todos los números están permitidos)</td></tr>'; return; }
      tb.innerHTML = d.items.map(n => \`<tr>
        <td>\${n.phone_number}</td>
        <td>\${n.label||'-'}</td>
        <td>\${(n.created_at||'').replace('T',' ')}</td>
        <td><button class="btn" style="background:#7f1d1d" onclick="removeNumber('\${n.phone_number}')">Eliminar</button></td>
      </tr>\`).join('');
    }catch(e){ document.querySelector('#tbl-numbers tbody').innerHTML = '<tr><td colspan="4">Error: '+e.message+'</td></tr>'; }
  }
  async function addNumber(){
    const phone = document.getElementById('n-phone').value.trim();
    const label = document.getElementById('n-label').value.trim();
    if(!phone) return;
    const r = await fetch('/api/allowed-numbers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number: phone, label }),
    });
    if(r.ok){
      document.getElementById('n-phone').value = '';
      document.getElementById('n-label').value = '';
      loadNumbers();
    } else {
      const d = await r.json().catch(()=>({}));
      alert(d.error || 'No se pudo agregar el número');
    }
  }
  async function removeNumber(phone){
    if(!confirm('¿Eliminar el número '+phone+'?')) return;
    await fetch('/api/allowed-numbers/'+encodeURIComponent(phone), { method: 'DELETE' });
    loadNumbers();
  }
  loadNumbers();
  </script>`;
  return layout('Números autorizados', body, 'numbers');
}

module.exports = { renderDashboard, renderHistory, renderDetail, renderNumbers, layout };
