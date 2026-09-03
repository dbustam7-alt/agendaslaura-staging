/* Agenda Laura — login, persistencia en Supabase, validación, facturación y export.
   Sistema unificado: toda entidad (CES/AUNA/NOEL y cualquiera que se agregue) es una
   fila de la tabla `entidades` con un `tipo` que define cómo se valida y se factura:
     - franja_fija: bloque semanal fijo de horas (ej. CES). No factura, solo controla choques.
     - por_hora:    tarifa por hora, ordinaria vs. nocturna/fin de semana (ej. AUNA).
     - por_agenda:  turnos variables facturados por remitente/paciente (ej. NOEL). */

const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const TIPO_LABEL = { franja_fija:"Por franja horaria", por_hora:"Por hora", por_agenda:"Por agenda" };
const TIPO_ICON = { franja_fija:"🟣", por_hora:"🔵", por_agenda:"🟠" };

let ENTIDADES = [];
let REMITENTES = [];
let TURNOS = [];
let editingTurnoId = null; // id del turno que se está editando en "Registrar turno", o null si es uno nuevo

// ---------- Deducciones (trabajador independiente) ----------
// Se aplican como % del valor bruto facturado por turno (solo entidades "por hora" y
// "por agenda" facturan; "por franja horaria" no genera valor sobre el que descontar).
// Los porcentajes son editables en «Entidades y tarifas» — estos son solo valores
// iniciales razonables, no una tarifa legal fija: confírmalos con tu contador.
const DEFAULT_DEDUCCIONES = {
  segSocialBasePct: 40,   // % del bruto que es la base (IBC) de seguridad social
  segSocialTasaPct: 28.5, // % (salud + pensión) aplicado sobre esa base
  vacacionesPct: 4.17,    // % del bruto
  cesantiasPct: 8.33,     // % del bruto
  retefuentePct: 11,      // % del bruto
};
let DEDUCCIONES = {...DEFAULT_DEDUCCIONES};

function calcDeducciones(subtotal){
  const baseSegSocial = subtotal * (DEDUCCIONES.segSocialBasePct / 100);
  const segSocial = baseSegSocial * (DEDUCCIONES.segSocialTasaPct / 100);
  const vacaciones = subtotal * (DEDUCCIONES.vacacionesPct / 100);
  const cesantias = subtotal * (DEDUCCIONES.cesantiasPct / 100);
  const retefuente = subtotal * (DEDUCCIONES.retefuentePct / 100);
  const total = segSocial + vacaciones + cesantias + retefuente;
  return { segSocial, vacaciones, cesantias, retefuente, total, neto: subtotal - total };
}

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function getEntidad(id){ return ENTIDADES.find(e => e.id === id); }
function remitentesDeEntidad(entidadId){
  return REMITENTES.filter(r => r.entidadId === entidadId).sort((a,b)=> a.orden - b.orden);
}

