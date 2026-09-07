/* Cuentas de cobro — genera el documento a partir de los turnos ya registrados.
   Reutiliza shared.js (conexión, entidades, turnos, calcularTurno) para que el
   valor de cada línea sea exactamente el mismo que ya muestra la agenda —
   ninguna cifra se recalcula con una fórmula distinta. */

let PRESTADOR = null;
let FACTURACION = {}; // { [entidadId]: {razonSocial, nit, direccion, ciudad, telefono} }
let CUENTAS = [];
let previewLineas = null; // { entidades, desde, hasta, lineas, total }

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
// `prestador` es una fila por PROYECTO (todo el equipo del consultorio comparte los
// mismos datos de facturación). Si es la primera vez que se usa este proyecto,
// todavía no tiene fila propia — se crea aquí mismo con los valores por defecto de
// la base de datos (nombre/identificación vacíos, próximo N° = 1, certificación
// tributaria estándar), listos para que los complete en «Tus datos».
async function fetchPrestador(){
  const { data, error } = await sb.from("prestador").select("*").eq("proyecto_id", PROYECTO_ACTUAL.id).maybeSingle();
  if (error){ showAlert("Error cargando tus datos: " + error.message, "error"); return null; }
  if (data) return rowToPrestador(data);
  const { data: created, error: insErr } = await sb.from("prestador").insert({ proyecto_id: PROYECTO_ACTUAL.id }).select().single();
  if (insErr){ showAlert("Error creando tus datos iniciales: " + insErr.message, "error"); return null; }
  return rowToPrestador(created);
}
async function savePrestadorDB(p){
  const { error } = await sb.from("prestador").update({
    nombre: p.nombre, identificacion: p.identificacion, direccion: p.direccion, ciudad: p.ciudad, telefono: p.telefono,
    banco: p.banco, tipo_cuenta: p.tipoCuenta, numero_cuenta: p.numeroCuenta,
    siguiente_numero: p.siguienteNumero, certificacion_tributaria: p.certificacionTributaria,
  }).eq("proyecto_id", PROYECTO_ACTUAL.id);
  if (error) throw error;
}
async function bumpSiguienteNumero(n){
  const { error } = await sb.from("prestador").update({ siguiente_numero: n }).eq("proyecto_id", PROYECTO_ACTUAL.id);
  if (error) throw error;
}

// ---------- Facturación por entidad: persistencia ----------
function rowToFacturacion(row){
  return { entidadId: row.entidad_id, razonSocial: row.razon_social, nit: row.nit, direccion: row.direccion, ciudad: row.ciudad, telefono: row.telefono };
}
async function fetchFacturacionAll(){
  const { data, error } = await sb.from("entidad_facturacion").select("*").eq("proyecto_id", PROYECTO_ACTUAL.id);
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
    const { error } = await sb.from("entidad_facturacion").insert({ ...payload, proyecto_id: PROYECTO_ACTUAL.id });
    if (error) throw error;
  }
}

// (La persistencia de `cuentas_cobro` — rowToCuenta/fetchCuentasCobro/insertCuentaCobroDB/
// deleteCuentaCobroDB/updateEstadoCuentaDB — vive en shared.js: la usa esta página y
// también cierre-anual.js.)

