/* Cuentas de cobro — genera el documento a partir de los turnos ya registrados.
   Reutiliza shared.js (conexión, entidades, turnos, calcularTurno) para que el
   valor de cada línea sea exactamente el mismo que ya muestra la agenda —
   ninguna cifra se recalcula con una fórmula distinta. */

let PRESTADOR = null;
let FACTURACION = {}; // { [entidadId]: {razonSocial, nit, direccion, ciudad, telefono} }
let CUENTAS = [];
let previewLineas = null; // { entidad, desde, hasta, lineas, total }

// ---------- Alerta local (esta página tiene su propio #alert-box) ----------
function showAlert(msg, type){
  const box = document.getElementById("alert-box");
  box.hidden = false;
  box.className = "alert no-print " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
}

// ---------- Prestador: persistencia ----------
function rowToPrestador(row){
  return {
    nombre: row.nombre, identificacion: row.identificacion, direccion: row.direccion,
    ciudad: row.ciudad, telefono: row.telefono, banco: row.banco,
    tipoCuenta: row.tipo_cuenta, numeroCuenta: row.numero_cuenta,
    siguienteNumero: row.siguiente_numero, certificacionTributaria: row.certificacion_tributaria,
  };
}
async function fetchPrestador(){
  const { data, error } = await sb.from("prestador").select("*").eq("id", 1).single();
  if (error){ showAlert("Error cargando tus datos: " + error.message, "error"); return null; }
  return rowToPrestador(data);
}
async function savePrestadorDB(p){
  const { error } = await sb.from("prestador").update({
    nombre: p.nombre, identificacion: p.identificacion, direccion: p.direccion, ciudad: p.ciudad, telefono: p.telefono,
    banco: p.banco, tipo_cuenta: p.tipoCuenta, numero_cuenta: p.numeroCuenta,
    siguiente_numero: p.siguienteNumero, certificacion_tributaria: p.certificacionTributaria,
  }).eq("id", 1);
  if (error) throw error;
}
async function bumpSiguienteNumero(n){
  const { error } = await sb.from("prestador").update({ siguiente_numero: n }).eq("id", 1);
  if (error) throw error;
}

// ---------- Facturación por entidad: persistencia ----------
function rowToFacturacion(row){
  return { entidadId: row.entidad_id, razonSocial: row.razon_social, nit: row.nit, direccion: row.direccion, ciudad: row.ciudad, telefono: row.telefono };
}
async function fetchFacturacionAll(){
  const { data, error } = await sb.from("entidad_facturacion").select("*");
  if (error){ showAlert("Error cargando datos de facturación: " + error.message, "error"); return {}; }
  const map = {};
  for (const row of data) map[row.entidad_id] = rowToFacturacion(row);
  return map;
}
async function upsertFacturacionDB(entidadId, data){
  const payload = { entidad_id: entidadId, razon_social: data.razonSocial, nit: data.nit, direccion: data.direccion, ciudad: data.ciudad, telefono: data.telefono };
  if (FACTURACION[entidadId]){
    const { error } = await sb.from("entidad_facturacion").update(payload).eq("entidad_id", entidadId);
    if (error) throw error;
  } else {
    const { error } = await sb.from("entidad_facturacion").insert(payload);
    if (error) throw error;
  }
}

// ---------- Cuentas de cobro: persistencia (historial, snapshot inmutable) ----------
function rowToCuenta(row){
  return {
    id: row.id, numero: row.numero, entidadId: row.entidad_id,
    fechaEmision: row.fecha_emision, periodoDesde: row.periodo_desde, periodoHasta: row.periodo_hasta,
    prestadorSnapshot: row.prestador_snapshot, adquirenteSnapshot: row.adquirente_snapshot,
    lineas: row.lineas, total: Number(row.total), certificacionSnapshot: row.certificacion_snapshot,
  };
}
async function fetchCuentasCobro(){
  const { data, error } = await sb.from("cuentas_cobro").select("*").order("numero", { ascending:false });
  if (error){ showAlert("Error cargando el historial: " + error.message, "error"); return []; }
  return data.map(rowToCuenta);
}
async function insertCuentaCobroDB(row){
  const { error } = await sb.from("cuentas_cobro").insert(row);
  if (error) throw error;
}

// ---------- Entidades facturables (solo por_hora / por_agenda: las únicas que emiten cuenta de cobro) ----------
function entidadesFacturables(){
  return ENTIDADES.filter(e => e.activo && (e.tipo === "por_hora" || e.tipo === "por_agenda")).sort((a,b)=>a.orden-b.orden);
}