// ---------- Conexión Supabase ----------
// La URL y la "anon key" son públicas por diseño (Supabase las espera en el
// cliente): por sí solas NO dan acceso a los datos. Row Level Security en el
// proyecto exige una sesión autenticada (haber iniciado sesión) para poder
// leer o escribir en las tablas. La "service role key" (que sí se salta esa
// protección) nunca debe ir aquí ni a ningún código de cliente.
const SUPABASE_URL = "https://vpiulzibbyqdgmzfyuzd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwaXVsemliYnlxZGdtemZ5dXpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzOTc3MTksImV4cCI6MjEwMzk3MzcxOX0.4Q-TmX1eyFKXh67qCz-B-PdZUxQsH4PhDUIsIksKp_Y";
// Si la librería de Supabase no cargó (ej. sin conexión), `sb` queda en null
// y el arranque muestra un aviso en vez de romper toda la página en silencio.
const sb = (window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// ---------- Deducciones: persistencia ----------
function rowToDeducciones(row){
  return {
    segSocialBasePct: Number(row.seg_social_base_pct),
    segSocialTasaPct: Number(row.seg_social_tasa_pct),
    vacacionesPct: Number(row.vacaciones_pct),
    cesantiasPct: Number(row.cesantias_pct),
    retefuentePct: Number(row.retefuente_pct),
  };
}
function deduccionesToRow(d){
  return {
    seg_social_base_pct: d.segSocialBasePct,
    seg_social_tasa_pct: d.segSocialTasaPct,
    vacaciones_pct: d.vacacionesPct,
    cesantias_pct: d.cesantiasPct,
    retefuente_pct: d.retefuentePct,
  };
}
async function fetchDeducciones(){
  const { data, error } = await sb.from("deducciones").select("*").eq("id", 1).single();
  if (error){ showAlert("Error cargando deducciones: " + error.message, "error"); return {...DEFAULT_DEDUCCIONES}; }
  return rowToDeducciones(data);
}
async function saveDeduccionesDB(){
  const { error } = await sb.from("deducciones").update(deduccionesToRow(DEDUCCIONES)).eq("id", 1);
  if (error) throw error;
}

// ---------- Entidades ----------
function rowToEntidad(row){
  return { id: row.id, nombre: row.nombre, tipo: row.tipo, color: row.color, config: row.config || {}, orden: row.orden, activo: row.activo };
}
async function fetchEntidades(){
  const { data, error } = await sb.from("entidades").select("*").order("orden");
  if (error){ showAlert("Error cargando entidades: " + error.message, "error"); return []; }
  return data.map(rowToEntidad);
}
async function insertEntidadDB(e){
  const { error } = await sb.from("entidades").insert({ nombre:e.nombre, tipo:e.tipo, color:e.color, config:e.config, orden:e.orden, activo:e.activo });
  if (error) throw error;
}
async function updateEntidadDB(id, e){
  // El tipo no se puede cambiar una vez creada la entidad: cambiarlo corrompería
  // la validación y facturación de los turnos ya registrados con ese tipo.
  const { error } = await sb.from("entidades").update({ nombre:e.nombre, color:e.color, config:e.config, activo:e.activo }).eq("id", id);
  if (error) throw error;
}
async function deleteEntidadDB(id){
  // La base de datos rechaza el borrado (llave foránea) si la entidad todavía
  // tiene turnos o remitentes asociados — eso es intencional, ver isForeignKeyError().
  const { error } = await sb.from("entidades").delete().eq("id", id);
  if (error) throw error;
}
function isForeignKeyError(e){
  return !!e && (e.code === "23503" || /foreign key|violates.*constraint/i.test(e.message || ""));
}

// ---------- Remitentes (entidades tipo "por_agenda": EPS, aseguradoras, Particular, Póliza...) ----------
async function fetchRemitentes(){
  const { data, error } = await sb.from("remitentes").select("*").eq("activo", true).order("orden");
  if (error){ showAlert("Error cargando remitentes: " + error.message, "error"); return []; }
  return data.map(r => ({ id: r.id, nombre: r.nombre, tarifa: Number(r.tarifa), orden: r.orden, entidadId: r.entidad_id }));
}
async function insertRemitenteDB(entidadId, nombre, tarifa){
  const orden = remitentesDeEntidad(entidadId).length;
  const { error } = await sb.from("remitentes").insert({ nombre, tarifa, orden, activo:true, entidad_id: entidadId });
  if (error) throw error;
}
async function updateRemitenteDB(id, nombre, tarifa){
  const { error } = await sb.from("remitentes").update({ nombre, tarifa }).eq("id", id);
  if (error) throw error;
}

// ---------- Turnos ----------
const TURNO_SELECT = "*, turno_detalle(cantidad, remitente_id, remitentes(nombre, tarifa))";

function rowToTurno(row){
  const detalle = (row.turno_detalle || [])
    .filter(d => d.cantidad > 0)
    .map(d => ({
      remitenteId: d.remitente_id,
      nombre: d.remitentes ? d.remitentes.nombre : "(remitente eliminado)",
      tarifa: d.remitentes ? Number(d.remitentes.tarifa) : 0,
      cantidad: d.cantidad,
    }));
  return {
    id: row.id,
    entidadId: row.entidad_id,
    fecha: row.fecha,
    inicio: row.inicio.slice(0,5),
    fin: row.fin.slice(0,5),
    sede: row.sede || undefined,
    detalle,
  };
}
function turnoToRow(t){
  return {
    entidad_id: t.entidadId,
    fecha: t.fecha,
    inicio: t.inicio,
    fin: t.fin,
    sede: t.sede || null,
  };
}
async function saveDetalle(turnoId, detalle){
  const rows = (detalle || []).filter(d => d.cantidad > 0 && d.remitenteId).map(d => ({
    turno_id: turnoId, remitente_id: d.remitenteId, cantidad: d.cantidad,
  }));
  if (rows.length === 0) return;
  const { error } = await sb.from("turno_detalle").insert(rows);
  if (error) throw error;
}
async function fetchTurnos(){
  const { data, error } = await sb.from("turnos").select(TURNO_SELECT).order("fecha").order("inicio");
  if (error){ showAlert("Error cargando turnos: " + error.message, "error"); return []; }
  return data.map(rowToTurno);
}
async function insertTurnoDB(t){
  const { data, error } = await sb.from("turnos").insert(turnoToRow(t)).select().single();
  if (error) throw error;
  if (t.detalle && t.detalle.length) await saveDetalle(data.id, t.detalle);
  const { data: full, error: err2 } = await sb.from("turnos").select(TURNO_SELECT).eq("id", data.id).single();
  if (err2) throw err2;
  return rowToTurno(full);
}
async function insertTurnosBulkDB(list){
  const { data, error } = await sb.from("turnos").insert(list.map(turnoToRow)).select();
  if (error) throw error;
  // Supabase devuelve las filas insertadas en el mismo orden que se enviaron.
  for (let i = 0; i < data.length; i++){
    if (list[i].detalle && list[i].detalle.length){
      await saveDetalle(data[i].id, list[i].detalle);
    }
  }
  const ids = data.map(r => r.id);
  const { data: full, error: err2 } = await sb.from("turnos").select(TURNO_SELECT).in("id", ids);
  if (err2) throw err2;
  return full.map(rowToTurno);
}
async function updateTurnoDB(id, t){
  const { error } = await sb.from("turnos").update(turnoToRow(t)).eq("id", id);
  if (error) throw error;
  // El detalle por remitente se reemplaza por completo: se borra lo anterior y se
  // inserta lo nuevo, así no hace falta comparar filas una por una.
  const { error: delErr } = await sb.from("turno_detalle").delete().eq("turno_id", id);
  if (delErr) throw delErr;
  if (t.detalle && t.detalle.length) await saveDetalle(id, t.detalle);
  const { data: full, error: err2 } = await sb.from("turnos").select(TURNO_SELECT).eq("id", id).single();
  if (err2) throw err2;
  return rowToTurno(full);
}
async function deleteTurnoDB(id){
  const { error } = await sb.from("turnos").delete().eq("id", id);
  if (error) throw error;
}

// ---------- Autenticación ----------
function showLoginAlert(msg, type){
  const box = document.getElementById("login-alert");
  box.hidden = false;
  box.className = "alert " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
}
function showLoginScreen(){
  document.getElementById("app-root").hidden = true;
  document.getElementById("login-screen").hidden = false;
  document.getElementById("login-password").value = "";
}
async function enterApp(){
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app-root").hidden = false;

  const { data: { user } } = await sb.auth.getUser();
  document.getElementById("user-email-label").textContent = user ? user.email : "";

  ENTIDADES = await fetchEntidades();
  REMITENTES = await fetchRemitentes();
  TURNOS = await fetchTurnos();
  DEDUCCIONES = await fetchDeducciones();

  renderEntidadesMaestro();
  renderRemitenteEntidadSelector();
  renderEntidadFormOptions();
  renderImportEntidadOptions();
  loadDeduccionesIntoForm();

  document.getElementById("f-fecha").value = new Date().toISOString().slice(0,10);
  document.getElementById("filter-month").value = new Date().toISOString().slice(0,7);

  renderAll();
}
async function handleLogin(e){
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const btn = document.getElementById("btn-login");
  btn.disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  if (error){
    showLoginAlert("No se pudo iniciar sesión: correo o contraseña incorrectos.", "error");
  }
}
async function handleLogout(){
  await sb.auth.signOut();
}

// ---------- Helpers de fecha/hora ----------
function parseTimeParts(hhmm){
  const [h,m] = hhmm.split(":").map(Number);
  return [h,m,0,0];
}
function toDateTime(fechaISO, horaHHMM){
  const d = new Date(fechaISO + "T00:00:00");
  const [h,m] = parseTimeParts(horaHHMM);
  d.setHours(h,m,0,0);
  return d;
}
function turnoInterval(t){
  const start = toDateTime(t.fecha, t.inicio);
  let end = toDateTime(t.fecha, t.fin);
  if (end.getTime() <= start.getTime()) end.setDate(end.getDate()+1); // cruza medianoche
  return {start, end};
}
function overlaps(aStart, aEnd, bStart, bEnd){
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}
function isWeekendDate(d){
  const day = d.getDay(); // 0=Dom, 6=Sáb
  return day === 0 || day === 6;
}
function minutesOfDay(d){ return d.getHours()*60 + d.getMinutes(); }
function fmtMoney(n){
  return "$" + Math.round(n).toLocaleString("es-CO");
}
function fmtHours(h){
  return (Math.round(h*100)/100).toString();
}

// ---------- Bloques de franja fija (generaliza el antiguo bloqueo CES) ----------
function franjaBlockForDate(entidad, fechaISO){
  const cfg = entidad.config || {};
  const dias = cfg.dias || [];
  const d = new Date(fechaISO + "T00:00:00");
  if (cfg.vigenciaDesde && d < new Date(cfg.vigenciaDesde + "T00:00:00")) return null;
  if (!dias.includes(d.getDay())) return null;
  const exactStart = toDateTime(fechaISO, cfg.horaInicio || "00:00");
  const exactEnd = toDateTime(fechaISO, cfg.horaFin || "00:00");
  const start = new Date(exactStart); start.setMinutes(start.getMinutes() - Number(cfg.bufferMin || 0));
  const end = new Date(exactEnd); end.setMinutes(end.getMinutes() + Number(cfg.bufferMin || 0));
  return { start, end, exactStart, exactEnd, entidad };
}
function franjaBlocksInRange(start, end){
  const franjaEntidades = ENTIDADES.filter(e => e.tipo === "franja_fija" && e.activo);
  const blocks = [];
  let d = new Date(start); d.setHours(0,0,0,0);
  const last = new Date(end);
  while (d.getTime() <= last.getTime()){
    const iso = d.toISOString().slice(0,10);
    for (const ent of franjaEntidades){
      const b = franjaBlockForDate(ent, iso);
      if (b) blocks.push(b);
    }
    d.setDate(d.getDate()+1);
  }
  return blocks;
}
function franjaEntidadesForDate(iso){
  return ENTIDADES.filter(e => e.tipo === "franja_fija" && e.activo && franjaBlockForDate(e, iso));
}
function franjaEntidadForDate(iso){
  return franjaEntidadesForDate(iso)[0] || null;
}

// ---------- Validación de choques ----------
function validarTurno(nuevo, excludeId, extra){
  const {start, end} = turnoInterval(nuevo);
  const candidatos = extra && extra.length ? TURNOS.concat(extra) : TURNOS;

  // 1. Choque contra otros turnos ya registrados (incluyendo un lote de importación en curso)
  for (const t of candidatos){
    if (excludeId && t.id === excludeId) continue;
    const iv = turnoInterval(t);
    if (overlaps(start, end, iv.start, iv.end)){
      const otra = getEntidad(t.entidadId);
      return {
        ok:false,
        motivo:`Choque con turno existente: ${otra ? otra.nombre : "?"} el ${t.fecha} (${t.inicio}–${t.fin}).`
      };
    }
  }

  // 2. Choque contra bloques fijos de cualquier entidad "por franja horaria" (incluye buffer de traslado)
  const blocks = franjaBlocksInRange(start, end);
  for (const b of blocks){
    if (overlaps(start, end, b.start, b.end)){
      if (nuevo.entidadId === b.entidad.id){
        // El propio turno de esa entidad debe caber dentro del bloque exacto (sin contar el buffer)
        if (start.getTime() < b.exactStart.getTime() || end.getTime() > b.exactEnd.getTime()){
          const cfg = b.entidad.config;
          return {
            ok:false,
            motivo:`El turno ${b.entidad.nombre} debe estar contenido en su bloque fijo ${cfg.horaInicio}–${cfg.horaFin}.`
          };
        }
        continue; // es el propio bloque, válido
      }
      const cfg = b.entidad.config;
      return {
        ok:false,
        motivo:`Choque con el BLOQUE FIJO de ${b.entidad.nombre} (${cfg.horaInicio}–${cfg.horaFin} ± ${cfg.bufferMin} min de traslado) el ${nuevo.fecha}.`
      };
    }
  }

  return {ok:true};
}

// ---------- Facturación por hora (generaliza el antiguo cálculo de AUNA) ----------
function computeHourlyBilling(start, end, cfg){
  const noctInicio = (cfg.noctInicio || "19:00").slice(0,5);
  const noctFin = (cfg.noctFin || "07:00").slice(0,5);
  const tarifaOrd = Number(cfg.tarifaOrd || 0), tarifaNoc = Number(cfg.tarifaNoc || 0);

  function isInNocturno(d){
    const [sh,sm] = noctInicio.split(":").map(Number);
    const [eh,em] = noctFin.split(":").map(Number);
    const startMin = sh*60+sm, endMin = eh*60+em;
    const cur = minutesOfDay(d);
    if (startMin > endMin) return cur >= startMin || cur < endMin; // cruza medianoche
    return cur >= startMin && cur < endMin;
  }
  function tarifaEnInstante(d){
    if (isWeekendDate(d)) return tarifaNoc;   // fin de semana completo
    if (isInNocturno(d)) return tarifaNoc;    // nocturno entre semana
    return tarifaOrd;                          // ordinario diurno
  }

  const pts = new Set([start.getTime(), end.getTime()]);
  let d = new Date(start); d.setHours(0,0,0,0);
  while (d.getTime() <= end.getTime()){
    pts.add(d.getTime()); // medianoche
    const [sh,sm] = noctInicio.split(":").map(Number);
    const [eh,em] = noctFin.split(":").map(Number);
    const ns = new Date(d); ns.setHours(sh,sm,0,0);
    const ne = new Date(d); ne.setHours(eh,em,0,0);
    pts.add(ns.getTime()); pts.add(ne.getTime());
    d.setDate(d.getDate()+1);
  }
  const sorted = [...pts].filter(t=>t>=start.getTime() && t<=end.getTime()).sort((a,b)=>a-b);
  let ordMin=0, nocMin=0, subtotal=0;
  for (let i=0;i<sorted.length-1;i++){
    const a=sorted[i], b=sorted[i+1];
    if (b<=a) continue;
    const mid = new Date((a+b)/2);
    const rate = tarifaEnInstante(mid);
    const minutes = (b-a)/60000;
    if (rate === tarifaNoc) nocMin += minutes; else ordMin += minutes;
    subtotal += (minutes/60) * rate;
  }
  return { ordMin, nocMin, subtotal };
}

// ---------- Cálculo genérico por turno, según el tipo de su entidad ----------
function calcularTurno(t){
  const {start, end} = turnoInterval(t);
  const horas = (end - start) / 3600000;
  const ent = getEntidad(t.entidadId);
  if (!ent) return { horas, subtotal:0, detalle:"(entidad eliminada)" };

  if (ent.tipo === "por_hora"){
    const b = computeHourlyBilling(start, end, ent.config);
    const detalle = `${t.sede || ""} · ord ${fmtHours(b.ordMin/60)}h / noc-finde ${fmtHours(b.nocMin/60)}h`;
    return { horas, subtotal: b.subtotal, detalle, ordMin: b.ordMin, nocMin: b.nocMin };
  }
  if (ent.tipo === "por_agenda"){
    const detalleLista = t.detalle || [];
    const total = detalleLista.reduce((s,d)=> s + d.cantidad, 0);
    const subtotal = detalleLista.reduce((s,d)=> s + d.cantidad*d.tarifa, 0);
    const resumen = detalleLista.length ? detalleLista.map(d => `${d.nombre} (${d.cantidad})`).join(", ") : "—";
    return { horas, subtotal, detalle: `${total} pac./visitas: ${resumen}`, detalleLista, total };
  }
  // franja_fija
  return { horas, subtotal: 0, detalle: "Registro horas contrato" };
}

// ---------- Render: alerta ----------
function showAlert(msg, type){
  const box = document.getElementById("alert-box");
  box.hidden = false;
  box.className = "alert " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
}

// ---------- Render: tabla agenda ----------
function getFilteredTurnos(){
  const month = document.getElementById("filter-month").value; // "YYYY-MM"
  let list = [...TURNOS];
  if (month) list = list.filter(t => t.fecha.slice(0,7) === month);
  list.sort((a,b)=>{
    const ia = turnoInterval(a), ib = turnoInterval(b);
    return ia.start - ib.start;
  });
  return list;
}

function renderAgenda(){
  const tbody = document.querySelector("#tbl-agenda tbody");
  tbody.innerHTML = "";
  const list = getFilteredTurnos();
  for (const t of list){
    const d = new Date(t.fecha + "T00:00:00");
    const calc = calcularTurno(t);
    const ent = getEntidad(t.entidadId);
    const nombre = ent ? ent.nombre : "(eliminada)";
    const color = ent ? ent.color : "#94a3b8";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.fecha}</td>
      <td>${DIAS[d.getDay()]}</td>
      <td><span class="badge" style="--badge-color:${color}">${esc(nombre)}</span></td>
      <td>${t.inicio}</td>
      <td>${t.fin}</td>
      <td>${fmtHours(calc.horas)}</td>
      <td>${esc(calc.detalle)}</td>
      <td>${calc.subtotal ? fmtMoney(calc.subtotal) : "—"}</td>
      <td style="white-space:nowrap;">
        <button class="btn secondary btn-sm" data-edit="${t.id}">Editar</button>
        <button class="btn danger-link" data-del="${t.id}">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.addEventListener("click", ()=> startEditTurno(btn.dataset.edit));
  });
  tbody.querySelectorAll("[data-del]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      try{
        await deleteTurnoDB(btn.dataset.del);
        TURNOS = TURNOS.filter(t=>t.id !== btn.dataset.del);
        if (editingTurnoId === btn.dataset.del) cancelEditTurno();
        renderAll();
      }catch(e){
        showAlert("Error eliminando el turno: " + e.message, "error");
      }
    });
  });
}

