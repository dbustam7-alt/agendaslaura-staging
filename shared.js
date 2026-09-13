/* Agenda Laura — núcleo compartido: conexión Supabase, modelo de datos, validación
   de choques y cálculo de facturación. Lo usan tanto app.js (index.html) como
   cuenta-cobro.js (cuenta-cobro.html) para no duplicar la lógica de negocio —
   cualquier cambio aquí aplica igual en ambas páginas.
   Sistema unificado: toda entidad (CES/AUNA/NOEL y cualquiera que se agregue) es una
   fila de la tabla `entidades` con un `tipo` que define cómo se valida y se factura:
     - franja_fija: bloque semanal fijo de horas (ej. CES). No factura, solo controla choques.
     - por_hora:    tarifa por hora, ordinaria vs. nocturna vs. domingos/festivos (ej. AUNA).
                    El sábado se factura como día de semana normal (ordinaria de día,
                    nocturna en su franja) — NO lleva la tarifa de domingo/festivo.
     - por_agenda:  turnos variables facturados por remitente/paciente (ej. NOEL). */

const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const TIPO_LABEL = { franja_fija:"Por franja horaria", por_hora:"Por hora", por_agenda:"Por agenda" };
const TIPO_ICON = { franja_fija:"🟣", por_hora:"🔵", por_agenda:"🟠" };

let ENTIDADES = [];
let REMITENTES = [];
let TURNOS = [];
let PROYECTO_ACTUAL = null; // { id, nombre, rol } — el consultorio/proyecto activo en esta sesión

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

// ---------- Proyectos (consultorios): varias personas por proyecto, varios proyectos por persona ----------
// Cada persona puede pertenecer a más de un proyecto (ej. un contador con varios
// consultorios) — por eso, a diferencia de las demás tablas, TODAS las consultas de
// aquí en adelante filtran explícitamente por PROYECTO_ACTUAL.id: RLS solo garantiza
// "eres miembro de ese proyecto", no "es el que tienes activo ahora mismo".
const PROYECTO_STORAGE_KEY = "agendaLaura_proyectoId";
function getProyectoGuardado(){
  try{ return localStorage.getItem(PROYECTO_STORAGE_KEY); }catch(e){ return null; }
}
function setProyectoGuardado(id){
  try{ localStorage.setItem(PROYECTO_STORAGE_KEY, id); }catch(e){ /* localStorage no disponible: no es crítico */ }
}
function limpiarProyectoGuardado(){
  try{ localStorage.removeItem(PROYECTO_STORAGE_KEY); }catch(e){}
}
async function fetchMisProyectos(){
  // OJO: la policy de "miembros_proyecto" es "ver los del proyecto donde soy
  // miembro" (para poder ver a mis compañeros de equipo), no "ver solo mi propia
  // fila" — así que aquí SÍ hace falta filtrar por user_id explícitamente, o
  // devolvería también la fila de cada compañero en los proyectos compartidos.
  const { data: { user } } = await sb.auth.getUser();
  const { data, error } = await sb.from("miembros_proyecto").select("proyecto_id, rol, proyectos(nombre)").eq("user_id", user.id).order("created_at");
  if (error){ showAlert("Error cargando tus proyectos: " + error.message, "error"); return []; }
  return data.map(r => ({ id: r.proyecto_id, nombre: r.proyectos ? r.proyectos.nombre : "(proyecto eliminado)", rol: r.rol }));
}
async function crearProyecto(nombre){
  const { data, error } = await sb.rpc("crear_proyecto", { p_nombre: nombre });
  if (error) throw error;
  return data; // uuid del proyecto nuevo
}
async function redimirInvitacion(codigo){
  const { data, error } = await sb.rpc("redimir_invitacion", { p_codigo: codigo });
  if (error) throw error;
  return data; // uuid del proyecto al que quedó vinculada esta cuenta
}
async function generarInvitacion(proyectoId){
  const { data, error } = await sb.rpc("generar_invitacion", { p_proyecto_id: proyectoId });
  if (error) throw error;
  return data; // código para compartir
}
async function fetchMiembrosProyecto(proyectoId){
  const { data, error } = await sb.from("miembros_proyecto").select("*").eq("proyecto_id", proyectoId).order("created_at");
  if (error){ showAlert("Error cargando las personas del proyecto: " + error.message, "error"); return []; }
  return data.map(m => ({ userId: m.user_id, email: m.email, rol: m.rol }));
}
// Resuelve el proyecto activo de esta sesión: usa el guardado en localStorage si sigue
// siendo válido, o lo autoselecciona si la persona pertenece a un solo proyecto.
// `activo` queda null si hace falta que la persona elija/cree/se vincule a uno — el
// selector completo vive en index.html; las otras páginas remiten ahí en ese caso.
async function resolverProyectoActivo(){
  const proyectos = await fetchMisProyectos();
  const guardado = getProyectoGuardado();
  let elegido = guardado ? proyectos.find(p => p.id === guardado) : null;
  if (!elegido && proyectos.length === 1) elegido = proyectos[0];
  if (elegido){
    PROYECTO_ACTUAL = elegido;
    setProyectoGuardado(elegido.id);
  }
  return { activo: elegido || null, lista: proyectos };
}

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
// `deducciones` es una fila por PROYECTO (no por persona: todo el equipo comparte los
// mismos % de deducciones). Si es la primera vez que se usa este proyecto, todavía no
// tiene fila propia — se crea aquí mismo con los valores por defecto de la base de
// datos (que ya coinciden con DEFAULT_DEDUCCIONES).
async function fetchDeducciones(){
  const { data, error } = await sb.from("deducciones").select("*").eq("proyecto_id", PROYECTO_ACTUAL.id).maybeSingle();
  if (error){ showAlert("Error cargando deducciones: " + error.message, "error"); return {...DEFAULT_DEDUCCIONES}; }
  if (data) return rowToDeducciones(data);
  const { data: created, error: insErr } = await sb.from("deducciones").insert({ proyecto_id: PROYECTO_ACTUAL.id }).select().single();
  if (insErr){ showAlert("Error creando tus deducciones iniciales: " + insErr.message, "error"); return {...DEFAULT_DEDUCCIONES}; }
  return rowToDeducciones(created);
}
async function saveDeduccionesDB(){
  const { error } = await sb.from("deducciones").update(deduccionesToRow(DEDUCCIONES)).eq("proyecto_id", PROYECTO_ACTUAL.id);
  if (error) throw error;
}

