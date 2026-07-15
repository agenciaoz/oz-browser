// OZ Browser — Activation + admin backend (Cloudflare Worker + D1).
//
// Endpoints:
//   POST /activate  {key, machineId, appVersion}  → first activation
//   POST /validate  {key, machineId, token?}       → re-check on each launch
//   POST /event     {key, machineId, type, meta}   → usage telemetry
//   GET  /           (admin dashboard HTML)
//   GET  /admin/data            (Bearer ADMIN_TOKEN) → licenses+activations+events
//   POST /admin/create {email,name,plan?,days?}     → mints a key
//   POST /admin/revoke {key} / /admin/unrevoke {key} / /admin/delete {key}
//
// Data: D1 "oz-admin" (tables licenses, activations, events). Secrets:
//   ADMIN_TOKEN (dashboard auth), HMAC_SECRET (signs activation tokens).
//
// Deploy: cd activation-server && npx wrangler deploy

const OFFLINE_GRACE_DAYS = 7

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  })
}

function now() {
  return Date.now()
}

async function hmac(bodyStr, secret) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret || 'dev'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(bodyStr))
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, '')
}

async function signToken(payload, secret) {
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '')
  return body + '.' + (await hmac(body, secret))
}

async function verifyToken(token, secret) {
  const [body, sig] = String(token || '').split('.')
  if (!body || !sig) return null
  if ((await hmac(body, secret)) !== sig) return null
  try {
    return JSON.parse(atob(body))
  } catch (_e) {
    return null
  }
}

function genKey() {
  // OZ-XXXX-XXXX-XXXX (no ambiguous chars)
  const al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const grp = () =>
    Array.from({ length: 4 }, () => al[Math.floor(Math.random() * al.length)]).join('')
  return `OZ-${grp()}-${grp()}-${grp()}`
}

async function readBody(request) {
  try {
    return await request.json()
  } catch (_e) {
    return {}
  }
}

// --- public: activation -----------------------------------------------------

async function activate(request, env, isValidate) {
  const b = await readBody(request)
  const key = String(b.key || '').trim().toUpperCase()
  const machineId = String(b.machineId || '').trim()
  if (!key || !machineId) return json({ ok: false, reason: 'missing_fields' }, 400)

  const lic = await env.DB.prepare('SELECT * FROM licenses WHERE key = ?').bind(key).first()
  if (!lic) return json({ ok: false, reason: 'invalid_key' }, 403)
  if (lic.status === 'revoked') return json({ ok: false, reason: 'revoked' }, 403)
  if (lic.expires_at && lic.expires_at < now())
    return json({ ok: false, reason: 'expired' }, 403)

  // Device cap: only blocks binding a NEW machine beyond the limit. Existing
  // machines (re-activation / validate) always pass.
  const existing = await env.DB.prepare(
    'SELECT machine_id FROM activations WHERE key = ?',
  )
    .bind(key)
    .all()
  const ids = (existing.results || []).map((r) => r.machine_id)
  const cap = lic.max_devices || 2
  if (!ids.includes(machineId) && ids.length >= cap) {
    return json({ ok: false, reason: 'device_limit', cap }, 403)
  }

  const t = now()
  await env.DB.prepare(
    `INSERT INTO activations (key, machine_id, app_version, first_seen, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(key, machine_id) DO UPDATE SET last_seen = ?4, app_version = ?3`,
  )
    .bind(key, machineId, String(b.appVersion || ''), t)
    .run()

  await env.DB.prepare(
    'INSERT INTO events (key, machine_id, type, meta, ts) VALUES (?,?,?,?,?)',
  )
    .bind(key, machineId, isValidate ? 'validate' : 'activate', '', t)
    .run()

  // Per-license proxy bundle — the app imports + auto-assigns these on activate
  // (and re-syncs on every validate, so edits from the dashboard propagate).
  const proxRows =
    (
      await env.DB.prepare(
        'SELECT name,protocol,host,port,username,password,country,city,tags FROM proxies WHERE key = ? ORDER BY id',
      )
        .bind(key)
        .all()
    ).results || []
  const proxies = proxRows.map((p) => ({
    name: p.name || '',
    protocol: p.protocol || 'https',
    host: p.host,
    port: p.port,
    username: p.username || '',
    password: p.password || '',
    country: p.country || null,
    city: p.city || null,
    tags: p.tags ? String(p.tags).split(',').filter(Boolean) : [],
  }))

  const token = await signToken({ key, machineId, iat: t }, env.HMAC_SECRET)
  return json({
    ok: true,
    plan: lic.plan,
    email: lic.email,
    name: lic.name,
    expiresAt: lic.expires_at || null,
    offlineGraceDays: OFFLINE_GRACE_DAYS,
    proxies,
    token,
  })
}