// ---------- Render: resumen financiero ----------
function renderResumen(){
  const list = getFilteredTurnos();
  const acc = {};
  for (const t of list){
    const ent = getEntidad(t.entidadId);
    if (!ent) continue;
    if (!acc[ent.id]) acc[ent.id] = { entidad: ent, horas:0, subtotal:0, ordMin:0, nocMin:0, porRemitente:{} };
    const calc = calcularTurno(t);
    const a = acc[ent.id];
    a.horas += calc.horas;
    a.subtotal += calc.subtotal;
    if (ent.tipo === "por_hora"){ a.ordMin += calc.ordMin; a.nocMin += calc.nocMin; }
    if (ent.tipo === "por_agenda"){
      for (const d of (calc.detalleLista || [])){
        const cur = a.porRemitente[d.nombre] || {cantidad:0, subtotal:0};
        cur.cantidad += d.cantidad; cur.subtotal += d.cantidad*d.tarifa;
        a.porRemitente[d.nombre] = cur;
      }
    }
  }
  const activas = Object.values(acc).sort((x,y)=> x.entidad.orden - y.entidad.orden);
  const total = activas.reduce((s,a)=> s + a.subtotal, 0);

  // Bloque de deducciones (independiente) que se repite en cada entidad que sí factura.
  function deduccionesRows(subtotal){
    const ded = calcDeducciones(subtotal);
    return `
        <div class="row"><span>Bruto</span><b>${fmtMoney(subtotal)}</b></div>
        <div class="row"><span>− Seguridad social</span><span>${fmtMoney(ded.segSocial)}</span></div>
        <div class="row"><span>− Vacaciones</span><span>${fmtMoney(ded.vacaciones)}</span></div>
        <div class="row"><span>− Cesantías</span><span>${fmtMoney(ded.cesantias)}</span></div>
        <div class="row"><span>− Retefuente</span><span>${fmtMoney(ded.retefuente)}</span></div>
        <div class="total">Neto: ${fmtMoney(ded.neto)}</div>`;
  }

  const cards = activas.map(a=>{
    const e = a.entidad;
    let body;
    if (e.tipo === "franja_fija"){
      body = `
        <div class="row"><span>Horas registradas</span><span>${fmtHours(a.horas)} h</span></div>
        <div class="row"><span>Facturación</span><span>No aplica (cumplimiento contrato)</span></div>`;
    } else if (e.tipo === "por_hora"){
      body = `
        <div class="row"><span>Horas ordinarias</span><span>${fmtHours(a.ordMin/60)} h</span></div>
        <div class="row"><span>Horas nocturno/fin de semana</span><span>${fmtHours(a.nocMin/60)} h</span></div>
        ${deduccionesRows(a.subtotal)}`;
    } else {
      const rows = Object.entries(a.porRemitente).sort((x,y)=> y[1].subtotal - x[1].subtotal)
        .map(([nombre,v])=> `<div class="row"><span>${esc(nombre)}</span><b>${v.cantidad} · ${fmtMoney(v.subtotal)}</b></div>`).join("");
      body = `${rows}${deduccionesRows(a.subtotal)}`;
    }
    return `<div class="resumen-item"><h3>${TIPO_ICON[e.tipo] || "•"} ${esc(e.nombre)}</h3>${body}</div>`;
  }).join("");

  const dedTotal = calcDeducciones(total);
  document.getElementById("resumen-financiero").innerHTML = cards + `
    <div class="resumen-item">
      <h3>💵 Total periodo (bruto)</h3>
      <div class="total">${fmtMoney(total)}</div>
    </div>
    <div class="resumen-item">
      <h3>🧾 Deducciones y neto (periodo)</h3>
      <div class="row"><span>Seguridad social (${DEDUCCIONES.segSocialTasaPct}% sobre ${DEDUCCIONES.segSocialBasePct}% IBC)</span><span>${fmtMoney(dedTotal.segSocial)}</span></div>
      <div class="row"><span>Vacaciones (${DEDUCCIONES.vacacionesPct}%)</span><span>${fmtMoney(dedTotal.vacaciones)}</span></div>
      <div class="row"><span>Cesantías (${DEDUCCIONES.cesantiasPct}%)</span><span>${fmtMoney(dedTotal.cesantias)}</span></div>
      <div class="row"><span>Retefuente (${DEDUCCIONES.retefuentePct}%)</span><span>${fmtMoney(dedTotal.retefuente)}</span></div>
      <div class="row"><span><strong>Total deducciones</strong></span><b>${fmtMoney(dedTotal.total)}</b></div>
      <div class="total">Neto estimado: ${fmtMoney(dedTotal.neto)}</div>
    </div>
  `;
}