// ---------- Cuentas de cobro: persistencia (historial, snapshot inmutable) ----------
// Usado por cuenta-cobro.js (generar/editar) y cierre-anual.js (solo lectura).
function rowToCuenta(row){
  const entidadIds = (row.entidad_ids && row.entidad_ids.length) ? row.entidad_ids : (row.entidad_id ? [row.entidad_id] : []);
  return {
    id: row.id, numero: row.numero, entidadIds,
    fechaEmision: row.fecha_emision, periodoDesde: row.periodo_desde, periodoHasta: row.periodo_hasta,
    prestadorSnapshot: row.prestador_snapshot, adquirenteSnapshot: row.adquirente_snapshot,
    lineas: row.lineas, total: Number(row.total), certificacionSnapshot: row.certificacion_snapshot,
    estado: row.estado || "pendiente", fechaPago: row.fecha_pago || null,
    deduccionesSnapshot: row.deducciones_snapshot || null,
    neto: row.neto != null ? Number(row.neto) : Number(row.total),
  };
}
async function fetchCuentasCobro(){
  const { data, error } = await sb.from("cuentas_cobro").select("*").eq("proyecto_id", PROYECTO_ACTUAL.id).order("numero", { ascending:false });
  if (error){ showAlert("Error cargando el historial: " + error.message, "error"); return []; }
  return data.map(rowToCuenta);
}
// `row.numero` NO se envía: el número consecutivo lo asigna un trigger de la base
// de datos (asignar_numero_cuenta_cobro), de forma atómica dentro de la misma
// transacción de insert — así dos personas generando una cuenta de cobro casi al
// mismo tiempo nunca pueden terminar con el mismo número. Se devuelve la fila
// insertada completa para que el llamador sepa qué número le tocó.
async function insertCuentaCobroDB(row){
  const { numero, ...resto } = row;
  const { data, error } = await sb.from("cuentas_cobro").insert({ ...resto, proyecto_id: PROYECTO_ACTUAL.id }).select().single();
  if (error) throw error;
  return rowToCuenta(data);
}
async function deleteCuentaCobroDB(id){
  const { error } = await sb.from("cuentas_cobro").delete().eq("id", id);
  if (error) throw error;
}
async function updateEstadoCuentaDB(id, estado, fechaPago){
  const { error } = await sb.from("cuentas_cobro").update({ estado, fecha_pago: fechaPago }).eq("id", id);
  if (error) throw error;
}

