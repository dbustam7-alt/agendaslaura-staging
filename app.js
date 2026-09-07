/* Agenda Laura — pantalla principal (index.html): login, UI del formulario de
   turnos, calendario, resumen financiero, maestros (entidades/remitentes/
   deducciones), importador masivo y exportación. La conexión a Supabase, el
   modelo de datos y el cálculo de facturación/validación viven en shared.js
   (compartido también por cuenta-cobro.js) — este archivo se carga después. */

let editingTurnoId = null; // id del turno que se está editando en "Registrar turno", o null si es uno nuevo

// ---------- Autenticación ----------
function showLoginAlert(msg, type){
  const box = document.getElementById("login-alert");
  box.hidden = false;
  box.className = "alert " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
}
function showLoginScreen(){
  document.getElementById("app-root").hidden = true;
  document.getElementById("proyecto-screen").hidden = true;
  document.getElementById("login-screen").hidden = false;
  document.getElementById("login-password").value = "";
  showLoginForm(); // al volver a la pantalla de acceso (ej. tras salir), siempre arranca en login, no en registro
}
function showLoginForm(){
  document.getElementById("signup-form").hidden = true;
  document.getElementById("login-form").hidden = false;
}
function showSignupForm(){
  document.getElementById("login-form").hidden = true;
  document.getElementById("signup-form").hidden = false;
}
function showSignupAlert(msg, type){
  const box = document.getElementById("signup-alert");
  box.hidden = false;
  box.className = "alert " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
}
// ---------- Proyecto (consultorio): elegir, crear, vincularse ----------
function showProyectoScreen(){
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app-root").hidden = true;
  document.getElementById("proyecto-screen").hidden = false;
  mostrarOpcionesProyecto();
}
function showProyectoAlert(msg, type){
  const box = document.getElementById("proyecto-alert");
  box.hidden = false;
  box.className = "alert " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
}
function mostrarOpcionesProyecto(){
  document.getElementById("proyecto-opciones").hidden = false;
  document.getElementById("form-crear-proyecto").hidden = true;
  document.getElementById("form-vincular-proyecto").hidden = true;
}
function mostrarFormCrearProyecto(){
  document.getElementById("proyecto-opciones").hidden = true;
  document.getElementById("form-crear-proyecto").hidden = false;
  document.getElementById("form-vincular-proyecto").hidden = true;
}
function mostrarFormVincularProyecto(){
  document.getElementById("proyecto-opciones").hidden = true;
  document.getElementById("form-crear-proyecto").hidden = true;
  document.getElementById("form-vincular-proyecto").hidden = false;
}
function renderProyectoLista(lista){
  const wrap = document.getElementById("proyecto-lista-wrap");
  const cont = document.getElementById("proyecto-lista");
  if (!lista.length){ wrap.hidden = true; cont.innerHTML = ""; return; }
  wrap.hidden = false;
  cont.innerHTML = lista.map(p => `
    <button type="button" class="proyecto-item" data-proyecto="${p.id}">
      <span>${esc(p.nombre)}</span>
      <span class="proyecto-rol">${esc(p.rol)}</span>
    </button>
  `).join("");
  cont.querySelectorAll("[data-proyecto]").forEach(btn=>{
    btn.addEventListener("click", ()=> entrarAProyecto(lista.find(p=>p.id===btn.dataset.proyecto)));
  });
}
async function entrarAProyecto(proyecto){
  PROYECTO_ACTUAL = proyecto;
  setProyectoGuardado(proyecto.id);
  document.getElementById("proyecto-screen").hidden = true;
  await enterApp();
}
// Punto de entrada tras confirmar sesión: resuelve el proyecto activo solo (si ya
// tiene uno guardado o pertenece a exactamente uno) o pide elegir/crear/vincularse.
async function handleAuthenticated(){
  document.getElementById("login-screen").hidden = true;
  const { activo, lista } = await resolverProyectoActivo();
  if (activo){
    document.getElementById("proyecto-screen").hidden = true;
    await enterApp();
    return;
  }
  showProyectoScreen();
  renderProyectoLista(lista);
}
async function handleCrearProyecto(e){
  e.preventDefault();
  const nombre = document.getElementById("nuevo-proyecto-nombre").value.trim();
  if (!nombre) return;
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try{
    const id = await crearProyecto(nombre);
    await entrarAProyecto({ id, nombre, rol: "dueño" });
  }catch(err){
    showProyectoAlert("Error creando el proyecto: " + err.message, "error");
  }finally{
    btn.disabled = false;
  }
}
async function handleVincularProyecto(e){
  e.preventDefault();
  const codigo = document.getElementById("codigo-invitacion").value.trim();
  if (!codigo) return;
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try{
    const proyectoId = await redimirInvitacion(codigo);
    const lista = await fetchMisProyectos();
    const proyecto = lista.find(p=>p.id===proyectoId) || { id: proyectoId, nombre: "Proyecto vinculado", rol: "miembro" };
    await entrarAProyecto(proyecto);
  }catch(err){
    showProyectoAlert("No se pudo vincular: " + err.message, "error");
  }finally{
    btn.disabled = false;
  }
}
function handleCambiarProyecto(){
  document.getElementById("app-root").hidden = true;
  showProyectoScreen();
  fetchMisProyectos().then(renderProyectoLista);
}