// ---------- Calendario mensual ----------
let calendarMonth = new Date().toISOString().slice(0,7); // "YYYY-MM"

function renderCalendar(){
  const [y, m] = calendarMonth.split("-").map(Number);
  const monthIndex0 = m - 1;
  document.getElementById("cal-label").textContent = `${MESES[monthIndex0]} ${y}`;

  const firstOfMonth = new Date(y, monthIndex0, 1);
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // 0=Lun ... 6=Dom
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - firstWeekday);

  const todayISO = new Date().toISOString().slice(0,10);
  const byDate = {};
  for (const t of TURNOS) (byDate[t.fecha] = byDate[t.fecha] || []).push(t);
  for (const arr of Object.values(byDate)) arr.sort((a,b)=> a.inicio.localeCompare(b.inicio));

  let html = "";
  const cursor = new Date(gridStart);
  for (let i = 0; i < 42; i++){
    const iso = cursor.toISOString().slice(0,10);
    const inMonth = cursor.getMonth() === monthIndex0;
    const isToday = iso === todayISO;
    const franjaEnts = franjaEntidadesForDate(iso);
    const dayTurnos = byDate[iso] || [];

    const classes = ["cal-cell"];
    if (!inMonth) classes.push("cal-cell-out");
    if (isToday) classes.push("cal-cell-today");
    let styleAttr = "";
    let titleAttr = "";
    if (franjaEnts.length){
      classes.push("cal-cell-franja");
      styleAttr = ` style="--franja-color:${franjaEnts[0].color}"`;
      titleAttr = ` title="Bloqueo fijo ${esc(franjaEnts.map(e=>e.nombre).join(", "))}"`;
    }

    // Chip informativo del bloque fijo (no es un turno registrado, no se puede eliminar).
    const blockChips = franjaEnts.map(ent=>{
      const cfg = ent.config || {};
      return `<span class="cal-chip cal-chip-block" style="--chip-color:${ent.color}" title="Bloqueo fijo ${esc(ent.nombre)} ${cfg.horaInicio}–${cfg.horaFin}">${cfg.horaInicio}–${cfg.horaFin} ${esc(ent.nombre)}</span>`;
    }).join("");

    const chips = dayTurnos.map(t=>{
      const calc = calcularTurno(t);
      const ent = getEntidad(t.entidadId);
      const nombre = ent ? ent.nombre : "?";
      const color = ent ? ent.color : "#94a3b8";
      const title = `${nombre} ${t.inicio}–${t.fin} · ${calc.detalle}${calc.subtotal ? " · " + fmtMoney(calc.subtotal) : ""}`;
      return `<button type="button" class="cal-chip" style="--chip-color:${color}" data-del="${t.id}" title="${esc(title)} — clic para eliminar">${t.inicio}–${t.fin} ${esc(nombre)}</button>`;
    }).join("");

    html += `<div class="${classes.join(" ")}"${styleAttr}${titleAttr}>
      <span class="cal-daynum">${cursor.getDate()}</span>
      <div class="cal-chips">${blockChips}${chips}</div>
    </div>`;

    cursor.setDate(cursor.getDate()+1);
  }

  const grid = document.getElementById("cal-grid");
  grid.innerHTML = html;
  grid.querySelectorAll("[data-del]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const t = TURNOS.find(x=>x.id === btn.dataset.del);
      if (!t) return;
      const ent = getEntidad(t.entidadId);
      if (!confirm(`¿Eliminar turno ${ent ? ent.nombre : "?"} del ${t.fecha} (${t.inicio}–${t.fin})?`)) return;
      try{
        await deleteTurnoDB(btn.dataset.del);
        TURNOS = TURNOS.filter(x=>x.id !== btn.dataset.del);
        renderAll();
      }catch(e){
        showAlert("Error eliminando el turno: " + e.message, "error");
      }
    });
  });
}

function shiftCalendarMonth(delta){
  const [y,m] = calendarMonth.split("-").map(Number);
  const d = new Date(y, m-1+delta, 1);
  calendarMonth = d.toISOString().slice(0,7);
  renderCalendar();
}

function renderAll(){
  renderAgenda();
  renderResumen();
  renderCalendar();
}

// ---------- Formulario: registrar turno ----------
function currentFormEntidad(){
  return getEntidad(document.getElementById("f-entidad").value);
}
function toggleFormFields(){
  const ent = currentFormEntidad();
  const tipo = ent ? ent.tipo : null;
  document.getElementById("f-sede-wrap").hidden = tipo !== "por_hora";
  document.getElementById("agenda-fields").hidden = tipo !== "por_agenda";
}
function renderEntidadFormOptions(){
  const sel = document.getElementById("f-entidad");
  const cur = sel.value;
  const activas = ENTIDADES.filter(e=>e.activo).sort((a,b)=>a.orden-b.orden);
  sel.innerHTML = activas.map(e=>`<option value="${e.id}">${esc(e.nombre)}</option>`).join("");
  if (activas.some(e=>e.id===cur)) sel.value = cur;
  else if (activas.length) sel.value = activas[0].id;
  toggleFormFields();
  const ent = currentFormEntidad();
  if (ent && ent.tipo === "por_agenda") resetAgendaFormRows();
}

// ---------- Filas dinámicas de remitentes (entidades "por agenda") ----------
function addAgendaFormRow(){
  const ent = currentFormEntidad();
  const opciones = ent ? remitentesDeEntidad(ent.id) : [];
  const wrap = document.getElementById("f-agenda-rows");
  const row = document.createElement("div");
  row.className = "eps-row";
  row.innerHTML = `
    <select class="f-agenda-remitente">${opciones.map(r=>`<option value="${r.id}">${esc(r.nombre)}</option>`).join("")}</select>
    <input type="number" class="f-agenda-cantidad" min="0" value="0" placeholder="Cant.">
    <button type="button" class="btn ghost-icon eps-row-remove" aria-label="Quitar remitente">✕</button>
  `;
  row.querySelector(".eps-row-remove").addEventListener("click", ()=> row.remove());
  wrap.appendChild(row);
  return row;
}
function resetAgendaFormRows(){
  document.getElementById("f-agenda-rows").innerHTML = "";
  addAgendaFormRow();
}
function collectAgendaFormRows(){
  return Array.from(document.querySelectorAll("#f-agenda-rows .eps-row")).map(row=>{
    const remitenteId = row.querySelector(".f-agenda-remitente").value;
    const cantidad = Number(row.querySelector(".f-agenda-cantidad").value || 0);
    const rem = REMITENTES.find(r=>r.id === remitenteId);
    return { remitenteId, nombre: rem ? rem.nombre : "", tarifa: rem ? rem.tarifa : 0, cantidad };
  }).filter(d=>d.cantidad > 0);
}
function renderAgendaFormOptions(){
  const ent = currentFormEntidad();
  const opciones = ent ? remitentesDeEntidad(ent.id) : [];
  document.querySelectorAll(".f-agenda-remitente").forEach(sel=>{
    const cur = sel.value;
    sel.innerHTML = opciones.map(r=>`<option value="${r.id}">${esc(r.nombre)}</option>`).join("");
    if (opciones.some(o=>o.id===cur)) sel.value = cur;
  });
}