// ---------- Entidades ----------
function rowToEntidad(row){
  return { id: row.id, nombre: row.nombre, tipo: row.tipo, color: row.color, config: row.config || {}, orden: row.orden, activo: row.activo };
}
async function fetchEntidades(){
  const { data, error } = await sb.from("entidades").select("*").eq("proyecto_id", PROYECTO_ACTUAL.id).order("orden");
  if (error){ showAlert("Error cargando entidades: " + error.message, "error"); return []; }
  return data.map(rowToEntidad);
}
// Guarda TODAS las filas del formulario en una sola operación (upsert masivo) en
// vez de un insert/update por fila: si la conexión se cae a mitad de guardar
// varias entidades, con un for-loop podían quedar unas guardadas y otras no — y
// como el formulario no se enteraba de cuáles sí alcanzaron a insertarse, un
// reintento podía duplicarlas. Un solo upsert es atómico: se guardan todas o
// ninguna. `rows` ya trae el `tipo` correcto por fila (el llamador se encarga de
// no dejarlo cambiar en filas existentes).
async function upsertEntidadesDB(rows){
  const payload = rows.map(r => ({ ...r, proyecto_id: PROYECTO_ACTUAL.id }));
  const { error } = await sb.from("entidades").upsert(payload);
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

// ---------- Suscripción (plan de pago) ----------
// El bloqueo REAL de escritura cuando vence ya lo hace Postgres a nivel de RLS (ver
// suscripcion_activa() en la base) — nunca solo en pantalla. Esto de aquí es solo
// para AVISAR con tiempo y para traducir el error crudo de RLS a un mensaje claro;
// la lectura de datos ya guardados NUNCA se bloquea, esté vencida o no.
let SUSCRIPCION = null; // { estado, venceEl, plan } del proyecto activo, o null si no cargó
async function fetchSuscripcion(){
  const { data, error } = await sb.from("suscripciones").select("*").eq("proyecto_id", PROYECTO_ACTUAL.id).maybeSingle();
  if (error || !data){ SUSCRIPCION = null; return null; }
  SUSCRIPCION = { estado: data.estado, venceEl: data.vence_el, plan: data.plan };
  return SUSCRIPCION;
}
function diasParaVencer(venceEl){
  if (!venceEl) return null;
  return Math.ceil((new Date(venceEl).getTime() - Date.now()) / 86400000);
}
// Código/mensaje típico de PostgREST cuando una escritura choca contra una policy
// de Row Level Security (código 42501). Puede deberse a otras causas, pero en la
// práctica, una vez pasado el login y la elección de proyecto, casi siempre es la
// suscripción vencida — por eso mensajeSiSuscripcionVencida() da ese diagnóstico.
function isRlsBlockedError(e){
  return !!e && (e.code === "42501" || /row-level security|permission denied for/i.test(e.message || ""));
}
function mensajeSiSuscripcionVencida(e){
  if (!isRlsBlockedError(e)) return null;
  return "No se pudo guardar: el período de prueba/plan de este proyecto está vencido. Lo ya guardado se sigue viendo con normalidad — contáctanos para renovar y volver a registrar o editar información.";
}
// Aviso en el encabezado de cada página (index/cuenta-cobro/cierre-anual) — requiere
// un <div id="suscripcion-banner" class="alert" hidden></div> en el HTML. Silencioso
// si el plan está en orden; solo avisa si falta poco para vencer o si ya venció.
function renderSuscripcionBanner(){
  const box = document.getElementById("suscripcion-banner");
  if (!box) return;
  if (!SUSCRIPCION){ box.hidden = true; return; }
  const dias = diasParaVencer(SUSCRIPCION.venceEl);
  const vencida = SUSCRIPCION.estado === "vencida" || SUSCRIPCION.estado === "cancelada" || (dias !== null && dias <= 0);
  if (vencida){
    box.hidden = false;
    box.className = "alert error";
    box.textContent = "⛔ El período de prueba/plan de este proyecto venció: ya no se puede registrar ni editar información nueva. Lo ya guardado se sigue viendo con normalidad — contáctanos para renovar.";
    return;
  }
  if (SUSCRIPCION.estado === "prueba" && dias !== null && dias <= 7){
    box.hidden = false;
    box.className = "alert warning";
    box.textContent = `🕒 El período de prueba de este proyecto vence en ${dias} día${dias===1?"":"s"}. Después de esa fecha no se podrá registrar ni editar información nueva (lo ya guardado se sigue viendo).`;
    return;
  }
  box.hidden = true;
}

// ---------- Consentimiento legal (Habeas Data — Ley 1581 de 2012) ----------
// Registro de que la persona aceptó explícitamente la política de tratamiento de
// datos y los términos de uso (ver legal.html). Es POR CUENTA (auth.users), no por
// proyecto: da igual a cuántos consultorios pertenezca, solo debe aceptar una vez
// por versión vigente. Sube LEGAL_VERSION cuando cambie el texto de legal.html para
// forzar una nueva aceptación en el próximo inicio de sesión de todo el mundo.
const LEGAL_VERSION = "2026-09-07";
async function tieneConsentimientoVigente(){
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return false;
  const { data, error } = await sb.from("consentimientos_legales").select("id").eq("user_id", user.id).eq("version", LEGAL_VERSION).maybeSingle();
  // Si falla la consulta (ej. sin conexión momentánea) no bloqueamos por eso — no es
  // este el mecanismo de bloqueo real de datos, solo el de pedir la aceptación.
  if (error) return true;
  return !!data;
}
async function registrarConsentimiento(){
  const { data: { user } } = await sb.auth.getUser();
  const { error } = await sb.from("consentimientos_legales").insert({ user_id: user.id, version: LEGAL_VERSION });
  if (error) throw error;
}

// ---------- Auditoría: quién hizo qué cambio y cuándo ----------
// Solo lectura desde el cliente — la única forma de escribir en `auditoria` es el
// trigger de la base de datos (fn_auditoria) sobre cada tabla operativa, nunca la
// app. Por eso no hay ninguna función de "insertar auditoría" aquí: ese camino no
// existe, ni siquiera para nosotros.
const AUDITORIA_TABLA_LABEL = {
  entidades:'Entidad', remitentes:'Remitente', turnos:'Turno', turno_detalle:'Detalle de turno',
  deducciones:'Deducciones', prestador:'Tus datos (prestador)', entidad_facturacion:'Datos de facturación',
  cuentas_cobro:'Cuenta de cobro',
};
const AUDITORIA_OPERACION_LABEL = { INSERT:'Creó', UPDATE:'Editó', DELETE:'Eliminó' };
async function fetchAuditoria(limite){
  const { data, error } = await sb.from("auditoria").select("*").eq("proyecto_id", PROYECTO_ACTUAL.id).order("creado_el", { ascending:false }).limit(limite || 100);
  if (error){ showAlert("Error cargando el historial de cambios: " + error.message, "error"); return []; }
  return data;
}
// Un detalle corto e identificable del registro afectado, según la tabla — solo
// para que el historial sea legible de un vistazo, no un resumen exhaustivo.
function resumenAuditoria(row){
  const d = row.datos_nuevos || row.datos_anteriores || {};
  switch (row.tabla){
    case 'entidades': return d.nombre || '';
    case 'remitentes': return d.nombre || '';
    case 'turnos': return d.fecha ? `${d.fecha} ${(d.inicio||'').slice(0,5)}–${(d.fin||'').slice(0,5)}` : '';
    case 'cuentas_cobro': return d.numero != null ? `N° ${String(d.numero).padStart(3,'0')}` : '';
    case 'prestador': return d.nombre || '';
    case 'entidad_facturacion': return d.razon_social || '';
    case 'turno_detalle': return d.nombre_paciente || '';
    default: return '';
  }
}

// ---------- Remitentes (entidades tipo "por_agenda": EPS, aseguradoras, Particular, Póliza...) ----------
async function fetchRemitentes(){
  const { data, error } = await sb.from("remitentes").select("*").eq("proyecto_id", PROYECTO_ACTUAL.id).eq("activo", true).order("orden");
  if (error){ showAlert("Error cargando remitentes: " + error.message, "error"); return []; }
  return data.map(r => ({ id: r.id, nombre: r.nombre, tarifa: Number(r.tarifa), orden: r.orden, entidadId: r.entidad_id }));
}
// Mismo motivo que upsertEntidadesDB: un solo upsert atómico en vez de un
// insert/update por fila, para no arriesgar guardados parciales ni duplicados en
// un reintento tras un error de red a mitad del guardado.
async function upsertRemitentesDB(rows){
  const payload = rows.map(r => ({ ...r, proyecto_id: PROYECTO_ACTUAL.id }));
  const { error } = await sb.from("remitentes").upsert(payload);
  if (error) throw error;
}

// ---------- Turnos ----------
const TURNO_SELECT = "*, turno_detalle(cantidad, remitente_id, nombre_paciente, valor, remitentes(nombre, tarifa))";

function rowToTurno(row){
  const detalle = (row.turno_detalle || [])
    .filter(d => d.cantidad > 0)
    .map(d => ({
      remitenteId: d.remitente_id,
      nombre: d.remitentes ? d.remitentes.nombre : "(remitente eliminado)",
      // El valor propio de esta línea manda (se captura por paciente, editable); si es
      // una línea de antes de pedir nombre de paciente (valor=NULL), usa la tarifa
      // vigente del remitente, como siempre se hizo.
      tarifa: d.valor != null ? Number(d.valor) : (d.remitentes ? Number(d.remitentes.tarifa) : 0),
      cantidad: d.cantidad,
      nombrePaciente: d.nombre_paciente || null,
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
    proyecto_id: PROYECTO_ACTUAL.id,
  };
}
// Arma el detalle de un turno como jsonb para las RPC atómicas de abajo.
function detalleToJsonb(detalle){
  return (detalle || []).filter(d => d.cantidad > 0 && d.remitenteId).map(d => ({
    remitente_id: d.remitenteId, cantidad: d.cantidad,
    nombre_paciente: d.nombrePaciente || null,
    valor: d.tarifa != null ? d.tarifa : null,
  }));
}
async function fetchTurnos(){
  const { data, error } = await sb.from("turnos").select(TURNO_SELECT).eq("proyecto_id", PROYECTO_ACTUAL.id).order("fecha").order("inicio");
  if (error){ showAlert("Error cargando turnos: " + error.message, "error"); return []; }
  return data.map(rowToTurno);
}
// Encabezado + detalle se crean en UNA sola transacción de Postgres (RPC
// crear_turno_con_detalle) — antes eran 2 llamadas HTTP separadas: si la
// conexión fallaba justo entre insertar el turno y guardar su detalle, quedaba
// un turno "huérfano" sin sus pacientes/remitentes.
async function insertTurnoDB(t){
  const { data: id, error } = await sb.rpc("crear_turno_con_detalle", {
    p_proyecto_id: PROYECTO_ACTUAL.id, p_entidad_id: t.entidadId, p_fecha: t.fecha,
    p_inicio: t.inicio, p_fin: t.fin, p_sede: t.sede || null,
    p_detalle: detalleToJsonb(t.detalle),
  });
  if (error) throw error;
  const { data: full, error: err2 } = await sb.from("turnos").select(TURNO_SELECT).eq("id", id).single();
  if (err2) throw err2;
  return rowToTurno(full);
}
// Todo el lote (encabezados + detalle de cada turno) se crea en UNA sola
// transacción (RPC importar_turnos_lote) — antes eran 2+ llamadas HTTP (un
// insert de encabezados + un insert de detalle por cada turno del lote), así
// que una falla de red a mitad de la importación podía dejar turnos ya creados
// sin su detalle. Con la RPC, o se guarda el lote completo, o ninguno.
async function insertTurnosBulkDB(list){
  const payload = list.map(t => ({
    entidad_id: t.entidadId, fecha: t.fecha, inicio: t.inicio, fin: t.fin, sede: t.sede || null,
    detalle: detalleToJsonb(t.detalle),
  }));
  const { data, error } = await sb.rpc("importar_turnos_lote", { p_proyecto_id: PROYECTO_ACTUAL.id, p_turnos: payload });
  if (error) throw error;
  const ids = data.map(r => r.id);
  const { data: full, error: err2 } = await sb.from("turnos").select(TURNO_SELECT).in("id", ids);
  if (err2) throw err2;
  return full.map(rowToTurno);
}
// Igual que insertTurnoDB: actualizar el encabezado y reemplazar el detalle
// (borrar lo anterior + insertar lo nuevo) corre como UNA sola transacción
// (RPC actualizar_turno_con_detalle) — antes, si la conexión fallaba justo
// entre el DELETE y el INSERT, el turno se quedaba SIN NINGÚN detalle (pérdida
// real de datos ya guardados, no solo un guardado incompleto).
async function updateTurnoDB(id, t){
  const { error } = await sb.rpc("actualizar_turno_con_detalle", {
    p_turno_id: id, p_entidad_id: t.entidadId, p_fecha: t.fecha,
    p_inicio: t.inicio, p_fin: t.fin, p_sede: t.sede || null,
    p_detalle: detalleToJsonb(t.detalle),
  });
  if (error) throw error;
  const { data: full, error: err2 } = await sb.from("turnos").select(TURNO_SELECT).eq("id", id).single();
  if (err2) throw err2;
  return rowToTurno(full);
}
async function deleteTurnoDB(id){
  const { error } = await sb.from("turnos").delete().eq("id", id);
  if (error) throw error;
}

// ---------- Helpers de fecha/hora ----------
// `new Date().toISOString().slice(0,10)` da la fecha en UTC, no la del usuario —
// en Colombia (UTC-5), desde las 7pm hora local eso ya cae en el DÍA SIGUIENTE en
// UTC, así que "hoy" quedaría mal (ej. registrar un turno nocturno a las 8pm
// precargaría la fecha de mañana). Esta función arma el ISO con los componentes
// LOCALES del Date (getFullYear/getMonth/getDate), nunca con UTC.
function getLocalDateISO(d){
  d = d || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
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
function minutesOfDay(d){ return d.getHours()*60 + d.getMinutes(); }

// ---------- Festivos colombianos (Ley 51 de 1983 / Ley 1983 de 2005 "Emiliani") ----------
// Domingo de resurrección (algoritmo gregoriano anónimo) — de ahí se derivan Jueves/Viernes
// Santo (fijos, no se trasladan) y Ascensión/Corpus Christi/Sagrado Corazón (sí se trasladan).
function domingoPascua(year){
  const a = year % 19, b = Math.floor(year/100), c = year % 100;
  const d = Math.floor(b/4), e = b % 4, f = Math.floor((b+8)/25);
  const g = Math.floor((b-f+1)/3), h = (19*a+b-d-g+15)%30;
  const i = Math.floor(c/4), k = c%4, l = (32+2*e+2*i-h-k)%7;
  const m = Math.floor((a+11*h+22*l)/451);
  const mes = Math.floor((h+l-7*m+114)/31); // 3=marzo, 4=abril
  const dia = ((h+l-7*m+114)%31)+1;
  return new Date(year, mes-1, dia);
}
function sumarDias(d, n){ const r = new Date(d); r.setDate(r.getDate()+n); return r; }
// Ley Emiliani: si el festivo no cae en lunes, se traslada al lunes siguiente (si ya
// cae en lunes, se queda igual — la fórmula da +0 días en ese caso).
function trasladarALunes(d){ return sumarDias(d, (8 - d.getDay()) % 7); }
const _festivosCache = {};
function festivosColombia(year){
  if (_festivosCache[year]) return _festivosCache[year];
  const pascua = domingoPascua(year);
  const fijos = [
    new Date(year,0,1),    // Año nuevo
    new Date(year,4,1),    // Día del trabajo
    new Date(year,6,20),   // Independencia
    new Date(year,7,7),    // Batalla de Boyacá
    new Date(year,11,8),   // Inmaculada Concepción
    new Date(year,11,25),  // Navidad
    sumarDias(pascua,-3),  // Jueves Santo
    sumarDias(pascua,-2),  // Viernes Santo
  ];
  const trasladables = [
    new Date(year,0,6),    // Reyes Magos
    new Date(year,2,19),   // San José
    sumarDias(pascua,39),  // Ascensión del Señor
    sumarDias(pascua,60),  // Corpus Christi
    sumarDias(pascua,68),  // Sagrado Corazón
    new Date(year,5,29),   // San Pedro y San Pablo
    new Date(year,7,15),   // Asunción de la Virgen
    new Date(year,9,12),   // Día de la Raza
    new Date(year,10,1),   // Todos los Santos
    new Date(year,10,11),  // Independencia de Cartagena
  ].map(trasladarALunes);
  const set = new Set([...fijos, ...trasladables].map(d=> getLocalDateISO(d)));
  _festivosCache[year] = set;
  return set;
}
function isFestivoColombia(d){
  const iso = getLocalDateISO(d);
  return festivosColombia(Number(iso.slice(0,4))).has(iso);
}
// Domingo o festivo colombiano: tarifa especial las 24 horas de ese día. El sábado
// NO entra aquí — se factura como día de semana normal (ver computeHourlyBilling).
function isDomingoOFestivo(d){
  return d.getDay() === 0 || isFestivoColombia(d);
}
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
    const iso = getLocalDateISO(d);
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
      // Si el bloque fijo tiene marcado "permite cruce", no bloquea turnos de otras
      // entidades (ej. CES puede convivir con NOEL o AUNA a la misma hora).
      if (b.entidad.config.permiteCruce) continue;
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
  const tarifaDomFest = Number(cfg.tarifaDomFest || 0);

  function isInNocturno(d){
    const [sh,sm] = noctInicio.split(":").map(Number);
    const [eh,em] = noctFin.split(":").map(Number);
    const startMin = sh*60+sm, endMin = eh*60+em;
    const cur = minutesOfDay(d);
    if (startMin > endMin) return cur >= startMin || cur < endMin; // cruza medianoche
    return cur >= startMin && cur < endMin;
  }
  // Domingo/festivo: tarifa especial las 24 horas de ese día (no importa si es de día o de
  // noche). El sábado ya NO es un caso especial: de día es ordinario, de noche es nocturno,
  // igual que cualquier otro día de semana.
  function categoriaEnInstante(d){
    if (isDomingoOFestivo(d)) return "domFest";
    if (isInNocturno(d)) return "noc";
    return "ord";
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
  let ordMin=0, nocMin=0, domFestMin=0, subtotal=0;
  for (let i=0;i<sorted.length-1;i++){
    const a=sorted[i], b=sorted[i+1];
    if (b<=a) continue;
    const mid = new Date((a+b)/2);
    const cat = categoriaEnInstante(mid);
    const rate = cat === "domFest" ? tarifaDomFest : cat === "noc" ? tarifaNoc : tarifaOrd;
    const minutes = (b-a)/60000;
    if (cat === "domFest") domFestMin += minutes;
    else if (cat === "noc") nocMin += minutes;
    else ordMin += minutes;
    subtotal += (minutes/60) * rate;
  }
  return { ordMin, nocMin, domFestMin, subtotal };
}

// ---------- Cálculo genérico por turno, según el tipo de su entidad ----------
function calcularTurno(t){
  const {start, end} = turnoInterval(t);
  const horas = (end - start) / 3600000;
  const ent = getEntidad(t.entidadId);
  if (!ent) return { horas, subtotal:0, detalle:"(entidad eliminada)" };

  if (ent.tipo === "por_hora"){
    const b = computeHourlyBilling(start, end, ent.config);
    const detalle = `${t.sede || ""} · ord ${fmtHours(b.ordMin/60)}h / noc ${fmtHours(b.nocMin/60)}h / dom-fest ${fmtHours(b.domFestMin/60)}h`;
    return { horas, subtotal: b.subtotal, detalle, ordMin: b.ordMin, nocMin: b.nocMin, domFestMin: b.domFestMin };
  }
  if (ent.tipo === "por_agenda"){
    const detalleLista = t.detalle || [];
    const total = detalleLista.reduce((s,d)=> s + d.cantidad, 0);
    const subtotal = detalleLista.reduce((s,d)=> s + d.cantidad*d.tarifa, 0);
    const resumen = detalleLista.length
      ? detalleLista.map(d => d.nombrePaciente ? `${d.nombrePaciente} (${d.nombre}, ${fmtMoney(d.tarifa)})` : `${d.nombre} (${d.cantidad})`).join(", ")
      : "—";
    return { horas, subtotal, detalle: `${total} pac./visitas: ${resumen}`, detalleLista, total };
  }
  // franja_fija
  return { horas, subtotal: 0, detalle: "Registro horas contrato" };
}