async function logEvent(request, env) {
  const b = await readBody(request)
  const key = String(b.key || '').trim().toUpperCase()
  const machineId = String(b.machineId || '').trim()
  const type = String(b.type || '').trim().slice(0, 64)
  if (!type) return json({ ok: false, reason: 'missing_type' }, 400)
  let meta = ''
  try {
    meta = b.meta ? JSON.stringify(b.meta).slice(0, 2000) : ''
  } catch (_e) {
    meta = ''
  }
  await env.DB.prepare(
    'INSERT INTO events (key, machine_id, type, meta, ts) VALUES (?,?,?,?,?)',
  )
    .bind(key || null, machineId || null, type, meta, now())
    .run()
  return json({ ok: true })
}

// --- admin ------------------------------------------------------------------

function authed(request, env) {
  const h = request.headers.get('authorization') || ''
  const token = h.replace(/^Bearer\s+/i, '')
  return env.ADMIN_TOKEN && token === env.ADMIN_TOKEN
}

async function adminRoute(request, env, pathname) {
  if (!authed(request, env)) return json({ ok: false, reason: 'unauthorized' }, 401)

  if (pathname === '/admin/data' && request.method === 'GET') {
    const licenses = (await env.DB.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all()).results
    const activations = (await env.DB.prepare('SELECT * FROM activations ORDER BY last_seen DESC').all()).results
    const events = (await env.DB.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT 300').all()).results
    const proxies = (await env.DB.prepare('SELECT key,name,host,port,city FROM proxies ORDER BY id').all()).results
    return json({ ok: true, licenses, activations, events, proxies })
  }

  const b = await readBody(request)
  if (pathname === '/admin/create' && request.method === 'POST') {
    const key = genKey()
    const days = Number(b.days) || 0
    const expires = days > 0 ? now() + days * 86400000 : null
    const maxDevices = Number(b.maxDevices) > 0 ? Number(b.maxDevices) : 2
    await env.DB.prepare(
      `INSERT INTO licenses (key, email, name, status, plan, created_at, expires_at, max_devices)
       VALUES (?,?,?,'active',?,?,?,?)`,
    )
      .bind(
        key,
        String(b.email || ''),
        String(b.name || ''),
        String(b.plan || 'test'),
        now(),
        expires,
        maxDevices,
      )
      .run()
    return json({ ok: true, key })
  }

  const key = String(b.key || '').trim().toUpperCase()
  if (!key) return json({ ok: false, reason: 'missing_key' }, 400)
  if (pathname === '/admin/getproxies' && request.method === 'POST') {
    const rows =
      (
        await env.DB.prepare(
          'SELECT name,protocol,host,port,username,password,country,city,tags FROM proxies WHERE key=? ORDER BY id',
        )
          .bind(key)
          .all()
      ).results || []
    return json({ ok: true, proxies: rows })
  }
  if (pathname === '/admin/setproxies' && request.method === 'POST') {
    // Full replace: wipe this key's proxies, insert the new set.
    const list = Array.isArray(b.proxies) ? b.proxies : []
    await env.DB.prepare('DELETE FROM proxies WHERE key=?').bind(key).run()
    const t = now()
    let count = 0
    for (const p of list) {
      if (!p || !p.host || !p.port) continue
      await env.DB.prepare(
        `INSERT INTO proxies (key,name,protocol,host,port,username,password,country,city,tags,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          key,
          String(p.name || ''),
          String(p.protocol || 'https'),
          String(p.host),
          Number(p.port),
          String(p.username || ''),
          String(p.password || ''),
          String(p.country || ''),
          String(p.city || ''),
          Array.isArray(p.tags) ? p.tags.join(',') : String(p.tags || ''),
          t,
        )
        .run()
      count++
    }
    return json({ ok: true, count })
  }
  if (pathname === '/admin/revoke' && request.method === 'POST') {
    await env.DB.prepare("UPDATE licenses SET status='revoked' WHERE key=?").bind(key).run()
    return json({ ok: true })
  }
  if (pathname === '/admin/unrevoke' && request.method === 'POST') {
    await env.DB.prepare("UPDATE licenses SET status='active' WHERE key=?").bind(key).run()
    return json({ ok: true })
  }
  if (pathname === '/admin/delete' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM licenses WHERE key=?').bind(key).run()
    await env.DB.prepare('DELETE FROM activations WHERE key=?').bind(key).run()
    await env.DB.prepare('DELETE FROM proxies WHERE key=?').bind(key).run()
    return json({ ok: true })
  }
  if (pathname === '/admin/setcap' && request.method === 'POST') {
    const cap = Number(b.maxDevices) > 0 ? Number(b.maxDevices) : 2
    await env.DB.prepare('UPDATE licenses SET max_devices=? WHERE key=?').bind(cap, key).run()
    return json({ ok: true, maxDevices: cap })
  }
  if (pathname === '/admin/deactivate' && request.method === 'POST') {
    // Free a device (or all devices when machineId omitted) so the seat reopens.
    if (b.machineId) {
      await env.DB.prepare('DELETE FROM activations WHERE key=? AND machine_id=?')
        .bind(key, String(b.machineId))
        .run()
    } else {
      await env.DB.prepare('DELETE FROM activations WHERE key=?').bind(key).run()
    }
    return json({ ok: true })
  }
  return json({ ok: false, reason: 'not_found' }, 404)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const p = url.pathname
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization',
        },
      })
    }
    try {
      if (p === '/' || p === '/admin') return new Response(DASHBOARD, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (p === '/activate' && request.method === 'POST') return await activate(request, env, false)
      if (p === '/validate' && request.method === 'POST') return await activate(request, env, true)
      if (p === '/event' && request.method === 'POST') return await logEvent(request, env)
      if (p.startsWith('/admin/')) return await adminRoute(request, env, p)
      return json({ ok: false, reason: 'not_found' }, 404)
    } catch (e) {
      return json({ ok: false, reason: 'server_error', message: String(e && e.message) }, 500)
    }
  },
}

const DASHBOARD = `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OZ Browser — Admin</title>
<style>
:root{--bg:#0f1117;--card:#1a1d27;--bd:#2a2e3a;--tx:#e5e7eb;--mut:#9aa0ab;--acc:#6488ff;--red:#dc2626;--grn:#16a34a}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--tx)}
header{padding:14px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:12px}
h1{font-size:16px;margin:0;font-weight:700}
.wrap{padding:20px;max-width:1100px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px;margin-bottom:18px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:0 0 12px}
input,button,select{font:inherit;color:inherit}
input,select{background:#0d0f15;border:1px solid var(--bd);border-radius:6px;padding:7px 10px;color:var(--tx)}
button{background:var(--acc);border:0;border-radius:6px;padding:7px 12px;color:#fff;font-weight:600;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--bd);color:var(--tx)}
button.danger{background:var(--red)}button.ok{background:var(--grn)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--bd);white-space:nowrap}
th{color:var(--mut);font-weight:600}
.tag{padding:1px 7px;border-radius:99px;font-size:11px;font-weight:600}
.tag.active{background:rgba(22,163,74,.18);color:#4ade80}.tag.revoked{background:rgba(220,38,38,.18);color:#f87171}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mut{color:var(--mut)}.mono{font-family:ui-monospace,Menlo,monospace}
#login{max-width:380px;margin:80px auto}
.hide{display:none}
canvas{max-height:140px}
</style><script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js"></script></head><body>
<div id="login" class="card">
  <h2>OZ Admin</h2>
  <div class="row"><input id="tok" type="password" placeholder="Admin token" style="flex:1"/><button onclick="saveTok()">Entrar</button></div>
  <p class="mut" id="loginerr"></p>
</div>
<div id="app" class="hide">
<header><h1>🦉 OZ Browser — Admin</h1><span class="mut" id="stat"></span><span style="flex:1"></span><button class="ghost" onclick="load()">↻ Refrescar</button><button class="ghost" onclick="logout()">Salir</button></header>
<div class="wrap">
  <div class="card">
    <h2>Crear acceso</h2>
    <div class="row">
      <input id="c_name" placeholder="Nombre"/>
      <input id="c_email" placeholder="Email"/>
      <input id="c_days" type="number" placeholder="Días (0 = sin vto)" style="width:150px"/>
      <input id="c_cap" type="number" placeholder="Máx disp. (def 2)" style="width:150px"/>
      <button onclick="createKey()">+ Generar clave</button>
      <span id="newkey" class="mono"></span>
    </div>
  </div>
  <div class="card"><h2>Actividad (14 días)</h2><canvas id="chart"></canvas></div>
  <div class="card"><h2>Licencias (<span id="nlic">0</span>)</h2><div style="overflow:auto"><table id="tlic"></table></div></div>
  <div class="card"><h2>Actividad reciente (<span id="nev">0</span>)</h2><div class="row" style="margin-bottom:10px"><input id="evfilter" placeholder="Filtrar (tipo, clave, host)…" oninput="renderEvents()" style="flex:1"/></div><div style="overflow:auto;max-height:360px"><table id="tev"></table></div></div>
</div>
</div>
<div id="pxmodal" class="hide" style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:50">
  <div class="card" style="width:660px;max-width:92vw;margin:0">
    <h2>Proxies de <span id="pxname" class="mono"></span></h2>
    <p class="mut" style="margin:0 0 8px">Un proxy por línea: <span class="mono">host:puerto:usuario:password</span>. Se entregan y auto-asignan a las identidades al activar la clave.</p>
    <div class="row" style="margin-bottom:8px">
      <button class="ghost" onclick="genDecodo()">⚡ Generar 10 Decodo Miami</button>
      <span class="mut" id="pxinfo"></span>
    </div>
    <textarea id="pxta" style="width:100%;height:230px;background:#0d0f15;border:1px solid var(--bd);border-radius:6px;color:var(--tx);font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:10px" placeholder="gate.decodo.com:10001:user-sp2f1ft6in-city-miami:PASSWORD"></textarea>
    <div class="row" style="margin-top:12px;justify-content:flex-end">
      <button class="ghost" onclick="closePx()">Cancelar</button>
      <button class="ok" onclick="savePx()">Guardar proxies</button>
    </div>
  </div>
</div>
<script>
let TOK=localStorage.getItem('oz_admin_tok')||''
let PXKEY=null
let DATA=null
function saveTok(){TOK=document.getElementById('tok').value.trim();localStorage.setItem('oz_admin_tok',TOK);load()}
function logout(){localStorage.removeItem('oz_admin_tok');location.reload()}
function fmt(ts){return ts?new Date(ts).toLocaleString():'—'}
function dayKey(ts){const d=new Date(ts);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
async function api(path,method,body){const r=await fetch(path,{method:method||'GET',headers:{authorization:'Bearer '+TOK,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json()}
async function load(){
  const d=await api('/admin/data')
  if(!d.ok){document.getElementById('loginerr').textContent='Token inválido';return}
  DATA=d
  document.getElementById('login').classList.add('hide');document.getElementById('app').classList.remove('hide')
  renderLicenses();renderChart();renderEvents()
}
function renderLicenses(){
  const acts={};(DATA.activations||[]).forEach(a=>{(acts[a.key]=acts[a.key]||[]).push(a)})
  const px={};(DATA.proxies||[]).forEach(p=>{px[p.key]=(px[p.key]||0)+1})
  document.getElementById('nlic').textContent=DATA.licenses.length
  document.getElementById('tlic').innerHTML='<tr><th>Clave</th><th>Nombre</th><th>Estado</th><th>Disp.</th><th>Proxies</th><th>Versiones</th><th>Últ. visto</th><th>Vto</th><th></th></tr>'+
   DATA.licenses.map(l=>{const a=acts[l.key]||[];const last=a.length?Math.max(...a.map(x=>x.last_seen)):0;const cap=l.max_devices||2;const np=px[l.key]||0;
   return '<tr><td class="mono">'+l.key+'</td><td>'+(l.name||'')+'<div class=mut style="font-size:11px">'+(l.email||'')+'</div></td>'+
   '<td><span class="tag '+l.status+'">'+l.status+'</span></td>'+
   '<td>'+a.length+'/'+cap+' <button class="ghost" title="Editar cap" onclick="setcap(\\''+l.key+'\\','+cap+')">✎</button>'+(a.length?' <button class="ghost" title="Liberar dispositivos" onclick="freedev(\\''+l.key+'\\')">⎋</button>':'')+'</td>'+
   '<td>'+(np?'<b>'+np+'</b>':'<span class=mut>0</span>')+' <button class="ghost" title="Editar proxies" onclick="editProxies(\\''+l.key+'\\',\\''+(l.name||'').replace(/\\x27/g,'')+'\\')">🌐</button></td>'+
   '<td class="mut">'+(a.map(x=>x.app_version||'?').join(', ')||'—')+'</td>'+
   '<td class="mut">'+fmt(last)+'</td><td class="mut">'+(l.expires_at?fmt(l.expires_at):'—')+'</td>'+
   '<td class="row">'+(l.status==='revoked'?'<button class="ok" onclick="act(\\''+l.key+'\\',\\'unrevoke\\')">Reactivar</button>':'<button class="danger" onclick="act(\\''+l.key+'\\',\\'revoke\\')">Revocar</button>')+
   ' <button class="ghost" onclick="del(\\''+l.key+'\\')">✕</button></td></tr>'}).join('')
}
function renderChart(){
  const days=[];const n=new Date();
  for(let i=13;i>=0;i--){const d=new Date(n);d.setDate(n.getDate()-i);days.push(dayKey(d.getTime()))}
  const c={};days.forEach(k=>c[k]=0);(DATA.events||[]).forEach(e=>{const k=dayKey(e.ts);if(k in c)c[k]++})
  if(window._chart)window._chart.destroy()
  window._chart=new Chart(document.getElementById('chart'),{type:'bar',data:{labels:days.map(d=>d.slice(5)),datasets:[{data:days.map(d=>c[d]),backgroundColor:'#6488ff'}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{color:'#9aa0ab',precision:0}},x:{ticks:{color:'#9aa0ab'}}}}})
}
function renderEvents(){
  const f=(document.getElementById('evfilter').value||'').toLowerCase()
  const evs=(DATA.events||[]).filter(e=>!f||((e.type||'')+(e.key||'')+(e.meta||'')).toLowerCase().includes(f))
  document.getElementById('nev').textContent=evs.length
  document.getElementById('tev').innerHTML='<tr><th>Fecha</th><th>Tipo</th><th>Clave</th><th>Detalle</th></tr>'+
   evs.map(e=>'<tr><td class="mut">'+fmt(e.ts)+'</td><td>'+e.type+'</td><td class="mono">'+(e.key||'')+'</td><td class="mut">'+(e.meta||'')+'</td></tr>').join('')
}
async function createKey(){const r=await api('/admin/create','POST',{name:c_name.value,email:c_email.value,days:Number(c_days.value)||0,maxDevices:Number(c_cap.value)||2});if(r.ok){document.getElementById('newkey').textContent='→ '+r.key;load()}}
async function act(key,a){if(!confirm(a+' '+key+'?'))return;await api('/admin/'+a,'POST',{key});load()}
async function del(key){if(!confirm('Eliminar '+key+' y sus activaciones?'))return;await api('/admin/delete','POST',{key});load()}
function setcap(key,cur){const v=prompt('Máx dispositivos para '+key,cur);if(v===null)return;api('/admin/setcap','POST',{key,maxDevices:Number(v)||2}).then(load)}
function freedev(key){if(!confirm('Liberar TODOS los dispositivos de '+key+'? (tendrá que reactivar)'))return;api('/admin/deactivate','POST',{key}).then(load)}
// ---- proxies por usuario ----
function pxLine(p){return [p.host,p.port,p.username||'',p.password||''].join(':')}
async function editProxies(key,name){
  PXKEY=key
  document.getElementById('pxname').textContent=(name||'')+' · '+key
  document.getElementById('pxinfo').textContent=''
  const r=await api('/admin/getproxies','POST',{key})
  const rows=(r&&r.proxies)||[]
  document.getElementById('pxta').value=rows.map(pxLine).join('\\n')
  document.getElementById('pxmodal').classList.remove('hide')
}
function closePx(){document.getElementById('pxmodal').classList.add('hide');PXKEY=null}
function parsePx(text){
  const out=[]
  ;(text||'').split('\\n').map(s=>s.trim()).filter(Boolean).forEach(line=>{
    // host:port:user:pass  (pass may contain ':', so split first 3 only)
    const i1=line.indexOf(':');const i2=line.indexOf(':',i1+1);const i3=line.indexOf(':',i2+1)
    if(i1<0||i2<0)return
    const host=line.slice(0,i1);const port=Number(line.slice(i1+1,i2))
    let user='',pass=''
    if(i3<0){user=line.slice(i2+1)}else{user=line.slice(i2+1,i3);pass=line.slice(i3+1)}
    if(!host||!port)return
    const cm=/-city-([a-z_]+)/i.exec(user);const city=cm?cm[1]:''
    out.push({host,port,protocol:'https',username:user,password:pass,city,country:city?'US':'',tags:['decodo']})
  })
  return out
}
async function savePx(){
  const list=parsePx(document.getElementById('pxta').value)
  const r=await api('/admin/setproxies','POST',{key:PXKEY,proxies:list})
  if(r&&r.ok){closePx();load()}else{alert('Error guardando proxies')}
}
function genDecodo(){
  let cust=localStorage.getItem('oz_decodo_user')||''
  let pass=localStorage.getItem('oz_decodo_pass')||''
  if(!cust){cust=prompt('Usuario master Decodo','sp2f1ft6in')||'';if(!cust)return;localStorage.setItem('oz_decodo_user',cust)}
  if(!pass){pass=prompt('Password master Decodo')||'';if(!pass)return;localStorage.setItem('oz_decodo_pass',pass)}
  const city=prompt('Ciudad (slug)','miami')||'miami'
  // Prefijo de sesión único por usuario → sus 10 IPs sticky no chocan con otros.
  const pref=(PXKEY||'').replace(/[^A-Z0-9]/gi,'').slice(-4).toLowerCase()||'u'+Date.now().toString(36).slice(-4)
  const lines=[]
  for(let i=1;i<=10;i++){
    const sid=pref+String(i).padStart(2,'0')
    const user='user-'+cust+'-country-us-city-'+city+'-sessionduration-30-session-'+sid
    lines.push('gate.decodo.com:10001:'+user+':'+pass)
  }
  document.getElementById('pxta').value=lines.join('\\n')
  document.getElementById('pxinfo').textContent='10 sesiones sticky Miami (session '+pref+'01..'+pref+'10) — revisá y Guardá'
}
if(TOK)load()
</script></body></html>`