async function handleAddTurno(){
  const ent = currentFormEntidad();
  if (!ent){ showAlert("No hay ninguna entidad activa. Crea una primero en «Entidades y tarifas».", "error"); return; }
  const fecha = document.getElementById("f-fecha").value;
  const inicio = document.getElementById("f-inicio").value;
  const fin = document.getElementById("f-fin").value;

  if (!fecha || !inicio || !fin){
    showAlert("Completa fecha, hora de inicio y hora de fin.", "error");
    return;
  }

  const nuevo = { entidadId: ent.id, fecha, inicio, fin };
  if (ent.tipo === "por_hora") nuevo.sede = document.getElementById("f-sede").value.trim();
  if (ent.tipo === "por_agenda") nuevo.detalle = collectAgendaFormRows();

  const check = validarTurno(nuevo, editingTurnoId);
  if (!check.ok){
    showAlert(check.motivo, "error");
    return;
  }

  try{
    if (editingTurnoId){
      const saved = await updateTurnoDB(editingTurnoId, nuevo);
      const idx = TURNOS.findIndex(t=>t.id === editingTurnoId);
      if (idx !== -1) TURNOS[idx] = saved;
      showAlert(`Turno ${ent.nombre} actualizado (${fecha} ${inicio}–${fin}).`, "ok");
      cancelEditTurno();
    } else {
      const saved = await insertTurnoDB(nuevo);
      TURNOS.push(saved);
      showAlert(`Turno ${ent.nombre} registrado sin conflictos (${fecha} ${inicio}–${fin}).`, "ok");
      if (ent.tipo === "por_agenda") resetAgendaFormRows();
    }
    renderAll();
  }catch(e){
    showAlert("Error guardando el turno: " + e.message, "error");
  }
}

// Carga un turno ya registrado en el formulario de arriba para editarlo en vez de
// crear uno nuevo. Útil, por ejemplo, para registrar hoy la disponibilidad de una
// entidad "por agenda" (fecha/horario) y completar el detalle de pacientes después.
function startEditTurno(id){
  const t = TURNOS.find(x=>x.id === id);
  if (!t) return;
  const ent = getEntidad(t.entidadId);
  if (!ent){ showAlert("No se puede editar: la entidad de este turno ya no existe.", "error"); return; }
  if (!ent.activo){ showAlert(`No se puede editar: la entidad "${ent.nombre}" está desactivada. Actívala primero en «Entidades y tarifas».`, "error"); return; }

  editingTurnoId = id;
  document.getElementById("f-entidad").value = ent.id;
  toggleFormFields();
  document.getElementById("f-fecha").value = t.fecha;
  document.getElementById("f-inicio").value = t.inicio;
  document.getElementById("f-fin").value = t.fin;
  document.getElementById("f-sede").value = t.sede || "";

  if (ent.tipo === "por_agenda"){
    const wrap = document.getElementById("f-agenda-rows");
    wrap.innerHTML = "";
    const detalle = t.detalle && t.detalle.length ? t.detalle : [null];
    for (const d of detalle){
      const row = addAgendaFormRow();
      if (d){
        row.querySelector(".f-agenda-remitente").value = d.remitenteId;
        row.querySelector(".f-agenda-cantidad").value = d.cantidad;
      }
    }
  }

  document.getElementById("btn-add-turno").textContent = "Guardar cambios";
  document.getElementById("btn-cancel-edit").hidden = false;
  document.getElementById("f-entidad").closest("section").scrollIntoView({behavior:"smooth", block:"start"});
}
function cancelEditTurno(){
  editingTurnoId = null;
  document.getElementById("btn-add-turno").textContent = "Registrar turno";
  document.getElementById("btn-cancel-edit").hidden = true;
  document.getElementById("f-fecha").value = new Date().toISOString().slice(0,10);
  document.getElementById("f-inicio").value = "";
  document.getElementById("f-fin").value = "";
  document.getElementById("f-sede").value = "";
  resetAgendaFormRows();
}

// ---------- Maestro: entidades ----------
function buildEntidadConfigFields(tipo, cfg){
  cfg = cfg || {};
  if (tipo === "franja_fija"){
    const dias = cfg.dias || [1,2,3,4,5];
    const diasChecks = [[1,"Lun"],[2,"Mar"],[3,"Mié"],[4,"Jue"],[5,"Vie"],[6,"Sáb"],[0,"Dom"]]
      .map(([v,l])=>`<label class="inline chip-check"><input type="checkbox" class="ent-dia" value="${v}" ${dias.includes(v)?"checked":""}> ${l}</label>`).join("");
    return `
      <div class="ent-config-grid">
        <div class="ent-dias">${diasChecks}</div>
        <label>Hora inicio<input type="time" class="ent-hora-inicio" value="${cfg.horaInicio || "07:00"}"></label>
        <label>Hora fin<input type="time" class="ent-hora-fin" value="${cfg.horaFin || "11:00"}"></label>
        <label>Buffer traslado (min)<input type="number" class="ent-buffer" value="${cfg.bufferMin ?? 30}" min="0" step="5"></label>
        <label>Vigente desde<input type="date" class="ent-vigencia" value="${cfg.vigenciaDesde || ""}"></label>
      </div>`;
  }
  if (tipo === "por_hora"){
    return `
      <div class="ent-config-grid">
        <label>Tarifa ordinaria ($/h)<input type="number" class="ent-tarifa-ord" value="${cfg.tarifaOrd ?? 0}" step="1000"></label>
        <label>Tarifa nocturna/finde ($/h)<input type="number" class="ent-tarifa-noc" value="${cfg.tarifaNoc ?? 0}" step="1000"></label>
        <label>Nocturno desde<input type="time" class="ent-noct-inicio" value="${(cfg.noctInicio || "19:00").slice(0,5)}"></label>
        <label>Nocturno hasta<input type="time" class="ent-noct-fin" value="${(cfg.noctFin || "07:00").slice(0,5)}"></label>
      </div>`;
  }
  return `<p class="hint" style="margin:0;">Sin parámetros adicionales — administra sus remitentes y tarifas en «Remitentes por agenda».</p>`;
}
function collectEntidadConfigFromRow(tr, tipo){
  if (tipo === "franja_fija"){
    return {
      dias: Array.from(tr.querySelectorAll(".ent-dia:checked")).map(c=>Number(c.value)),
      horaInicio: tr.querySelector(".ent-hora-inicio").value,
      horaFin: tr.querySelector(".ent-hora-fin").value,
      bufferMin: Number(tr.querySelector(".ent-buffer").value || 0),
      vigenciaDesde: tr.querySelector(".ent-vigencia").value || null,
    };
  }
  if (tipo === "por_hora"){
    return {
      tarifaOrd: Number(tr.querySelector(".ent-tarifa-ord").value || 0),
      tarifaNoc: Number(tr.querySelector(".ent-tarifa-noc").value || 0),
      noctInicio: tr.querySelector(".ent-noct-inicio").value,
      noctFin: tr.querySelector(".ent-noct-fin").value,
    };
  }
  return {};
}
function renderEntidadesMaestro(){
  const tbody = document.getElementById("entidades-rows");
  tbody.innerHTML = ENTIDADES.map(e => `
    <tr data-id="${e.id}" data-tipo="${e.tipo}">
      <td><input type="text" class="ent-nombre" value="${esc(e.nombre)}"></td>
      <td><span class="badge" style="--badge-color:${e.color}">${TIPO_LABEL[e.tipo] || e.tipo}</span></td>
      <td>${buildEntidadConfigFields(e.tipo, e.config)}</td>
      <td><input type="color" class="ent-color" value="${e.color}"></td>
      <td class="center"><input type="checkbox" class="ent-activo" ${e.activo ? "checked" : ""}></td>
      <td class="center"><button type="button" class="btn ghost-icon ent-row-remove" aria-label="Eliminar entidad" title="Eliminar entidad">✕</button></td>
    </tr>
  `).join("");
}
function addEntidadMaestroRow(){
  const tbody = document.getElementById("entidades-rows");
  const tr = document.createElement("tr");
  tr.dataset.tipo = "franja_fija";
  tr.innerHTML = `
    <td><input type="text" class="ent-nombre" placeholder="Nombre de la entidad"></td>
    <td>
      <select class="ent-tipo-select">
        <option value="franja_fija">Por franja horaria</option>
        <option value="por_hora">Por hora</option>
        <option value="por_agenda">Por agenda</option>
      </select>
    </td>
    <td class="ent-config-cell">${buildEntidadConfigFields("franja_fija")}</td>
    <td><input type="color" class="ent-color" value="#2563eb"></td>
    <td class="center"><input type="checkbox" class="ent-activo" checked></td>
    <td class="center"><button type="button" class="btn ghost-icon ent-row-remove" aria-label="Quitar fila" title="Quitar fila (no guardada)">✕</button></td>
  `;
  tr.querySelector(".ent-tipo-select").addEventListener("change", (e)=>{
    tr.dataset.tipo = e.target.value;
    tr.querySelector(".ent-config-cell").innerHTML = buildEntidadConfigFields(e.target.value);
  });
  tbody.appendChild(tr);
}
async function saveEntidadesMaestro(){
  const rows = Array.from(document.querySelectorAll("#entidades-rows tr"));
  try{
    for (const tr of rows){
      const nombre = tr.querySelector(".ent-nombre").value.trim();
      if (!nombre) continue;
      const tipo = tr.dataset.tipo;
      const color = tr.querySelector(".ent-color").value;
      const activo = tr.querySelector(".ent-activo").checked;
      const config = collectEntidadConfigFromRow(tr, tipo);
      const id = tr.dataset.id;
      if (id) await updateEntidadDB(id, { nombre, color, activo, config });
      else await insertEntidadDB({ nombre, tipo, color, config, orden: ENTIDADES.length, activo });
    }
    ENTIDADES = await fetchEntidades();
    renderEntidadesMaestro();
    renderRemitenteEntidadSelector();
    renderEntidadFormOptions();
    renderImportEntidadOptions();
    showAlert("Entidades guardadas.", "ok");
    renderAll();
  }catch(e){
    showAlert("Error guardando entidades: " + e.message, "error");
  }
}
async function handleDeleteEntidad(id){
  const ent = getEntidad(id);
  const nombre = ent ? ent.nombre : "esta entidad";
  if (!confirm(`¿Eliminar definitivamente la entidad "${nombre}"?\n\nSolo funciona si no tiene turnos ni remitentes registrados. Si los tiene, desactívala en vez de eliminarla (destilda "Activa" y guarda).`)) return;
  try{
    await deleteEntidadDB(id);
    ENTIDADES = ENTIDADES.filter(e=>e.id !== id);
    renderEntidadesMaestro();
    renderRemitenteEntidadSelector();
    renderEntidadFormOptions();
    renderImportEntidadOptions();
    showAlert(`Entidad "${nombre}" eliminada.`, "ok");
    renderAll();
  }catch(e){
    if (isForeignKeyError(e)){
      showAlert(`No se puede eliminar "${nombre}": todavía tiene turnos o remitentes asociados. Desactívala (destilda "Activa" y guarda) en vez de eliminarla.`, "error");
    } else {
      showAlert(`Error eliminando "${nombre}": ` + e.message, "error");
    }
  }
}

