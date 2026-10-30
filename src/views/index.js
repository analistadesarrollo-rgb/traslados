'use strict';

const config = require('../config');

/**
 * Vista del panel (HTML server-side).
 * El dashboard usa JS del lado del cliente para refrescar desde la API.
 */

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function navLinks(active, auth) {
  const isAdmin = auth && auth.role === 'admin';
  const links = [];
  if (isAdmin) {
    links.push(['/', 'dash', 'Dashboard']);
    links.push(['/history', 'hist', 'Historial']);
    links.push(['/numbers', 'numbers', 'Números autorizados']);
    links.push(['/users', 'users', 'Usuarios']);
  }
  links.push(['/schedules/new', 'schednew', 'Programar traslado']);
  links.push(['/schedules', 'sched', isAdmin ? 'Programaciones' : 'Mis programaciones']);
  return links
    .map(
      ([href, key, label]) =>
        `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`
    )
    .join('');
}

function layout(title, body, active, auth) {
  const brandHref = auth && auth.role === 'admin' ? '/' : '/schedules';
  const userBadge = auth
    ? `<div class="nav-user"><span>${esc(auth.username)} · ${auth.role === 'admin' ? 'Administrador' : 'Programador'}</span><a href="/logout" style="color:#ef4444">Cerrar sesión</a></div>`
    : '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Transfer Bot</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0; --muted:#94a3b8; --green:#22c55e; --red:#ef4444; --amber:#f59e0b; --blue:#3b82f6; }
  * { box-sizing:border-box }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--txt) }
  nav { display:flex; gap:14px; padding:14px 24px; background:#0b1220; border-bottom:1px solid var(--line); align-items:center; flex-wrap:wrap }
  nav a { color:var(--txt); text-decoration:none; padding:6px 12px; border-radius:6px; font-weight:600 }
  nav a.active, nav a:hover { background:var(--card); color:#fff }
  .nav-user { margin-left:auto; display:flex; gap:14px; align-items:center; color:var(--muted); font-size:13px }
  .nav-user a { padding:0 }
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
  .st { padding:3px 10px; border-radius:20px; font-size:12px; font-weight:700 }
  .st-SCHEDULED { background:rgba(59,130,246,.15); color:#93c5fd }
  .st-QUEUED { background:rgba(245,158,11,.15); color:#fcd34d }
  .st-PROCESSING { background:rgba(245,158,11,.2); color:#fbbf24 }
  .st-SUCCESS { background:rgba(34,197,94,.15); color:#86efac }
  .st-FAILED { background:rgba(239,68,68,.15); color:#fca5a5 }
  .st-CANCELLED { background:rgba(148,163,184,.15); color:#cbd5e1 }
  .filters { display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap; align-items:end }
  .filters input, .filters select { background:#0b1220; color:var(--txt); border:1px solid var(--line); padding:8px; border-radius:8px }
  .btn { background:#1d4ed8; color:#fff; border:none; padding:8px 14px; border-radius:8px; cursor:pointer; font-weight:600 }
  .btn.secondary { background:#334155 }
  .btn.danger { background:#b91c1c }
  .btn.small { padding:5px 9px; font-size:12px }
  .form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; align-items:end }
  .form-grid label { display:block; font-size:12px; color:var(--muted); margin-bottom:4px }
  .form-grid input, .form-grid select { width:100%; background:#0b1220; color:var(--txt); border:1px solid var(--line); padding:9px; border-radius:8px }
  .msg { padding:10px 14px; border-radius:8px; margin-bottom:12px; font-size:14px; display:none }
  .msg.ok { display:block; background:rgba(34,197,94,.15); color:#86efac }
  .msg.err { display:block; background:rgba(239,68,68,.15); color:#fca5a5 }
  .row-actions { display:flex; gap:6px; flex-wrap:wrap }
  .inline-edit { display:none; margin-top:16px; border-top:1px solid var(--line); padding-top:16px }
</style>
</head>
<body>
<nav>
  <a href="${brandHref}" style="padding:0"><strong style="color:#fff">🚛 Transfer Bot</strong></a>
  ${navLinks(active, auth)}
  ${userBadge}
</nav>
<main>${body}</main>
</body>
</html>`;
}

function renderDashboard(auth) {
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
  return layout('Dashboard', body, 'dash', auth);
}

function renderHistory(auth) {
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
    <th>Fecha</th><th>Origen</th><th>Solicitante</th><th>Documento</th><th>Hacia</th><th>Estado</th><th>Error</th><th></th>
  </tr></thead><tbody><tr><td colspan="8" class="muted">cargando...</td></tr></tbody></table>
  <p class="muted" id="count"></p>

  <script>
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
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
      if(!d.items.length){ tb.innerHTML='<tr><td colspan="8" class="muted">Sin registros</td></tr>'; document.getElementById('count').textContent=''; return; }
      tb.innerHTML = d.items.map(x=>{
        const badge = x.status==='SUCCESS'?'badge-o' : x.status==='FAILED'?'badge-f' : x.status==='PROCESSING'?'badge-p':'badge-s';
        const origin = x.origin === 'panel'
          ? 'Panel' + (x.created_by_username ? ' · ' + esc(x.created_by_username) : '')
          : 'WhatsApp';
        return \`<tr>
          <td>\${esc((x.created_at||'').replace('T',' '))}</td>
          <td>\${origin}</td>
          <td>\${esc(x.caller_label||'-')}</td>
          <td>\${esc(x.document||'-')}</td>
          <td>\${esc(x.destination_branch||'-')}</td>
          <td><span class="\${badge}">\${esc(x.status)}</span></td>
          <td class="muted">\${esc((x.error_message||'').slice(0,40))}</td>
          <td><a href="/history/\${x.id}">ver</a></td>
        </tr>\`;
      }).join('');
      document.getElementById('count').textContent = d.total + ' registro(s)';
    }catch(e){ document.querySelector('#tbl tbody').innerHTML='<tr><td colspan="8">Error: '+esc(e.message)+'</td></tr>'; }
  }
  load(); setInterval(load, 8000);
  </script>`;
  return layout('Historial', body, 'hist', auth);
}

function renderDetail(id, auth) {
  const body = `
  <h1>Detalle de operación #${esc(id)}</h1>
  <div class="section" id="detail"><p class="muted">cargando...</p></div>
  <div class="section"><h2>Logs</h2><div id="logs"><p class="muted">cargando...</p></div></div>
  <p><a href="/history">← Volver</a></p>
  <script>
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  (async()=>{
    try{
      const r = await fetch('/api/history/${esc(id)}'); if(!r.ok) throw new Error(r.status);
      const d = await r.json(); const t = d.transfer;
      document.getElementById('detail').innerHTML = \`
        <table><tr><td>ID</td><td>\${t.id}</td></tr>
        <tr><td>Message ID</td><td>\${esc(t.message_id)}</td></tr>
        <tr><td>Origen</td><td>\${esc(t.origin||'whatsapp')}\${t.created_by_username?' · '+esc(t.created_by_username):''}</td></tr>
        <tr><td>Teléfono</td><td>\${esc(t.phone_number)}</td></tr>
        <tr><td>Documento</td><td>\${esc(t.document)}</td></tr>
        <tr><td>Sucursal anterior</td><td>\${esc(t.source_branch||'-')}</td></tr>
        <tr><td>Sucursal nueva</td><td>\${esc(t.destination_branch)}</td></tr>
        <tr><td>Estado</td><td><span class="badge-\${t.status==='SUCCESS'?'o':t.status==='FAILED'?'f':'p'}">\${esc(t.status)}</span></td></tr>
        <tr><td>Error</td><td>\${esc(t.error_message||'-')}</td></tr>
        <tr><td>Iniciado</td><td>\${esc(t.started_at||'-')}</td></tr>
        <tr><td>Completado</td><td>\${esc(t.completed_at||'-')}</td></tr>
        <tr><td>Creado</td><td>\${esc(t.created_at)}</td></tr>
      </table>\`;
      const logs = d.logs||[];
      document.getElementById('logs').innerHTML = logs.length
        ? '<pre style="white-space:pre-wrap;font-size:12px">'+logs.map(l=>\`[\${esc(l.created_at)}] \${esc((l.level||'').toUpperCase())} \${esc(l.component||'')} \${esc(l.message)}\${l.meta?' '+esc(l.meta):''}\`).join('\\n')+'</pre>'
        : '<p class="muted">Sin logs</p>';
    }catch(e){ document.getElementById('detail').innerHTML='Error: '+esc(e.message); }
  })();
  </script>`;
  return layout('Detalle', body, 'hist', auth);
}

function renderNumbers(auth) {
  const body = `
  <h1>Números autorizados</h1>
  <p class="muted">Solo los números registrados aquí pueden solicitar traslados por WhatsApp. Se comparan los últimos 10 dígitos del número de WhatsApp contra la clave normalizada guardada.</p>
  <div class="section">
    <div class="filters">
      <input id="n-phone" placeholder="Número (solo dígitos, con indicativo)" oninput="updatePreview()">
      <input id="n-label" placeholder="Etiqueta (opcional, ej: Juan Pérez)">
      <button class="btn" onclick="addNumber()">Agregar</button>
    </div>
    <p id="n-preview" style="color:#60a5fa;font-size:0.9em;margin:4px 0 0"></p>
    <table id="tbl-numbers"><thead><tr><th>Número</th><th>Etiqueta</th><th>Agregado</th><th></th></tr></thead>
    <tbody><tr><td colspan="4" class="muted">cargando...</td></tr></tbody></table>
  </div>

  <script>
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  async function loadNumbers(){
    try{
      const r = await fetch('/api/allowed-numbers'); if(!r.ok) throw new Error(r.status);
      const d = await r.json();
      const tb = document.querySelector('#tbl-numbers tbody');
      if(!d.items.length){ tb.innerHTML = '<tr><td colspan="4" class="muted">Sin números registrados (todos los números están permitidos)</td></tr>'; return; }
      tb.innerHTML = d.items.map(n => \`<tr>
        <td>\${esc(n.phone_number)}</td>
        <td>\${esc(n.label||'-')}</td>
        <td>\${esc((n.created_at||'').replace('T',' '))}</td>
        <td><button class="btn danger small" onclick="removeNumber('\${esc(n.phone_number)}')">Eliminar</button></td>
      </tr>\`).join('');
    }catch(e){ document.querySelector('#tbl-numbers tbody').innerHTML = '<tr><td colspan="4">Error: '+esc(e.message)+'</td></tr>'; }
  }
  function updatePreview(){
    const phone = document.getElementById('n-phone').value.trim();
    const el = document.getElementById('n-preview');
    if(!phone){ el.textContent=''; return; }
    const digits = phone.replace(/[^0-9]/g,'');
    const normalized = digits.length > 10 ? digits.slice(-10) : digits;
    el.textContent = 'Se guardará como: ' + normalized;
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
      document.getElementById('n-preview').textContent = '';
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
  return layout('Números autorizados', body, 'numbers', auth);
}

function renderUsers(auth) {
  const body = `
  <h1>Usuarios</h1>
  <p class="muted">El administrador principal (${esc(config.admin.user)}) se define en el archivo .env y no se puede deshabilitar desde aquí. Los usuarios creados aquí pueden programar traslados.</p>
  <div class="section">
    <h2>Crear usuario</h2>
    <div id="u-msg" class="msg"></div>
    <div class="form-grid">
      <div><label>Usuario</label><input id="u-username" placeholder="ej: juan.perez" autocomplete="off"></div>
      <div><label>Nombre para mostrar</label><input id="u-display" placeholder="Juan Pérez" autocomplete="off"></div>
      <div><label>Rol</label>
        <select id="u-role">
          <option value="scheduler">Usuario programador</option>
          <option value="admin">Administrador</option>
        </select>
      </div>
      <div><label>Contraseña (mín. 8)</label><input id="u-password" type="password" autocomplete="new-password"></div>
      <div><button class="btn" onclick="createUser()">Crear usuario</button></div>
    </div>
  </div>

  <table id="tbl-users"><thead><tr>
    <th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th><th>Creado</th><th>Acciones</th>
  </tr></thead><tbody><tr><td colspan="6" class="muted">cargando...</td></tr></tbody></table>

  <script>
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function msg(text, ok){
    const el = document.getElementById('u-msg');
    el.className = 'msg ' + (ok ? 'ok' : 'err');
    el.textContent = text;
    setTimeout(()=>{ el.className='msg'; el.textContent=''; }, 4000);
  }
  async function loadUsers(){
    try{
      const r = await fetch('/api/users'); if(!r.ok) throw new Error(r.status);
      const d = await r.json();
      const tb = document.querySelector('#tbl-users tbody');
      const rows = [];
      rows.push(\`<tr>
        <td><strong>\${esc(d.primaryAdmin.username)}</strong></td>
        <td>Administrador principal</td>
        <td><span class="badge-o">admin</span></td>
        <td><span class="status ok">Habilitado</span></td>
        <td>—</td>
        <td class="muted">Definido en .env</td>
      </tr>\`);
      for(const u of d.items){
        rows.push(\`<tr>
          <td>\${esc(u.username)}</td>
          <td>\${esc(u.display_name||'-')}</td>
          <td><span class="\${u.role==='admin'?'badge-o':'badge-s'}">\${esc(u.role)}</span></td>
          <td>\${u.enabled ? '<span class="status ok">Habilitado</span>' : '<span class="status bad">Deshabilitado</span>'}</td>
          <td>\${esc((u.created_at||'').replace('T',' '))}</td>
          <td><div class="row-actions">
            <button class="btn secondary small" onclick="toggleUser(\${u.id}, \${u.enabled?0:1})">\${u.enabled?'Deshabilitar':'Habilitar'}</button>
            <button class="btn secondary small" onclick="resetPassword(\${u.id})">Cambiar contraseña</button>
          </div></td>
        </tr>\`);
      }
      tb.innerHTML = rows.join('');
    }catch(e){ document.querySelector('#tbl-users tbody').innerHTML = '<tr><td colspan="6">Error: '+esc(e.message)+'</td></tr>'; }
  }
  async function createUser(){
    const payload = {
      username: document.getElementById('u-username').value.trim(),
      display_name: document.getElementById('u-display').value.trim(),
      role: document.getElementById('u-role').value,
      password: document.getElementById('u-password').value,
    };
    const r = await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const d = await r.json().catch(()=>({}));
    if(r.ok){
      document.getElementById('u-username').value='';
      document.getElementById('u-display').value='';
      document.getElementById('u-password').value='';
      msg('Usuario creado correctamente', true);
      loadUsers();
    } else { msg(d.error || 'No se pudo crear el usuario', false); }
  }
  async function toggleUser(id, enabled){
    const r = await fetch('/api/users/'+id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: !!enabled }) });
    const d = await r.json().catch(()=>({}));
    if(r.ok){ msg(enabled?'Usuario habilitado':'Usuario deshabilitado', true); loadUsers(); }
    else { msg(d.error || 'No se pudo actualizar', false); }
  }
  async function resetPassword(id){
    const pwd = prompt('Nueva contraseña (mínimo 8 caracteres):');
    if(pwd === null) return;
    const r = await fetch('/api/users/'+id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password: pwd }) });
    const d = await r.json().catch(()=>({}));
    if(r.ok){ msg('Contraseña actualizada', true); }
    else { msg(d.error || 'No se pudo actualizar la contraseña', false); }
  }
  loadUsers();
  </script>`;
  return layout('Usuarios', body, 'users', auth);
}

function renderSchedules(auth) {
  const isAdmin = auth && auth.role === 'admin';
  const body = `
  <h1>${isAdmin ? 'Programaciones' : 'Mis programaciones'}</h1>
  <p class="muted">Los traslados programados se ejecutan automáticamente a la fecha y hora indicadas (zona horaria America/Bogota). Estados: SCHEDULED (programado), QUEUED (en cola), PROCESSING (ejecutando), SUCCESS, FAILED, CANCELLED.</p>
  <div class="filters">
    <a class="btn" href="/schedules/new">+ Nueva programación</a>
    <select id="f-status">
      <option value="">Todos los estados</option>
      <option value="SCHEDULED">Programado</option>
      <option value="QUEUED">En cola</option>
      <option value="PROCESSING">Ejecutando</option>
      <option value="SUCCESS">Exitoso</option>
      <option value="FAILED">Fallido</option>
      <option value="CANCELLED">Cancelado</option>
    </select>
    <input id="f-date" type="date" title="Fecha programada">
    <input id="f-doc" placeholder="Documento">
    <button class="btn secondary" onclick="load()">Filtrar</button>
  </div>
  <div id="s-msg" class="msg"></div>
  <table id="tbl-sched"><thead><tr>
    <th>Programado</th><th>Documento</th><th>Sucursal</th><th>Estado</th>
    ${isAdmin ? '<th>Creado por</th>' : ''}
    <th>Retraso</th><th>Resultado</th><th>Acciones</th>
  </tr></thead><tbody><tr><td colspan="${isAdmin ? 8 : 7}" class="muted">cargando...</td></tr></tbody></table>

  <div class="section inline-edit" id="edit-box">
    <h2>Editar programación <span id="e-ref" class="muted"></span></h2>
    <div class="form-grid">
      <div><label>Documento</label><input id="e-document"></div>
      <div><label>Sucursal destino</label><input id="e-branch"></div>
      <div><label>Fecha (Bogotá)</label><input id="e-date" type="date"></div>
      <div><label>Hora (Bogotá)</label><input id="e-time" type="time"></div>
      <div class="row-actions">
        <button class="btn" onclick="saveEdit()">Guardar cambios</button>
        <button class="btn secondary" onclick="closeEdit()">Cancelar</button>
      </div>
    </div>
  </div>

  <script>
  let ROWS = [];
  const LABELS = { SCHEDULED:'Programado', QUEUED:'En cola', PROCESSING:'En proceso', SUCCESS:'Exitoso', FAILED:'Fallido', CANCELLED:'Cancelado' };
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function msg(text, ok){
    const el = document.getElementById('s-msg');
    el.className = 'msg ' + (ok ? 'ok' : 'err');
    el.textContent = text;
    setTimeout(()=>{ el.className='msg'; el.textContent=''; }, 5000);
  }
  async function load(){
    const qs = new URLSearchParams();
    const status = document.getElementById('f-status').value;
    const date = document.getElementById('f-date').value;
    const doc = document.getElementById('f-doc').value.trim();
    if(status) qs.set('status', status);
    if(date) qs.set('date', date);
    if(doc) qs.set('document', doc);
    qs.set('limit','200');
    try{
      const r = await fetch('/api/schedules?'+qs); if(!r.ok) throw new Error(r.status);
      const d = await r.json();
      ROWS = d.items;
      const cols = ${isAdmin ? 8 : 7};
      const tb = document.querySelector('#tbl-sched tbody');
      if(!d.items.length){ tb.innerHTML = '<tr><td colspan="'+cols+'" class="muted">Sin programaciones</td></tr>'; return; }
      tb.innerHTML = d.items.map(s=>{
        const when = esc(s.scheduled_date) + ' ' + esc(s.scheduled_time);
        const result = s.status==='FAILED' ? esc(s.error_message||'Fallido')
          : s.status==='SUCCESS' ? esc(s.result_message||'Ejecutado')
          : s.status==='CANCELLED' ? esc('Cancelado'+(s.cancelled_by?' por '+s.cancelled_by:''))
          : '—';
        const actions = s.status==='SCHEDULED'
          ? '<div class="row-actions"><button class="btn small" onclick="openEdit('+s.id+')">Editar</button>'+
            '<button class="btn danger small" onclick="cancelSchedule('+s.id+')">Cancelar</button></div>'
          : '<span class="muted">—</span>';
        return '<tr>'+
          '<td>'+when+'</td>'+
          '<td>'+esc(s.document)+'</td>'+
          '<td>'+esc(s.destination_branch)+'</td>'+
          '<td><span class="st st-'+esc(s.status)+'">'+esc(LABELS[s.status]||s.status)+'</span></td>'+
          ${isAdmin ? "'<td>'+esc(s.created_by_username||'-')+'</td>'+" : "''+"}
          '<td>'+(s.late ? '<span class="status warn">Retrasada</span>' : '<span class="muted">—</span>')+'</td>'+
          '<td class="muted">'+result+'</td>'+
          '<td>'+actions+'</td>'+
        '</tr>';
      }).join('');
    }catch(e){ document.querySelector('#tbl-sched tbody').innerHTML = '<tr><td colspan="8">Error: '+esc(e.message)+'</td></tr>'; }
  }
  function openEdit(id){
    const s = ROWS.find(x=>x.id===id); if(!s) return;
    window.__editId = id;
    document.getElementById('e-ref').textContent = '#'+id;
    document.getElementById('e-document').value = s.document;
    document.getElementById('e-branch').value = s.destination_branch;
    document.getElementById('e-date').value = s.scheduled_date;
    document.getElementById('e-time').value = s.scheduled_time;
    document.getElementById('edit-box').style.display = 'block';
    document.getElementById('edit-box').scrollIntoView({behavior:'smooth'});
  }
  function closeEdit(){
    window.__editId = null;
    document.getElementById('edit-box').style.display = 'none';
  }
  async function saveEdit(){
    const id = window.__editId; if(!id) return;
    const payload = {
      document: document.getElementById('e-document').value.trim(),
      destination_branch: document.getElementById('e-branch').value.trim(),
      scheduled_date: document.getElementById('e-date').value,
      scheduled_time: document.getElementById('e-time').value,
    };
    const r = await fetch('/api/schedules/'+id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const d = await r.json().catch(()=>({}));
    if(r.ok){ msg('Programación actualizada', true); closeEdit(); load(); }
    else { msg(d.error || 'No se pudo actualizar', false); }
  }
  async function cancelSchedule(id){
    if(!confirm('¿Cancelar esta programación?')) return;
    const r = await fetch('/api/schedules/'+id+'/cancel', { method:'POST' });
    const d = await r.json().catch(()=>({}));
    if(r.ok){ msg('Programación cancelada', true); load(); }
    else { msg(d.error || 'No se pudo cancelar', false); }
  }
  load(); setInterval(load, 15000);
  </script>`;
  return layout('Programaciones', body, 'sched', auth);
}

function renderScheduleNew(auth) {
  const body = `
  <h1>Programar traslado</h1>
  <p class="muted">El traslado se ejecutará automáticamente en la fecha y hora indicadas, en zona horaria America/Bogota (hora de Colombia).</p>
  <div class="section">
    <div id="n-msg" class="msg"></div>
    <div class="form-grid">
      <div><label>Documento del empleado</label><input id="p-document" inputmode="numeric" placeholder="Ej: 1234567890" autocomplete="off"></div>
      <div><label>Sucursal destino (código)</label><input id="p-branch" placeholder="Ej: 1" autocomplete="off"></div>
      <div><label>Fecha (Bogotá)</label><input id="p-date" type="date"></div>
      <div><label>Hora (Bogotá)</label><input id="p-time" type="time"></div>
      <div class="row-actions">
        <button class="btn" onclick="submitSchedule()">Programar</button>
        <a class="btn secondary" href="/schedules" style="text-decoration:none">Ver programaciones</a>
      </div>
    </div>
    <p class="muted" id="p-hint" style="margin-top:12px"></p>
  </div>
  <script>
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function bogotaNow(){
    const s = new Date().toLocaleString('sv-SE', { timeZone:'America/Bogota' });
    const parts = s.split(' ');
    return { date: parts[0], time: (parts[1]||'').slice(0,5) };
  }
  function msg(text, ok){
    const el = document.getElementById('n-msg');
    el.className = 'msg ' + (ok ? 'ok' : 'err');
    el.textContent = text;
  }
  function syncHint(){
    const now = bogotaNow();
    document.getElementById('p-date').min = now.date;
    const date = document.getElementById('p-date').value;
    const timeEl = document.getElementById('p-time');
    if(date === now.date){ timeEl.min = now.time; } else { timeEl.removeAttribute('min'); }
    document.getElementById('p-hint').textContent = 'Hora actual en Bogotá: ' + now.date + ' ' + now.time;
  }
  document.getElementById('p-date').addEventListener('change', syncHint);
  syncHint(); setInterval(syncHint, 30000);
  async function submitSchedule(){
    const payload = {
      document: document.getElementById('p-document').value.trim(),
      destination_branch: document.getElementById('p-branch').value.trim(),
      scheduled_date: document.getElementById('p-date').value,
      scheduled_time: document.getElementById('p-time').value,
    };
    if(!payload.document || !payload.destination_branch || !payload.scheduled_date || !payload.scheduled_time){
      msg('Complete todos los campos.', false); return;
    }
    const r = await fetch('/api/schedules', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const d = await r.json().catch(()=>({}));
    if(r.ok){
      msg('Programación creada. Redirigiendo...', true);
      setTimeout(()=>{ window.location.href = '/schedules'; }, 900);
    } else { msg(d.error || 'No se pudo programar el traslado', false); }
  }
  </script>`;
  return layout('Programar traslado', body, 'schednew', auth);
}

function renderLogin(error) {
  const errorMsg = error ? `<div style="background:rgba(239,68,68,.15);color:#ef4444;padding:10px;border-radius:8px;margin-bottom:14px;font-size:14px;">${esc(error)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login - Transfer Bot</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0; --blue:#3b82f6; }
  * { box-sizing:border-box }
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--txt); display:flex; align-items:center; justify-content:center; min-height:100vh }
  .login-box { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:40px; width:100%; max-width:380px }
  h1 { text-align:center; font-size:24px; margin-bottom:8px }
  .subtitle { text-align:center; color:#94a3b8; font-size:14px; margin-bottom:28px }
  label { display:block; font-size:13px; color:#94a3b8; margin-bottom:6px }
  input[type="text"], input[type="password"] { width:100%; padding:10px 14px; background:#0b1220; color:var(--txt); border:1px solid var(--line); border-radius:8px; font-size:15px; margin-bottom:18px }
  input:focus { outline:none; border-color:var(--blue) }
  button { width:100%; padding:12px; background:var(--blue); color:#fff; border:none; border-radius:8px; font-size:16px; font-weight:700; cursor:pointer }
  button:hover { opacity:.9 }
</style>
</head>
<body>
<div class="login-box">
  <h1>🚛 Transfer Bot</h1>
  <p class="subtitle">Panel de gestión de traslados</p>
  ${errorMsg}
  <form method="POST" action="/login">
    <label>Usuario</label>
    <input type="text" name="username" autocomplete="username" required autofocus>
    <label>Contraseña</label>
    <input type="password" name="password" autocomplete="current-password" required>
    <button type="submit">Iniciar sesión</button>
  </form>
</div>
</body>
</html>`;
}

module.exports = {
  renderDashboard,
  renderHistory,
  renderDetail,
  renderNumbers,
  renderUsers,
  renderSchedules,
  renderScheduleNew,
  renderLogin,
  layout,
};