// ---------- Personas con acceso al proyecto ----------
async function renderMiembros(){
  const miembros = await fetchMiembrosProyecto(PROYECTO_ACTUAL.id);
  document.getElementById("miembros-rows").innerHTML = miembros.map(m=>`
    <tr><td>${esc(m.email)}</td><td style="text-transform:capitalize;">${esc(m.rol)}</td></tr>
  `).join("");
  document.getElementById("invitacion-wrap").hidden = false;
  document.getElementById("invitacion-codigo").hidden = true;
  document.getElementById("invitacion-hint").textContent = "";
}
async function handleGenerarInvitacion(){
  try{
    const codigo = await generarInvitacion(PROYECTO_ACTUAL.id);
    const span = document.getElementById("invitacion-codigo");
    span.hidden = false;
    span.textContent = codigo;
    document.getElementById("invitacion-hint").textContent = "Comparte este código con quien quieras invitar — lo ingresa en «Vincularme con un código» al crear su cuenta. Se puede usar una sola vez.";
  }catch(err){
    showAlert("Error generando la invitación: " + err.message, "error");
  }
}

async function enterApp(){
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app-root").hidden = false;
  document.getElementById("app-title").textContent = PROYECTO_ACTUAL.nombre;

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
  PROYECTO_ACTUAL = null;
  limpiarProyectoGuardado(); // así la próxima persona que use este navegador no hereda el proyecto de la anterior
}
// El registro crea una cuenta de Supabase Auth nueva; el aislamiento de datos por
// dueño (RLS + user_id) ya está en la base — con solo iniciar sesión, esa persona
// arranca con su propia agenda vacía (shared.js/cuenta-cobro.js crean su fila de
// `prestador`/`deducciones` solas la primera vez que las necesitan).
async function handleSignup(e){
  e.preventDefault();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;
  const passwordConfirm = document.getElementById("signup-password-confirm").value;
  if (password !== passwordConfirm){
    showSignupAlert("Las contraseñas no coinciden.", "error");
    return;
  }
  if (password.length < 6){
    showSignupAlert("La contraseña debe tener al menos 6 caracteres.", "error");
    return;
  }
  const btn = document.getElementById("btn-signup");
  btn.disabled = true;
  const { data, error } = await sb.auth.signUp({ email, password });
  btn.disabled = false;
  if (error){
    showSignupAlert("No se pudo crear la cuenta: " + error.message, "error");
    return;
  }
  if (data.session){
    // Confirmación de correo desactivada en este proyecto: ya queda con sesión
    // iniciada — onAuthStateChange se encarga de entrar a la app.
    return;
  }
  // Confirmación de correo activada: todavía no hay sesión hasta que confirme.
  document.getElementById("signup-form").reset();
  showSignupAlert("Cuenta creada. Revisa tu correo y confirma tu cuenta para poder iniciar sesión.", "ok");
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
      <td style="white-space:nowrap;">
        <button class="btn secondary btn-sm" data-edit="${t.id}">Editar</button>
        <button class="btn danger-link" data-del="${t.id}">Eliminar</button>
      </td>
      <td>${t.fecha}</td>
      <td>${DIAS[d.getDay()]}</td>
      <td><span class="badge" style="--badge-color:${color}">${esc(nombre)}</span></td>
      <td>${t.inicio}</td>
      <td>${t.fin}</td>
      <td>${fmtHours(calc.horas)}</td>
      <td>${calc.subtotal ? fmtMoney(calc.subtotal) : "—"}</td>
      <td>${esc(calc.detalle)}</td>
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

// ---------- Filas dinámicas de pacientes (entidades "por agenda") ----------
// Cada fila es un paciente: remitente (EPS/aseguradora/etc.), su nombre, y un valor
// que se precarga con la tarifa del remitente pero se puede editar — el precio real
// puede variar de un paciente a otro aunque compartan remitente.
function addAgendaFormRow(){
  const ent = currentFormEntidad();
  const opciones = ent ? remitentesDeEntidad(ent.id) : [];
  const wrap = document.getElementById("f-agenda-rows");
  const row = document.createElement("div");
  row.className = "eps-row";
  row.innerHTML = `
    <input type="text" class="f-agenda-nombre-paciente" placeholder="Nombre del paciente">
    <select class="f-agenda-remitente">${opciones.map(r=>`<option value="${r.id}" data-tarifa="${r.tarifa}">${esc(r.nombre)}</option>`).join("")}</select>
    <input type="number" class="f-agenda-valor" min="0" step="1000" placeholder="Valor">
    <button type="button" class="btn ghost-icon eps-row-remove" aria-label="Quitar paciente">✕</button>
  `;
  const selRem = row.querySelector(".f-agenda-remitente");
  const inpValor = row.querySelector(".f-agenda-valor");
  function aplicarValorPorDefecto(){
    const opt = selRem.options[selRem.selectedIndex];
    inpValor.value = opt ? opt.dataset.tarifa : 0;
  }
  aplicarValorPorDefecto(); // trae el valor por defecto del remitente ya seleccionado
  selRem.addEventListener("change", aplicarValorPorDefecto); // al cambiar de remitente, sugiere su valor (se puede volver a editar)
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
    const nombrePaciente = row.querySelector(".f-agenda-nombre-paciente").value.trim();
    const valor = Number(row.querySelector(".f-agenda-valor").value || 0);
    const cantidadLegado = Number(row.dataset.legacyCantidad || 0);
    const rem = REMITENTES.find(r=>r.id === remitenteId);
    if (nombrePaciente){
      return { remitenteId, nombre: rem ? rem.nombre : "", tarifa: valor, cantidad: 1, nombrePaciente };
    }
    if (cantidadLegado > 0){
      // Fila de un turno registrado antes de pedir nombre de paciente: se conserva
      // agrupada por remitente tal cual estaba, sin inventar un nombre que no existe.
      return { remitenteId, nombre: rem ? rem.nombre : "", tarifa: valor, cantidad: cantidadLegado, nombrePaciente: null };
    }
    return null; // fila vacía sin usar (ej. el turno se registra sin detalle todavía)
  }).filter(Boolean);
}
function renderAgendaFormOptions(){
  const ent = currentFormEntidad();
  const opciones = ent ? remitentesDeEntidad(ent.id) : [];
  document.querySelectorAll(".f-agenda-remitente").forEach(sel=>{
    const cur = sel.value;
    sel.innerHTML = opciones.map(r=>`<option value="${r.id}" data-tarifa="${r.tarifa}">${esc(r.nombre)}</option>`).join("");
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
        row.querySelector(".f-agenda-valor").value = d.tarifa;
        if (d.nombrePaciente){
          row.querySelector(".f-agenda-nombre-paciente").value = d.nombrePaciente;
        } else {
          // Fila de antes de pedir nombre de paciente: se conserva su cantidad agrupada
          // (oculta) para no perderla si el usuario guarda sin tocar el detalle.
          row.dataset.legacyCantidad = d.cantidad;
        }
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
    document.getElementById("btn-signup").disabled = true;
    return;
  }

  document.getElementById("login-form").addEventListener("submit", handleLogin);
  document.getElementById("signup-form").addEventListener("submit", handleSignup);
  document.getElementById("link-show-signup").addEventListener("click", (e)=>{ e.preventDefault(); showSignupForm(); });
  document.getElementById("link-show-login").addEventListener("click", (e)=>{ e.preventDefault(); showLoginForm(); });
  document.getElementById("btn-logout").addEventListener("click", handleLogout);
  sb.auth.onAuthStateChange((event, session)=>{
    if (session) handleAuthenticated(); else showLoginScreen();
  });

  document.getElementById("form-crear-proyecto").addEventListener("submit", handleCrearProyecto);
  document.getElementById("form-vincular-proyecto").addEventListener("submit", handleVincularProyecto);
  document.getElementById("btn-mostrar-crear-proyecto").addEventListener("click", mostrarFormCrearProyecto);
  document.getElementById("btn-mostrar-vincular-proyecto").addEventListener("click", mostrarFormVincularProyecto);
  document.querySelectorAll(".link-volver-proyecto").forEach(a=>{
    a.addEventListener("click", (e)=>{ e.preventDefault(); mostrarOpcionesProyecto(); });
  });
  document.getElementById("btn-cambiar-proyecto").addEventListener("click", handleCambiarProyecto);
  document.getElementById("link-logout-proyecto").addEventListener("click", (e)=>{ e.preventDefault(); handleLogout(); });
  document.getElementById("btn-generar-invitacion").addEventListener("click", handleGenerarInvitacion);

  document.getElementById("f-entidad").addEventListener("change", ()=>{
    toggleFormFields();
    const ent = currentFormEntidad();
    if (ent && ent.tipo === "por_agenda") resetAgendaFormRows();
  });

  const dlgSettings = document.getElementById("dlg-settings");
  document.getElementById("btn-open-settings").addEventListener("click", ()=>{ dlgSettings.showModal(); renderMiembros(); });
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