// ---------- Construcción de líneas: reutiliza calcularTurno de shared.js ----------
function turnosEnPeriodo(entidadId, desde, hasta){
  return TURNOS.filter(t => t.entidadId === entidadId && t.fecha >= desde && t.fecha <= hasta)
    .sort((a,b)=> turnoInterval(a).start - turnoInterval(b).start);
}
function buildLineasPorHora(turnos){
  return turnos.map(t=>{
    const calc = calcularTurno(t);
    const horas = calc.horas;
    const valorUnit = horas > 0 ? calc.subtotal / horas : 0;
    const d = new Date(t.fecha + "T00:00:00");
    const fechaTexto = `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
    let tipoTexto = "diurno";
    if (calc.nocMin > 0 && calc.ordMin === 0) tipoTexto = "nocturno";
    else if (calc.nocMin > 0 && calc.ordMin > 0) tipoTexto = "mixto";
    const concepto = `Turno ${tipoTexto} - ${fechaTexto} (${t.inicio} - ${t.fin})${t.sede ? " - " + t.sede : ""}`;
    return { cantidad: horas, cantidadTexto: fmtHours(horas), concepto, valorUnit, total: calc.subtotal };
  });
}
function buildLineasPorAgenda(turnos){
  const porRemitente = {};
  for (const t of turnos){
    const calc = calcularTurno(t);
    for (const d of (calc.detalleLista || [])){
      const cur = porRemitente[d.nombre] || { cantidad:0, total:0, tarifa:d.tarifa };
      cur.cantidad += d.cantidad; cur.total += d.cantidad * d.tarifa;
      porRemitente[d.nombre] = cur;
    }
  }
  return Object.entries(porRemitente).map(([nombre, v])=>({
    cantidad: v.cantidad, cantidadTexto: String(v.cantidad), concepto: `Consulta ${nombre}`, valorUnit: v.tarifa, total: v.total,
  }));
}

// ---------- UI: datos del prestador ----------
function loadPrestadorIntoForm(){
  document.getElementById("pr-nombre").value = PRESTADOR.nombre;
  document.getElementById("pr-identificacion").value = PRESTADOR.identificacion;
  document.getElementById("pr-direccion").value = PRESTADOR.direccion;
  document.getElementById("pr-ciudad").value = PRESTADOR.ciudad;
  document.getElementById("pr-telefono").value = PRESTADOR.telefono;
  document.getElementById("pr-banco").value = PRESTADOR.banco;
  document.getElementById("pr-tipo-cuenta").value = PRESTADOR.tipoCuenta;
  document.getElementById("pr-numero-cuenta").value = PRESTADOR.numeroCuenta;
  document.getElementById("pr-siguiente-numero").value = PRESTADOR.siguienteNumero;
  document.getElementById("pr-certificacion").value = PRESTADOR.certificacionTributaria;
}
async function handleSavePrestador(){
  PRESTADOR = {
    nombre: document.getElementById("pr-nombre").value.trim(),
    identificacion: document.getElementById("pr-identificacion").value.trim(),
    direccion: document.getElementById("pr-direccion").value.trim(),
    ciudad: document.getElementById("pr-ciudad").value.trim(),
    telefono: document.getElementById("pr-telefono").value.trim(),
    banco: document.getElementById("pr-banco").value.trim(),
    tipoCuenta: document.getElementById("pr-tipo-cuenta").value.trim(),
    numeroCuenta: document.getElementById("pr-numero-cuenta").value.trim(),
    siguienteNumero: Number(document.getElementById("pr-siguiente-numero").value || 1),
    certificacionTributaria: document.getElementById("pr-certificacion").value,
  };
  try{
    await savePrestadorDB(PRESTADOR);
    showAlert("Tus datos se guardaron.", "ok");
  }catch(e){
    showAlert("Error guardando tus datos: " + e.message, "error");
  }
}

// ---------- UI: datos de facturación por entidad ----------
function renderFacturacionEntidadSelector(){
  const sel = document.getElementById("fact-entidad-select");
  const cur = sel.value;
  const opciones = entidadesFacturables();
  sel.innerHTML = opciones.map(e=>`<option value="${e.id}">${esc(e.nombre)}</option>`).join("");
  if (opciones.some(e=>e.id===cur)) sel.value = cur;
  loadFacturacionIntoForm();
}
function loadFacturacionIntoForm(){
  const entidadId = document.getElementById("fact-entidad-select").value;
  const f = FACTURACION[entidadId];
  const ent = getEntidad(entidadId);
  document.getElementById("fact-razon-social").value = f ? f.razonSocial : (ent ? ent.nombre : "");
  document.getElementById("fact-nit").value = f ? f.nit : "";
  document.getElementById("fact-direccion").value = f ? f.direccion : "";
  document.getElementById("fact-ciudad").value = f ? f.ciudad : "";
  document.getElementById("fact-telefono").value = f ? f.telefono : "";
}
async function handleSaveFacturacion(){
  const entidadId = document.getElementById("fact-entidad-select").value;
  if (!entidadId){ showAlert("No hay ninguna entidad facturable (por hora o por agenda) activa para configurar.", "error"); return; }
  const data = {
    razonSocial: document.getElementById("fact-razon-social").value.trim(),
    nit: document.getElementById("fact-nit").value.trim(),
    direccion: document.getElementById("fact-direccion").value.trim(),
    ciudad: document.getElementById("fact-ciudad").value.trim(),
    telefono: document.getElementById("fact-telefono").value.trim(),
  };
  try{
    await upsertFacturacionDB(entidadId, data);
    FACTURACION = await fetchFacturacionAll();
    showAlert("Datos de facturación guardados.", "ok");
  }catch(e){
    showAlert("Error guardando datos de facturación: " + e.message, "error");
  }
}

// ---------- UI: generar cuenta de cobro ----------
function currentGenEntidad(){
  return getEntidad(document.getElementById("gen-entidad").value);
}
function renderGenEntidadOptions(){
  const sel = document.getElementById("gen-entidad");
  const cur = sel.value;
  const opciones = entidadesFacturables();
  sel.innerHTML = opciones.map(e=>`<option value="${e.id}">${esc(e.nombre)}</option>`).join("");
  if (opciones.some(e=>e.id===cur)) sel.value = cur;
}
function resetPreview(){
  previewLineas = null;
  document.getElementById("preview-wrap").hidden = true;
  document.getElementById("btn-generar").disabled = true;
}
function renderPreviewTable(lineas, total){
  const rows = lineas.map(l=>`
    <tr><td>${l.cantidadTexto ?? l.cantidad}</td><td>${esc(l.concepto)}</td><td>${fmtMoney(l.valorUnit)}</td><td>${fmtMoney(l.total)}</td></tr>
  `).join("");
  document.getElementById("preview-table").innerHTML = `
    <thead><tr><th>Cant.</th><th>Concepto</th><th>Valor unit.</th><th>Total</th></tr></thead>
    <tbody>${rows}<tr><td colspan="3" style="text-align:right"><b>TOTAL</b></td><td><b>${fmtMoney(total)}</b></td></tr></tbody>
  `;
  document.getElementById("preview-wrap").hidden = false;
}
function handlePreview(){
  const ent = currentGenEntidad();
  if (!ent){ showAlert("No hay ninguna entidad facturable (por hora o por agenda) activa.", "error"); return; }
  const desde = document.getElementById("gen-desde").value;
  const hasta = document.getElementById("gen-hasta").value;
  if (!desde || !hasta){ showAlert("Completa el rango de fechas.", "error"); return; }
  if (desde > hasta){ showAlert("«Desde» no puede ser posterior a «Hasta».", "error"); return; }

  const turnos = turnosEnPeriodo(ent.id, desde, hasta);
  if (turnos.length === 0){
    showAlert(`No hay turnos de ${ent.nombre} entre ${desde} y ${hasta}.`, "error");
    resetPreview();
    return;
  }
  const lineas = ent.tipo === "por_hora" ? buildLineasPorHora(turnos) : buildLineasPorAgenda(turnos);
  const total = lineas.reduce((s,l)=> s + l.total, 0);
  previewLineas = { entidad: ent, desde, hasta, lineas, total };
  renderPreviewTable(lineas, total);
  document.getElementById("btn-generar").disabled = false;
}

// ---------- Renderizado de la factura imprimible ----------
function renderInvoice({ numero, fechaEmision, prestador, adquirente, lineas, total, certificacion }){
  const [y, m, d] = fechaEmision.split("-");
  const filas = lineas.map(l=>`
    <tr>
      <td>${l.cantidadTexto ?? l.cantidad}</td>
      <td>${esc(l.concepto)}</td>
      <td>${fmtMoney(l.valorUnit)}</td>
      <td><b>${fmtMoney(l.total)}</b></td>
    </tr>`).join("");
  const datosPago = [prestador.banco, prestador.tipoCuenta, prestador.numeroCuenta ? `N° ${prestador.numeroCuenta}` : ""]
    .filter(Boolean).join(" | ") || "Por confirmar";

  document.getElementById("invoice").innerHTML = `
    <div class="inv-header">
      <div>
        <h1>CUENTA DE COBRO</h1>
        <p class="inv-sub">DOCUMENTO EQUIVALENTE A LA FACTURA DE VENTA<br>(Decreto 522 de 2003 / Art. 1.6.1.4.45 Decreto 1625 de 2016)</p>
      </div>
      <table class="inv-meta">
        <tr><th>AÑO</th><th>MES</th><th>DÍA</th></tr>
        <tr><td>${esc(y)}</td><td>${esc(m)}</td><td>${esc(d)}</td></tr>
        <tr><th colspan="3">CUENTA DE COBRO N°</th></tr>
        <tr><td colspan="3" class="inv-numero">${String(numero).padStart(3,"0")}</td></tr>
      </table>
    </div>
    <div class="inv-parties">
      <div>
        <h3>PRESTADOR DEL SERVICIO</h3>
        <p><b>Nombre:</b> ${esc(prestador.nombre) || "—"}</p>
        <p><b>Identificación:</b> ${esc(prestador.identificacion) || "—"}</p>
        <p><b>Dirección:</b> ${esc(prestador.direccion) || "—"}</p>
        <p><b>Ciudad:</b> ${esc(prestador.ciudad) || "—"}</p>
        <p><b>Teléfono:</b> ${esc(prestador.telefono) || "—"}</p>
      </div>
      <div>
        <h3>ADQUIRENTE / COMPRADOR</h3>
        <p><b>Razón Social:</b> ${esc(adquirente.razonSocial) || "—"}</p>
        <p><b>NIT:</b> ${esc(adquirente.nit) || "Por confirmar"}</p>
        <p><b>Dirección:</b> ${esc(adquirente.direccion) || "Por confirmar"}</p>
        <p><b>Ciudad:</b> ${esc(adquirente.ciudad) || "Por confirmar"}</p>
        <p><b>Teléfono:</b> ${esc(adquirente.telefono) || "Por confirmar"}</p>
      </div>
    </div>
    <table class="inv-table">
      <thead><tr><th>CANT.</th><th>CONCEPTO / DESCRIPCIÓN DEL SERVICIO</th><th>VALOR UNIT.</th><th>TOTAL</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="inv-total"><span>TOTAL A PAGAR</span><b>${fmtMoney(total)} COP</b></div>
    <div class="inv-pago">
      <h4>DATOS DE PAGO:</h4>
      <p>${esc(datosPago)}</p>
    </div>
    <div class="inv-cert">
      <h4>CERTIFICACIÓN TRIBUTARIA (ARTÍCULOS 103, 383 Y 206 DEL E.T.)</h4>
      <p>${esc(certificacion)}</p>
    </div>
    <p class="inv-legal">Esta cuenta de cobro se asimila en todos sus efectos legales a una letra de cambio según el artículo 774 del Código de Comercio colombiano. Su no pago oportuno ocasionará el interés comercial de mora máximo legal autorizado.</p>
    <div class="inv-firma">
      <div class="inv-firma-line"></div>
      <p><b>${esc(prestador.nombre) || "—"}</b><br>${esc(prestador.identificacion) || ""}</p>
    </div>
  `;
  document.getElementById("invoice-wrap").hidden = false;
}

async function handleGenerar(){
  if (!previewLineas) return;
  const ent = previewLineas.entidad;
  const fact = FACTURACION[ent.id];
  if (!fact || !fact.nit){
    if (!confirm(`No has llenado el NIT/Razón social de "${ent.nombre}" en «Datos de facturación por entidad». ¿Generar de todas formas con esos datos en blanco?`)) return;
  }
  if (!PRESTADOR.nombre || !PRESTADOR.identificacion){
    if (!confirm('No has llenado tu nombre/identificación en «Tus datos». ¿Generar de todas formas?')) return;
  }

  try{
    const numero = PRESTADOR.siguienteNumero;
    const fechaEmision = new Date().toISOString().slice(0,10);
    const adquirente = fact || { razonSocial: ent.nombre, nit:"", direccion:"", ciudad:"", telefono:"" };

    await insertCuentaCobroDB({
      numero,
      entidad_id: ent.id,
      fecha_emision: fechaEmision,
      periodo_desde: previewLineas.desde,
      periodo_hasta: previewLineas.hasta,
      prestador_snapshot: PRESTADOR,
      adquirente_snapshot: adquirente,
      lineas: previewLineas.lineas,
      total: previewLineas.total,
      certificacion_snapshot: PRESTADOR.certificacionTributaria,
    });
    await bumpSiguienteNumero(numero + 1);
    PRESTADOR.siguienteNumero = numero + 1;
    document.getElementById("pr-siguiente-numero").value = PRESTADOR.siguienteNumero;

    renderInvoice({ numero, fechaEmision, prestador: PRESTADOR, adquirente, lineas: previewLineas.lineas, total: previewLineas.total, certificacion: PRESTADOR.certificacionTributaria });
    CUENTAS = await fetchCuentasCobro();
    renderHistorial();
    showAlert(`Cuenta de cobro N° ${String(numero).padStart(3,"0")} generada.`, "ok");
    document.getElementById("invoice-wrap").scrollIntoView({behavior:"smooth", block:"start"});
  }catch(e){
    showAlert("Error generando la cuenta de cobro: " + e.message, "error");
  }
}

// ---------- Historial ----------
function renderHistorial(){
  const tbody = document.getElementById("historial-rows");
  tbody.innerHTML = CUENTAS.map(c=>{
    const ent = getEntidad(c.entidadId);
    const nombre = ent ? ent.nombre : (c.adquirenteSnapshot ? c.adquirenteSnapshot.razonSocial : "?");
    return `<tr>
      <td>${String(c.numero).padStart(3,"0")}</td>
      <td>${c.fechaEmision}</td>
      <td>${esc(nombre)}</td>
      <td>${c.periodoDesde} – ${c.periodoHasta}</td>
      <td>${fmtMoney(c.total)}</td>
      <td><button type="button" class="btn secondary btn-sm" data-ver="${c.id}">Ver / Reimprimir</button></td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll("[data-ver]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const c = CUENTAS.find(x=>x.id === btn.dataset.ver);
      if (!c) return;
      renderInvoice({
        numero: c.numero, fechaEmision: c.fechaEmision,
        prestador: c.prestadorSnapshot, adquirente: c.adquirenteSnapshot,
        lineas: c.lineas, total: c.total, certificacion: c.certificacionSnapshot,
      });
      document.getElementById("invoice-wrap").scrollIntoView({behavior:"smooth", block:"start"});
    });
  });
}