// ---------- Maestro: deducciones (trabajador independiente) ----------
function loadDeduccionesIntoForm(){
  document.getElementById("ded-seg-base").value = DEDUCCIONES.segSocialBasePct;
  document.getElementById("ded-seg-tasa").value = DEDUCCIONES.segSocialTasaPct;
  document.getElementById("ded-vacaciones").value = DEDUCCIONES.vacacionesPct;
  document.getElementById("ded-cesantias").value = DEDUCCIONES.cesantiasPct;
  document.getElementById("ded-retefuente").value = DEDUCCIONES.retefuentePct;
}
function readDeduccionesFromForm(){
  DEDUCCIONES = {
    segSocialBasePct: Number(document.getElementById("ded-seg-base").value || 0),
    segSocialTasaPct: Number(document.getElementById("ded-seg-tasa").value || 0),
    vacacionesPct: Number(document.getElementById("ded-vacaciones").value || 0),
    cesantiasPct: Number(document.getElementById("ded-cesantias").value || 0),
    retefuentePct: Number(document.getElementById("ded-retefuente").value || 0),
  };
}
async function handleSaveDeducciones(){
  readDeduccionesFromForm();
  try{
    await saveDeduccionesDB();
    showAlert("Deducciones guardadas.", "ok");
    renderAll();
  }catch(e){
    showAlert("Error guardando deducciones: " + e.message, "error");
  }
}