// El próximo número siempre es (el más alto que quede) + 1 — así borrar una de prueba
// libera su número para la próxima vez, sin arriesgar que dos cuentas de cobro
// terminen compartiendo el mismo número.
async function recomputeSiguienteNumero(){
  const maxNumero = CUENTAS.reduce((m,c)=> Math.max(m, c.numero), 0);
  const correcto = maxNumero + 1;
  if (PRESTADOR.siguienteNumero !== correcto){
    PRESTADOR.siguienteNumero = correcto;
    document.getElementById("pr-siguiente-numero").value = correcto;
    await bumpSiguienteNumero(correcto);
  }
}
// Chequeo de seguridad al cargar (no al borrar): si el número guardado ya se quedó
// corto frente a lo que hay (nunca debería pasar, pero por si acaso) lo sube para
// no arriesgar un choque de números — nunca lo baja solo por cargar la página.
async function ensureSiguienteNumeroSeguro(){
  const maxNumero = CUENTAS.reduce((m,c)=> Math.max(m, c.numero), 0);
  if (PRESTADOR.siguienteNumero <= maxNumero){
    PRESTADOR.siguienteNumero = maxNumero + 1;
    document.getElementById("pr-siguiente-numero").value = PRESTADOR.siguienteNumero;
    await bumpSiguienteNumero(PRESTADOR.siguienteNumero);
  }
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
// `etiqueta` (nombre de la entidad) se agrega al final del concepto solo cuando la
// cuenta de cobro combina más de una entidad, para poder distinguir de dónde viene
// cada línea (ej. AUNA SUR y AUNA 80 facturando juntas bajo el mismo NIT).
function buildLineasPorHora(turnos, etiqueta){
  return turnos.map(t=>{
    const calc = calcularTurno(t);
    const horas = calc.horas;
    const valorUnit = horas > 0 ? calc.subtotal / horas : 0;
    const d = new Date(t.fecha + "T00:00:00");
    const fechaTexto = `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
    let tipoTexto = "diurno";
    if (calc.nocMin > 0 && calc.ordMin === 0) tipoTexto = "nocturno";
    else if (calc.nocMin > 0 && calc.ordMin > 0) tipoTexto = "mixto";
    let concepto = `Turno ${tipoTexto} - ${fechaTexto} (${t.inicio} - ${t.fin})${t.sede ? " - " + t.sede : ""}`;
    if (etiqueta) concepto += ` — ${etiqueta}`;
    return { cantidad: horas, cantidadTexto: fmtHours(horas), concepto, valorUnit, total: calc.subtotal, fecha: t.fecha, entidadId: t.entidadId, entidadNombre: etiqueta || getEntidad(t.entidadId)?.nombre };
  });
}
// Las líneas CON nombre de paciente van una por una en la cuenta de cobro (el valor
// puede variar de un paciente a otro, así que agruparlas por remitente mostraría un
// "valor unitario" engañoso). Las líneas de antes de pedir nombre de paciente (sin
// nombre, agrupadas por remitente) se siguen sumando juntas, como siempre.
function buildLineasPorAgenda(turnos, etiqueta){
  const porRemitente = {};
  const porPaciente = [];
  let entidadId = null;
  for (const t of turnos){
    entidadId = t.entidadId;
    const calc = calcularTurno(t);
    for (const d of (calc.detalleLista || [])){
      if (d.nombrePaciente){
        porPaciente.push({ nombrePaciente: d.nombrePaciente, remitente: d.nombre, valor: d.tarifa, fecha: t.fecha });
      } else {
        const cur = porRemitente[d.nombre] || { cantidad:0, total:0, tarifa:d.tarifa };
        cur.cantidad += d.cantidad; cur.total += d.cantidad * d.tarifa;
        porRemitente[d.nombre] = cur;
      }
    }
  }
  const entidadNombre = etiqueta || (entidadId ? getEntidad(entidadId)?.nombre : null);
  const lineasAgrupadas = Object.entries(porRemitente).map(([nombre, v])=>({
    cantidad: v.cantidad, cantidadTexto: String(v.cantidad),
    concepto: `Consulta ${nombre}${etiqueta ? " — " + etiqueta : ""}`,
    valorUnit: v.tarifa, total: v.total, fecha: null, entidadId, entidadNombre,
  }));
  const lineasPaciente = porPaciente.map(p=>({
    cantidad: 1, cantidadTexto: "1",
    concepto: `Consulta ${p.remitente} — ${p.nombrePaciente}${etiqueta ? " — " + etiqueta : ""}`,
    valorUnit: p.valor, total: p.valor, fecha: p.fecha, entidadId, entidadNombre,
  }));
  return lineasAgrupadas.concat(lineasPaciente);
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
    showAlert(mensajeSiSuscripcionVencida(e) || ("Error guardando tus datos: " + e.message), "error");
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
    showAlert(mensajeSiSuscripcionVencida(e) || ("Error guardando datos de facturación: " + e.message), "error");
  }
}

// ---------- UI: generar cuenta de cobro ----------
function renderGenEntidadOptions(){
  const wrap = document.getElementById("gen-entidad-checks");
  const opciones = entidadesFacturables();
  const prevChecked = new Set(Array.from(wrap.querySelectorAll("input:checked")).map(i=>i.value));
  wrap.innerHTML = opciones.map(e=>`
    <label class="inline chip-check"><input type="checkbox" class="gen-entidad-check" value="${e.id}" ${prevChecked.has(e.id)?"checked":""}> ${esc(e.nombre)}</label>
  `).join("");
  wrap.querySelectorAll(".gen-entidad-check").forEach(cb=> cb.addEventListener("change", resetPreview));
}
function selectedGenEntidades(){
  return Array.from(document.querySelectorAll(".gen-entidad-check:checked")).map(cb => getEntidad(cb.value)).filter(Boolean);
}
// Si las entidades elegidas comparten el mismo NIT en «Datos de facturación por
// entidad», usa esos datos. Si tienen NIT distinto, es un conflicto real (no se
// puede adivinar cuál usar) — se avisa en vez de generar con datos incorrectos.
function resolveAdquirente(entidades){
  const llenos = entidades.map(e => FACTURACION[e.id]).filter(f => f && f.nit);
  if (llenos.length === 0) return { adquirente:null, conflict:false };
  const nits = new Set(llenos.map(f=>f.nit));
  if (nits.size > 1) return { adquirente:null, conflict:true };
  return { adquirente: llenos[0], conflict:false };
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
  const entidades = selectedGenEntidades();
  if (entidades.length === 0){ showAlert("Selecciona al menos una entidad.", "error"); return; }
  const desde = document.getElementById("gen-desde").value;
  const hasta = document.getElementById("gen-hasta").value;
  if (!desde || !hasta){ showAlert("Completa el rango de fechas.", "error"); return; }
  if (desde > hasta){ showAlert("«Desde» no puede ser posterior a «Hasta».", "error"); return; }

  const multi = entidades.length > 1;
  let lineas = [];
  for (const ent of entidades){
    const turnos = turnosEnPeriodo(ent.id, desde, hasta);
    const etiqueta = multi ? ent.nombre : null;
    lineas = lineas.concat(ent.tipo === "por_hora" ? buildLineasPorHora(turnos, etiqueta) : buildLineasPorAgenda(turnos, etiqueta));
  }
  if (lineas.length === 0){
    showAlert(`No hay turnos de ${entidades.map(e=>e.nombre).join(" / ")} entre ${desde} y ${hasta}.`, "error");
    resetPreview();
    return;
  }
  lineas.sort((a,b)=> (a.fecha||"").localeCompare(b.fecha||""));
  const total = lineas.reduce((s,l)=> s + l.total, 0);
  previewLineas = { entidades, desde, hasta, lineas, total };
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
  const entidades = previewLineas.entidades;
  const nombres = entidades.map(e=>e.nombre).join(" / ");

  const { adquirente: resuelto, conflict } = resolveAdquirente(entidades);
  if (conflict){
    showAlert(`"${nombres}" tienen NIT distinto en «Datos de facturación por entidad» — no se pueden combinar así en una sola cuenta de cobro. Ponles el mismo NIT/razón social ahí, o genera una cuenta de cobro separada para cada una.`, "error");
    return;
  }
  let adquirente = resuelto;
  if (!adquirente){
    if (!confirm(`No has llenado el NIT/Razón social de "${nombres}" en «Datos de facturación por entidad». ¿Generar de todas formas con esos datos en blanco?`)) return;
    adquirente = { razonSocial: nombres, nit:"", direccion:"", ciudad:"", telefono:"" };
  }
  if (!PRESTADOR.nombre || !PRESTADOR.identificacion){
    if (!confirm('No has llenado tu nombre/identificación en «Tus datos». ¿Generar de todas formas?')) return;
  }

  try{
    const fechaEmision = getLocalDateISO();
    const entidadIds = entidades.map(e=>e.id);
    // Las deducciones y el neto quedan congelados con los % vigentes HOY — así el
    // cierre anual nunca se distorsiona si más adelante cambian esos porcentajes.
    const ded = calcDeducciones(previewLineas.total);

    // El número consecutivo NO se calcula aquí: lo asigna de forma atómica un
    // trigger de la base de datos al insertar (ver asignar_numero_cuenta_cobro),
    // así dos personas generando una cuenta de cobro a la vez nunca chocan.
    const guardada = await insertCuentaCobroDB({
      entidad_id: entidadIds[0],
      entidad_ids: entidadIds,
      fecha_emision: fechaEmision,
      periodo_desde: previewLineas.desde,
      periodo_hasta: previewLineas.hasta,
      prestador_snapshot: PRESTADOR,
      adquirente_snapshot: adquirente,
      lineas: previewLineas.lineas,
      total: previewLineas.total,
      certificacion_snapshot: PRESTADOR.certificacionTributaria,
      deducciones_snapshot: { segSocial: ded.segSocial, vacaciones: ded.vacaciones, cesantias: ded.cesantias, retefuente: ded.retefuente, total: ded.total },
      neto: ded.neto,
    });
    const numero = guardada.numero;
    // El trigger ya subió prestador.siguiente_numero en la base — aquí solo se
    // refleja en pantalla, no se vuelve a escribir (evitaría doble incremento).
    PRESTADOR.siguienteNumero = numero + 1;
    document.getElementById("pr-siguiente-numero").value = PRESTADOR.siguienteNumero;

    renderInvoice({ numero, fechaEmision, prestador: PRESTADOR, adquirente, lineas: previewLineas.lineas, total: previewLineas.total, certificacion: PRESTADOR.certificacionTributaria });
    CUENTAS = await fetchCuentasCobro();
    renderHistorial();
    showAlert(`Cuenta de cobro N° ${String(numero).padStart(3,"0")} generada.`, "ok");
    document.getElementById("invoice-wrap").scrollIntoView({behavior:"smooth", block:"start"});
  }catch(e){
    showAlert(mensajeSiSuscripcionVencida(e) || ("Error generando la cuenta de cobro: " + e.message), "error");
  }
}

// ---------- Historial + estado de pago ----------
// Filtro por rango de fecha de emisión: solo afecta lo que se ve en pantalla
// (historial y su resumen), nunca las cuentas de cobro en sí ni el cierre anual.
function cuentasFiltradas(){
  const desde = document.getElementById("hist-desde").value;
  const hasta = document.getElementById("hist-hasta").value;
  return CUENTAS.filter(c => (!desde || c.fechaEmision >= desde) && (!hasta || c.fechaEmision <= hasta));
}
function renderResumenCobro(cuentas){
  const pendiente = cuentas.filter(c=>c.estado !== "pagada");
  const pagado = cuentas.filter(c=>c.estado === "pagada");
  const sumaPendiente = pendiente.reduce((s,c)=> s + c.total, 0);
  const sumaPagado = pagado.reduce((s,c)=> s + c.total, 0);
  document.getElementById("resumen-cobro").innerHTML = `
    <div class="resumen-item">
      <h3>⏳ Pendiente por cobrar</h3>
      <div class="row"><span>${pendiente.length} cuenta(s) de cobro</span></div>
      <div class="total">${fmtMoney(sumaPendiente)}</div>
    </div>
    <div class="resumen-item">
      <h3>✅ Cobrado</h3>
      <div class="row"><span>${pagado.length} cuenta(s) de cobro</span></div>
      <div class="total">${fmtMoney(sumaPagado)}</div>
    </div>
  `;
}
function renderHistorial(){
  const desde = document.getElementById("hist-desde").value;
  const hasta = document.getElementById("hist-hasta").value;
  const cuentas = cuentasFiltradas();

  const hint = document.getElementById("hist-filtro-hint");
  if (desde || hasta){
    hint.hidden = false;
    hint.textContent = `Mostrando ${cuentas.length} de ${CUENTAS.length} cuenta(s) de cobro${desde ? " desde " + desde : ""}${hasta ? " hasta " + hasta : ""}.`;
  } else {
    hint.hidden = true;
  }

  renderResumenCobro(cuentas);
  const tbody = document.getElementById("historial-rows");
  tbody.innerHTML = cuentas.map(c=>{
    const nombres = c.entidadIds.map(id => getEntidad(id)).filter(Boolean).map(e=>e.nombre);
    const nombre = nombres.length ? nombres.join(" + ") : (c.adquirenteSnapshot ? c.adquirenteSnapshot.razonSocial : "?");
    const pagada = c.estado === "pagada";
    return `<tr>
      <td>${String(c.numero).padStart(3,"0")}</td>
      <td>${esc(c.fechaEmision)}</td>
      <td>${esc(nombre)}</td>
      <td>${esc(c.periodoDesde)} – ${esc(c.periodoHasta)}</td>
      <td>${fmtMoney(c.total)}</td>
      <td><span class="imp-status ${pagada ? "ok" : "conflict"}">${pagada ? "Pagada" : "Pendiente"}</span></td>
      <td>${esc(c.fechaPago) || "—"}</td>
      <td style="white-space:nowrap;">
        <button type="button" class="btn secondary btn-sm" data-ver="${c.id}">Ver / Reimprimir</button>
        <button type="button" class="btn secondary btn-sm" data-toggle-estado="${c.id}">${pagada ? "Marcar pendiente" : "Marcar pagada"}</button>
        <button type="button" class="btn danger-link" data-del="${c.id}">Eliminar</button>
      </td>
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
  tbody.querySelectorAll("[data-toggle-estado]").forEach(btn=>{
    btn.addEventListener("click", ()=> handleToggleEstado(btn.dataset.toggleEstado));
  });
  tbody.querySelectorAll("[data-del]").forEach(btn=>{
    btn.addEventListener("click", ()=> handleDeleteCuenta(btn.dataset.del));
  });
}
async function handleToggleEstado(id){
  const c = CUENTAS.find(x=>x.id === id);
  if (!c) return;
  try{
    if (c.estado === "pagada"){
      await updateEstadoCuentaDB(id, "pendiente", null);
    } else {
      const hoy = getLocalDateISO();
      const fecha = prompt(`Fecha de pago de la cuenta de cobro N° ${String(c.numero).padStart(3,"0")}:`, hoy);
      if (fecha === null) return; // canceló
      await updateEstadoCuentaDB(id, "pagada", fecha || hoy);
    }
    CUENTAS = await fetchCuentasCobro();
    renderHistorial();
  }catch(e){
    showAlert("Error actualizando el estado de pago: " + e.message, "error");
  }
}
async function handleDeleteCuenta(id){
  const c = CUENTAS.find(x=>x.id === id);
  if (!c) return;
  if (!confirm(`¿Eliminar definitivamente la cuenta de cobro N° ${String(c.numero).padStart(3,"0")}?\n\nEsto no se puede deshacer. El próximo número se ajusta solo para no dejar huecos raros.`)) return;
  try{
    await deleteCuentaCobroDB(id);
    CUENTAS = await fetchCuentasCobro();
    await recomputeSiguienteNumero();
    renderHistorial();
    showAlert(`Cuenta de cobro N° ${String(c.numero).padStart(3,"0")} eliminada. Próximo número: ${String(PRESTADOR.siguienteNumero).padStart(3,"0")}.`, "ok");
  }catch(e){
    showAlert("Error eliminando la cuenta de cobro: " + e.message, "error");
  }
}

// ---------- Init ----------
function showNeedsLogin(){
  document.getElementById("needs-login-text").textContent = "Necesitas iniciar sesión primero en la app principal.";
  document.getElementById("needs-login").hidden = false;
  document.getElementById("cc-root").hidden = true;
}
function showNeedsProject(){
  document.getElementById("needs-login-text").textContent = "Elige o crea tu proyecto primero en la app principal.";
  document.getElementById("needs-login").hidden = false;
  document.getElementById("cc-root").hidden = true;
}
function showNeedsConsent(){
  document.getElementById("needs-login-text").textContent = "Antes de continuar, debes aceptar la política de tratamiento de datos en la app principal.";
  document.getElementById("needs-login").hidden = false;
  document.getElementById("cc-root").hidden = true;
}
async function enterPage(){
  // Habeas Data: el formulario para aceptar la política solo vive en index.html.
  if (!(await tieneConsentimientoVigente())){ showNeedsConsent(); return; }
  const { activo } = await resolverProyectoActivo();
  if (!activo){ showNeedsProject(); return; }

  document.getElementById("needs-login").hidden = true;
  document.getElementById("cc-root").hidden = false;
  document.getElementById("cc-proyecto-nombre").textContent = activo.nombre;

  await fetchSuscripcion();
  renderSuscripcionBanner();

  ENTIDADES = await fetchEntidades();
  REMITENTES = await fetchRemitentes();
  TURNOS = await fetchTurnos();
  PRESTADOR = await fetchPrestador();
  FACTURACION = await fetchFacturacionAll();
  CUENTAS = await fetchCuentasCobro();

  loadPrestadorIntoForm();
  await ensureSiguienteNumeroSeguro();
  renderFacturacionEntidadSelector();
  renderGenEntidadOptions();
  renderHistorial();

  const hoy = new Date();
  document.getElementById("gen-desde").value = getLocalDateISO(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
  document.getElementById("gen-hasta").value = getLocalDateISO(hoy);
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
  document.getElementById("btn-preview").addEventListener("click", handlePreview);
  document.getElementById("btn-generar").addEventListener("click", handleGenerar);
  document.getElementById("btn-print").addEventListener("click", ()=> window.print());

  document.getElementById("hist-desde").addEventListener("change", renderHistorial);
  document.getElementById("hist-hasta").addEventListener("change", renderHistorial);
  document.getElementById("btn-hist-limpiar").addEventListener("click", ()=>{
    document.getElementById("hist-desde").value = "";
    document.getElementById("hist-hasta").value = "";
    renderHistorial();
  });
});