// ---------- Init ----------
function showNeedsLogin(){
  document.getElementById("needs-login").hidden = false;
  document.getElementById("cc-root").hidden = true;
}
async function enterPage(){
  document.getElementById("needs-login").hidden = true;
  document.getElementById("cc-root").hidden = false;

  ENTIDADES = await fetchEntidades();
  REMITENTES = await fetchRemitentes();
  TURNOS = await fetchTurnos();
  PRESTADOR = await fetchPrestador();
  FACTURACION = await fetchFacturacionAll();
  CUENTAS = await fetchCuentasCobro();

  loadPrestadorIntoForm();
  renderFacturacionEntidadSelector();
  renderGenEntidadOptions();
  renderHistorial();

  const hoy = new Date();
  document.getElementById("gen-desde").value = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0,10);
  document.getElementById("gen-hasta").value = hoy.toISOString().slice(0,10);
}

document.addEventListener("DOMContentLoaded", ()=>{
  if (!sb){
    showAlert("No se pudo cargar el sistema de acceso (revisa tu conexión a internet).", "error");
    return;
  }
  sb.auth.onAuthStateChange((event, session)=>{
    if (session) enterPage(); else showNeedsLogin();
  });

  document.getElementById("btn-save-prestador").addEventListener("click", handleSavePrestador);
  document.getElementById("fact-entidad-select").addEventListener("change", loadFacturacionIntoForm);
  document.getElementById("btn-save-facturacion").addEventListener("click", handleSaveFacturacion);
  document.getElementById("gen-entidad").addEventListener("change", resetPreview);
  document.getElementById("btn-preview").addEventListener("click", handlePreview);
  document.getElementById("btn-generar").addEventListener("click", handleGenerar);
  document.getElementById("btn-print").addEventListener("click", ()=> window.print());
});