// ---------- Maestro: remitentes por agenda ----------
function currentRemitenteEntidadId(){
  return document.getElementById("rem-entidad-select").value;
}
function renderRemitenteEntidadSelector(){
  const sel = document.getElementById("rem-entidad-select");
  const agendas = ENTIDADES.filter(e => e.tipo === "por_agenda").sort((a,b)=>a.orden-b.orden);
  const cur = sel.value;
  sel.innerHTML = agendas.map(e=>`<option value="${e.id}">${esc(e.nombre)}</option>`).join("");
  if (agendas.some(e=>e.id===cur)) sel.value = cur;
  renderRemitentesMaestro();
}
function renderRemitentesMaestro(){
  const entidadId = currentRemitenteEntidadId();
  const wrap = document.getElementById("remitentes-rows");
  wrap.innerHTML = remitentesDeEntidad(entidadId).map(r => `
    <tr data-id="${r.id}">
      <td><input type="text" class="rem-nombre" value="${esc(r.nombre)}"></td>
      <td class="num"><input type="number" class="rem-tarifa" value="${r.tarifa}" step="1000"></td>
    </tr>
  `).join("");
}
function addRemitenteMaestroRow(){
  const wrap = document.getElementById("remitentes-rows");
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input type="text" class="rem-nombre" placeholder="Nombre del remitente"></td>
    <td class="num"><input type="number" class="rem-tarifa" value="0" step="1000"></td>
  `;
  wrap.appendChild(tr);
}
async function saveRemitentesMaestro(){
  const entidadId = currentRemitenteEntidadId();
  if (!entidadId){
    showAlert("No hay ninguna entidad «Por agenda» creada todavía. Créala primero en «Entidades».", "error");
    return;
  }
  const rows = Array.from(document.querySelectorAll("#remitentes-rows tr"));
  try{
    for (const row of rows){
      const nombre = row.querySelector(".rem-nombre").value.trim();
      const tarifa = Number(row.querySelector(".rem-tarifa").value || 0);
      if (!nombre) continue;
      const id = row.dataset.id;
      if (id) await updateRemitenteDB(id, nombre, tarifa);
      else await insertRemitenteDB(entidadId, nombre, tarifa);
    }
    REMITENTES = await fetchRemitentes();
    renderRemitentesMaestro();
    renderAgendaFormOptions();
    showAlert("Remitentes guardados.", "ok");
    renderAll();
  }catch(e){
    showAlert("Error guardando remitentes: " + e.message, "error");
  }
}

// ---------- Importador masivo ----------
let importPreviewRows = [];

function currentImportEntidad(){
  return getEntidad(document.getElementById("imp-entidad").value);
}
function importFormatFor(entidad){
  if (!entidad) return { cols:["Fecha","Inicio","Fin"], hint:"Selecciona una entidad.", placeholder:"" };
  if (entidad.tipo === "por_agenda"){
    return {
      cols:["Fecha","Inicio","Fin","Remitente","Cantidad"],
      hint:`Columnas: Fecha, Hora inicio, Hora fin, Nombre del remitente (debe existir en «Remitentes por agenda» de ${entidad.nombre}, incluye Particular/Póliza si aplica) y Cantidad. Si un turno tiene varios remitentes, repite la fila con la misma Fecha/Inicio/Fin y cambia solo remitente y cantidad.`,
      placeholder:"2026-09-03\t08:00\t12:00\tParticular\t2\n2026-09-03\t08:00\t12:00\tPóliza\t1\n2026-09-03\t08:00\t12:00\tSalud Total EPS\t3",
    };
  }
  if (entidad.tipo === "por_hora"){
    return {
      cols:["Fecha","Inicio","Fin","Sede"],
      hint:"Columnas: Fecha, Hora inicio, Hora fin, Sede (opcional, texto libre).",
      placeholder:"2026-09-05\t08:00\t16:00\tLa 80\n2026-09-08\t18:00\t22:00\tSur",
    };
  }
  return {
    cols:["Fecha","Inicio","Fin"],
    hint:"Columnas: Fecha (AAAA-MM-DD o DD/MM/AAAA), Hora inicio (HH:MM), Hora fin (HH:MM).",
    placeholder:"2026-10-05\t07:00\t11:00\n2026-10-06\t07:00\t10:30",
  };
}

function normalizeImportDate(raw){
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, mo, d;
  if (m){ y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  const iso = `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const check = new Date(iso + "T00:00:00");
  if (check.getFullYear() !== y || check.getMonth()+1 !== mo || check.getDate() !== d) return null;
  return iso;
}
function normalizeImportTime(raw){
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${String(h).padStart(2,"0")}:${m[2]}`;
}
function parseImportText(text){
  return text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0).map(line=>{
    const sep = line.includes("\t") ? "\t" : ",";
    return line.split(sep).map(c=>c.trim().replace(/^"(.*)"$/,"$1"));
  });
}

function updateImportFormatHint(){
  const fmt = importFormatFor(currentImportEntidad());
  document.getElementById("imp-format-hint").textContent = fmt.hint;
  document.getElementById("imp-textarea").placeholder = fmt.placeholder;
}

function downloadImportTemplate(){
  const ent = currentImportEntidad();
  if (!ent) return;
  const fmt = importFormatFor(ent);
  const exampleRows = fmt.placeholder ? fmt.placeholder.split("\n").map(line => line.split("\t")) : [];
  const rows = [fmt.cols, ...exampleRows];
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  downloadFile(`plantilla-turnos-${ent.nombre.toLowerCase().replace(/\s+/g,"-")}.csv`, csv, "text/csv;charset=utf-8;");
}

function handleImportFile(file){
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")){
    if (typeof XLSX === "undefined"){
      showAlert("No se pudo leer el archivo: la librería de Excel no cargó (sin conexión). Pega los datos manualmente en el cuadro de texto.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e)=>{
      const wb = XLSX.read(e.target.result, {type:"array"});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:false, blankrows:false});
      document.getElementById("imp-textarea").value = rows.map(r=>r.join("\t")).join("\n");
    };
    reader.readAsArrayBuffer(file);
  } else {
    const reader = new FileReader();
    reader.onload = (e)=>{ document.getElementById("imp-textarea").value = e.target.result; };
    reader.readAsText(file);
  }
}

function buildImportPreview(){
  const ent = currentImportEntidad();
  if (!ent){ showAlert("Selecciona una entidad para importar.", "error"); return; }
  const raw = document.getElementById("imp-textarea").value;
  let rows = parseImportText(raw);

  if (rows.length === 0){
    showAlert("No hay filas para procesar. Pega o sube los datos primero.", "error");
    return;
  }
  if (normalizeImportDate(rows[0][0]) === null) rows = rows.slice(1); // descarta fila de encabezado si la hay

  importPreviewRows = ent.tipo === "por_agenda" ? buildAgendaImportPreview(ent, rows) : buildSimpleImportPreview(ent, rows);
  renderImportPreview(ent);
}

function buildSimpleImportPreview(ent, rows){
  const aceptadosLote = [];
  const results = [];

  rows.forEach((cols, idx)=>{
    const fecha = normalizeImportDate(cols[0]);
    const inicio = normalizeImportTime(cols[1]);
    const fin = normalizeImportTime(cols[2]);

    if (!fecha || !inicio || !fin){
      results.push({idx, cols, status:"invalid", message:"Fecha u hora con formato inválido."});
      return;
    }

    const nuevo = { entidadId: ent.id, fecha, inicio, fin };
    if (ent.tipo === "por_hora") nuevo.sede = (cols[3]||"").trim();

    const check = validarTurno(nuevo, null, aceptadosLote);
    if (!check.ok){
      results.push({idx, cols, turno:nuevo, status:"conflict", message:check.motivo});
      return;
    }
    aceptadosLote.push(nuevo);
    results.push({idx, cols, turno:nuevo, status:"ok", message:"Se importará"});
  });
  return results;
}

// Agrupa filas con la misma Fecha+Inicio+Fin en un solo turno con varias
// líneas de remitente (uno por fila del grupo).
function buildAgendaImportPreview(ent, rows){
  const groups = new Map();
  const order = [];

  rows.forEach((cols, idx)=>{
    const fecha = normalizeImportDate(cols[0]);
    const inicio = normalizeImportTime(cols[1]);
    const fin = normalizeImportTime(cols[2]);
    const valid = !!(fecha && inicio && fin);
    const key = valid ? `${fecha}|${inicio}|${fin}` : `__invalid_${idx}`;

    if (!groups.has(key)){
      groups.set(key, { idx, fecha, inicio, fin, valid, items:[] });
      order.push(key);
    }
    const g = groups.get(key);
    if (!valid) return;

    const remNombre = (cols[3]||"").trim();
    const cantidad = Number(cols[4]) || 0;
    if (remNombre && cantidad > 0){
      // Si el mismo remitente aparece en varias filas del grupo, suma en vez de duplicar la línea.
      const existente = g.items.find(it => it.remNombre.toLowerCase() === remNombre.toLowerCase());
      if (existente) existente.cantidad += cantidad;
      else g.items.push({ remNombre, cantidad });
    }
  });

  const opciones = remitentesDeEntidad(ent.id);
  const aceptadosLote = [];
  const results = [];

  order.forEach(key=>{
    const g = groups.get(key);
    if (!g.valid){
      results.push({idx:g.idx, display:["","","","",""], status:"invalid", message:"Fecha u hora con formato inválido."});
      return;
    }

    const resuelto = [];
    const noEncontrados = [];
    for (const it of g.items){
      const match = opciones.find(r => r.nombre.toLowerCase() === it.remNombre.toLowerCase());
      if (match) resuelto.push({ remitenteId: match.id, nombre: match.nombre, tarifa: match.tarifa, cantidad: it.cantidad });
      else noEncontrados.push(it.remNombre);
    }
    const resumen = resuelto.map(d=>`${d.nombre} (${d.cantidad})`).join(", ") || "—";
    const display = [g.fecha, g.inicio, g.fin, resumen, ""];

    if (noEncontrados.length){
      results.push({idx:g.idx, display, status:"invalid",
        message:`Remitente no encontrado en ${ent.nombre}: ${noEncontrados.join(", ")}. Agrégalo primero en «Entidades y tarifas».`});
      return;
    }

    const nuevo = { entidadId: ent.id, fecha:g.fecha, inicio:g.inicio, fin:g.fin, detalle: resuelto };
    const check = validarTurno(nuevo, null, aceptadosLote);
    if (!check.ok){
      results.push({idx:g.idx, display, turno:nuevo, status:"conflict", message:check.motivo});
      return;
    }
    aceptadosLote.push(nuevo);
    results.push({idx:g.idx, display, turno:nuevo, status:"ok", message:"Se importará"});
  });

  return results;
}

function renderImportPreview(ent){
  const fmt = importFormatFor(ent);
  const okCount = importPreviewRows.filter(r=>r.status==="ok").length;
  const conflictCount = importPreviewRows.filter(r=>r.status==="conflict").length;
  const invalidCount = importPreviewRows.filter(r=>r.status==="invalid").length;

  const headCols = fmt.cols.map(c=>`<th>${c}</th>`).join("");
  const bodyRows = importPreviewRows.map(r=>{
    const values = r.display || fmt.cols.map((_,i)=> r.cols[i] ?? "");
    const cells = values.slice(0, fmt.cols.length).map(v=>`<td>${esc(v)}</td>`).join("");
    const badgeClass = r.status;
    const badgeText = r.status === "ok" ? "✓ Se importará" : r.status === "conflict" ? "⚠ Choque" : "✕ Inválido";
    return `<tr><td>${r.idx+1}</td>${cells}<td><span class="imp-status ${badgeClass}" title="${esc(r.message||"")}">${badgeText}</span></td></tr>`;
  }).join("");

  document.getElementById("imp-preview-table").innerHTML = `
    <thead><tr><th>#</th>${headCols}<th>Estado</th></tr></thead>
    <tbody>${bodyRows}</tbody>
  `;
  const wrap = document.getElementById("imp-preview-wrap");
  wrap.hidden = false;
  wrap.querySelector("h3").textContent =
    `Resultado: ${okCount} listos para importar · ${conflictCount} con choque · ${invalidCount} con formato inválido`;

  document.getElementById("btn-imp-confirm").disabled = okCount === 0;
}

async function commitImport(){
  const okRows = importPreviewRows.filter(r=>r.status === "ok");
  if (okRows.length === 0) return;
  try{
    const saved = await insertTurnosBulkDB(okRows.map(r=>r.turno));
    TURNOS.push(...saved);
    const skipped = importPreviewRows.length - okRows.length;
    showAlert(`Importación completa: ${saved.length} turno(s) agregado(s)${skipped ? `, ${skipped} omitido(s) por choque o formato` : ""}.`, "ok");
    renderAll();

    importPreviewRows = [];
    document.getElementById("imp-textarea").value = "";
    document.getElementById("imp-preview-wrap").hidden = true;
    document.getElementById("btn-imp-confirm").disabled = true;
    document.getElementById("dlg-import").close();
  }catch(e){
    showAlert("Error importando los turnos: " + e.message, "error");
  }
}

// ---------- Exportación cierre de mes ----------
function toCsv(){
  const month = document.getElementById("filter-month").value || new Date().toISOString().slice(0,7);
  const list = TURNOS.filter(t => t.fecha.slice(0,7) === month)
    .sort((a,b)=> turnoInterval(a).start - turnoInterval(b).start);
  const rows = [["Fecha","Entidad","Sede","Inicio","Fin","Horas","Detalle","Bruto","Seg. Social","Vacaciones","Cesantías","Retefuente","Neto"]];
  for (const t of list){
    const calc = calcularTurno(t);
    const ent = getEntidad(t.entidadId);
    const ded = calcDeducciones(calc.subtotal);
    rows.push([
      t.fecha, ent ? ent.nombre : "", t.sede||"", t.inicio, t.fin,
      fmtHours(calc.horas), calc.detalle,
      calc.subtotal ? Math.round(calc.subtotal) : "",
      calc.subtotal ? Math.round(ded.segSocial) : "",
      calc.subtotal ? Math.round(ded.vacaciones) : "",
      calc.subtotal ? Math.round(ded.cesantias) : "",
      calc.subtotal ? Math.round(ded.retefuente) : "",
      calc.subtotal ? Math.round(ded.neto) : "",
    ]);
  }
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
}

function downloadFile(filename, content, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadExcel(){
  if (typeof XLSX === "undefined"){
    showAlert("No se pudo cargar la librería de Excel (sin conexión a internet). Usa CSV mientras tanto.", "error");
    return;
  }
  const month = document.getElementById("filter-month").value || new Date().toISOString().slice(0,7);
  const list = TURNOS.filter(t => t.fecha.slice(0,7) === month)
    .sort((a,b)=> turnoInterval(a).start - turnoInterval(b).start);

  const rows = [["Fecha","Entidad","Sede","Inicio","Fin","Horas","Detalle","Bruto","Seg. Social","Vacaciones","Cesantías","Retefuente","Neto"]];
  for (const t of list){
    const calc = calcularTurno(t);
    const ent = getEntidad(t.entidadId);
    const ded = calcDeducciones(calc.subtotal);
    rows.push([
      t.fecha, ent ? ent.nombre : "", t.sede||"", t.inicio, t.fin, Number(fmtHours(calc.horas)), calc.detalle,
      Math.round(calc.subtotal || 0), Math.round(ded.segSocial), Math.round(ded.vacaciones),
      Math.round(ded.cesantias), Math.round(ded.retefuente), Math.round(ded.neto),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{wch:12},{wch:12},{wch:12},{wch:8},{wch:8},{wch:8},{wch:60},{wch:12},{wch:12},{wch:12},{wch:12},{wch:12},{wch:12}];
  for (let r = 1; r < rows.length; r++){
    for (const c of [7,8,9,10,11,12]){
      const cell = ws[XLSX.utils.encode_cell({r, c})];
      if (cell) cell.z = '"$"#,##0';
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Cierre ${month}`);
  XLSX.writeFile(wb, `cierre-mes-${month}.xlsx`, {cellStyles:true});
}

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", ()=>{
  if (!sb){
    showLoginAlert("No se pudo cargar el sistema de acceso (revisa tu conexión a internet) y vuelve a intentar recargando la página.", "error");
    document.getElementById("btn-login").disabled = true;
    return;
  }

  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document.getElementById("btn-logout").addEventListener("click", handleLogout);
  sb.auth.onAuthStateChange((event, session)=>{
    if (session) enterApp(); else showLoginScreen();
  });

  document.getElementById("f-entidad").addEventListener("change", ()=>{
    toggleFormFields();
    const ent = currentFormEntidad();
    if (ent && ent.tipo === "por_agenda") resetAgendaFormRows();
  });

  const dlgSettings = document.getElementById("dlg-settings");
  document.getElementById("btn-open-settings").addEventListener("click", ()=> dlgSettings.showModal());
  document.getElementById("btn-close-settings").addEventListener("click", ()=> dlgSettings.close());
  dlgSettings.addEventListener("click", (e)=>{ if (e.target === dlgSettings) dlgSettings.close(); });

  document.getElementById("btn-add-entidad").addEventListener("click", addEntidadMaestroRow);
  document.getElementById("btn-save-entidades").addEventListener("click", saveEntidadesMaestro);
  document.getElementById("entidades-rows").addEventListener("click", (e)=>{
    const btn = e.target.closest(".ent-row-remove");
    if (!btn) return;
    const tr = btn.closest("tr");
    const id = tr.dataset.id;
    if (id) handleDeleteEntidad(id);
    else tr.remove(); // fila nueva todavía no guardada: solo se quita del formulario
  });

  document.getElementById("rem-entidad-select").addEventListener("change", renderRemitentesMaestro);
  document.getElementById("btn-add-remitente").addEventListener("click", addRemitenteMaestroRow);
  document.getElementById("btn-save-remitentes").addEventListener("click", saveRemitentesMaestro);
  document.getElementById("btn-save-deducciones").addEventListener("click", handleSaveDeducciones);

  document.getElementById("btn-add-turno").addEventListener("click", handleAddTurno);
  document.getElementById("btn-cancel-edit").addEventListener("click", cancelEditTurno);
  document.getElementById("btn-agenda-add").addEventListener("click", addAgendaFormRow);
  document.getElementById("filter-month").addEventListener("change", renderAll);

  const dlgImport = document.getElementById("dlg-import");
  document.getElementById("btn-open-import").addEventListener("click", ()=>{
    updateImportFormatHint();
    dlgImport.showModal();
  });
  document.getElementById("btn-close-import").addEventListener("click", ()=> dlgImport.close());
  dlgImport.addEventListener("click", (e)=>{ if (e.target === dlgImport) dlgImport.close(); });
  document.getElementById("imp-entidad").addEventListener("change", ()=>{
    updateImportFormatHint();
    importPreviewRows = [];
    document.getElementById("imp-preview-wrap").hidden = true;
    document.getElementById("btn-imp-confirm").disabled = true;
  });
  document.getElementById("imp-file").addEventListener("change", (e)=>{
    if (e.target.files[0]) handleImportFile(e.target.files[0]);
  });
  document.getElementById("btn-imp-template").addEventListener("click", downloadImportTemplate);
  document.getElementById("btn-imp-preview").addEventListener("click", buildImportPreview);
  document.getElementById("btn-imp-confirm").addEventListener("click", commitImport);

  document.getElementById("cal-prev").addEventListener("click", ()=> shiftCalendarMonth(-1));
  document.getElementById("cal-next").addEventListener("click", ()=> shiftCalendarMonth(1));
  document.getElementById("cal-today").addEventListener("click", ()=>{
    calendarMonth = new Date().toISOString().slice(0,7);
    renderCalendar();
  });

  document.getElementById("btn-export-csv").addEventListener("click", ()=>{
    const month = document.getElementById("filter-month").value || new Date().toISOString().slice(0,7);
    downloadFile(`cierre-mes-${month}.csv`, toCsv(), "text/csv;charset=utf-8;");
  });
  document.getElementById("btn-export-xlsx").addEventListener("click", downloadExcel);
});

function renderImportEntidadOptions(){
  const sel = document.getElementById("imp-entidad");
  const cur = sel.value;
  const activas = ENTIDADES.filter(e=>e.activo).sort((a,b)=>a.orden-b.orden);
  sel.innerHTML = activas.map(e=>`<option value="${e.id}">${esc(e.nombre)}</option>`).join("");
  if (activas.some(e=>e.id===cur)) sel.value = cur;
}
