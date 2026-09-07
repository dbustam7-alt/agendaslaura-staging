/* Cierre anual — resume, para la declaración de renta, lo que ya quedó DOCUMENTADO
   en cuentas de cobro (no una proyección desde los turnos agendados): bruto, cada
   deducción, neto y estado de cobro, por año, por entidad y por mes; y permite
   exportar todo eso para el contador.
   Reutiliza shared.js (conexión, entidades, cuentas_cobro). */

let CUENTAS = [];
const MESES_CORTOS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

function showAlert(msg, type){
  const box = document.getElementById("alert-box");
  box.hidden = false;
  box.className = "alert " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
}
function hideAlert(){
  document.getElementById("alert-box").hidden = true;
}
function fmtCompact(n){
  const abs = Math.abs(n);
  if (abs >= 1000000) return "$" + (n/1000000).toFixed(abs % 1000000 === 0 ? 0 : 1).replace(/\.0$/,"") + "M";
  if (abs >= 1000) return "$" + Math.round(n/1000) + "K";
  return "$" + Math.round(n);
}

// A qué entidad pertenece una línea: preferir el entidadId propio de la línea (cuentas
// nuevas); si no lo tiene (cuentas viejas) y la cuenta de cobro es de una sola entidad,
// se le atribuye a esa. Si es una cuenta combinada sin entidadId por línea, queda "Sin atribuir".
function entidadIdDeLinea(cuenta, linea){
  if (linea.entidadId) return linea.entidadId;
  if (cuenta.entidadIds.length === 1) return cuenta.entidadIds[0];
  return null;
}

function computeCierre(anio){
  const cuentasDelAnio = CUENTAS.filter(c => c.fechaEmision && c.fechaEmision.slice(0,4) === String(anio));

  const totales = { bruto:0, segSocial:0, vacaciones:0, cesantias:0, retefuente:0, neto:0, pagado:0, pendiente:0 };
  const porEntidad = {}; // key -> { nombre, bruto }
  const porMes = Array.from({length:12}, ()=> ({ cobrado:0, pendiente:0 })); // índice 0 = enero

  for (const c of cuentasDelAnio){
    totales.bruto += c.total;
    if (c.deduccionesSnapshot){
      totales.segSocial += c.deduccionesSnapshot.segSocial || 0;
      totales.vacaciones += c.deduccionesSnapshot.vacaciones || 0;
      totales.cesantias += c.deduccionesSnapshot.cesantias || 0;
      totales.retefuente += c.deduccionesSnapshot.retefuente || 0;
    }
    totales.neto += c.neto;
    const pagada = c.estado === "pagada";
    if (pagada) totales.pagado += c.total; else totales.pendiente += c.total;

    const mesIdx = Number(c.fechaEmision.slice(5,7)) - 1;
    if (mesIdx >= 0 && mesIdx <= 11){
      if (pagada) porMes[mesIdx].cobrado += c.total; else porMes[mesIdx].pendiente += c.total;
    }

    for (const linea of (c.lineas || [])){
      const eid = entidadIdDeLinea(c, linea);
      const key = eid || "sin-atribuir";
      const nombre = linea.entidadNombre || (eid ? (getEntidad(eid) ? getEntidad(eid).nombre : "(entidad eliminada)") : "Sin atribuir");
      if (!porEntidad[key]) porEntidad[key] = { nombre, bruto: 0 };
      porEntidad[key].bruto += linea.total;
    }
  }

  return { cuentasDelAnio, totales, porEntidad, porMes };
}

// ---------- Gráfico: tendencia mensual (barras apiladas cobrado/pendiente) ----------
function niceStep(max){
  if (max <= 0) return 100000;
  const rough = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let mult;
  if (norm < 1.5) mult = 1; else if (norm < 3.5) mult = 2; else if (norm < 7.5) mult = 5; else mult = 10;
  return mult * mag;
}
function roundedTopRectPath(x, y, w, h, r){
  r = Math.max(0, Math.min(r, w/2, h));
  if (h <= 0) return "";
  return `M${x+r},${y} L${x+w-r},${y} Q${x+w},${y} ${x+w},${y+r} L${x+w},${y+h} L${x},${y+h} L${x},${y+r} Q${x},${y} ${x+r},${y} Z`;
}
function renderMonthlyChart(porMes, anio){
  const wrap = document.getElementById("ca-chart-wrap");
  const totalAnual = porMes.reduce((s,m)=> s + m.cobrado + m.pendiente, 0);
  if (totalAnual <= 0){ wrap.hidden = true; return; }
  wrap.hidden = false;

  const maxMes = Math.max(...porMes.map(m => m.cobrado + m.pendiente));
  const step = niceStep(maxMes);
  const niceMax = Math.ceil(maxMes / step) * step || step;
  const gridSteps = Math.round(niceMax / step);

  const plotLeft = 52, plotRight = 12, plotTop = 14, plotBottom = 26;
  const barW = 22, gap = 14;
  const plotWidth = 12*barW + 11*gap;
  const plotHeight = 190;
  const svgW = plotLeft + plotWidth + plotRight;
  const svgH = plotTop + plotHeight + plotBottom;
  const y = v => plotTop + plotHeight - (v/niceMax)*plotHeight;

  let gridSvg = "";
  for (let i = 0; i <= gridSteps; i++){
    const val = i*step;
    const yy = y(val);
    gridSvg += `<line x1="${plotLeft}" y1="${yy}" x2="${plotLeft+plotWidth}" y2="${yy}" stroke="var(--gridline)" stroke-width="1"/>`;
    gridSvg += `<text x="${plotLeft-8}" y="${yy+3}" text-anchor="end" font-size="9" fill="var(--ink-muted)">${fmtCompact(val)}</text>`;
  }

  let barsSvg = "";
  porMes.forEach((m, i) => {
    const x = plotLeft + i*(barW+gap);
    const cobradoH = (m.cobrado/niceMax)*plotHeight;
    const pendienteH = (m.pendiente/niceMax)*plotHeight;
    const baseline = plotTop + plotHeight;
    const GAP = 2; // separador entre segmentos apilados

    let segs = "";
    if (m.cobrado > 0 && m.pendiente > 0){
      const cobradoTop = baseline - cobradoH;
      segs += `<rect x="${x}" y="${cobradoTop}" width="${barW}" height="${cobradoH}" fill="var(--status-good)"/>`;
      const pendienteBottom = cobradoTop - GAP;
      const pendienteTop = pendienteBottom - pendienteH;
      segs += `<path d="${roundedTopRectPath(x, pendienteTop, barW, pendienteH, 4)}" fill="var(--status-warning)"/>`;
    } else if (m.cobrado > 0){
      segs += `<path d="${roundedTopRectPath(x, baseline-cobradoH, barW, cobradoH, 4)}" fill="var(--status-good)"/>`;
    } else if (m.pendiente > 0){
      segs += `<path d="${roundedTopRectPath(x, baseline-pendienteH, barW, pendienteH, 4)}" fill="var(--status-warning)"/>`;
    } else {
      segs += `<rect x="${x}" y="${baseline-2}" width="${barW}" height="2" fill="var(--gridline)"/>`;
    }

    barsSvg += `
      <g class="ca-bar-group" tabindex="0" role="img" aria-label="${MESES_CORTOS[i]} ${anio}: cobrado ${fmtMoney(m.cobrado)}, pendiente ${fmtMoney(m.pendiente)}"
         data-mes="${MESES_CORTOS[i]}" data-cobrado="${m.cobrado}" data-pendiente="${m.pendiente}">
        <rect x="${x-3}" y="${plotTop}" width="${barW+6}" height="${plotHeight}" fill="transparent"/>
        ${segs}
      </g>`;
  });

  const labelsSvg = porMes.map((m,i)=>{
    const x = plotLeft + i*(barW+gap) + barW/2;
    return `<text x="${x}" y="${plotTop+plotHeight+16}" text-anchor="middle" font-size="10" fill="var(--ink-secondary)">${MESES_CORTOS[i]}</text>`;
  }).join("");

  const baselineY = plotTop + plotHeight;
  document.getElementById("ca-chart-container").innerHTML = `
    <svg viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" font-family="inherit">
      ${gridSvg}
      <line x1="${plotLeft}" y1="${baselineY}" x2="${plotLeft+plotWidth}" y2="${baselineY}" stroke="var(--ink-muted)" stroke-width="1"/>
      ${barsSvg}
      ${labelsSvg}
    </svg>
  `;
  wireChartTooltip();
}
function wireChartTooltip(){
  const tooltip = document.getElementById("ca-tooltip");
  const groups = document.querySelectorAll(".ca-bar-group");
  function show(el, x, y){
    const mes = el.dataset.mes, cobrado = Number(el.dataset.cobrado), pendiente = Number(el.dataset.pendiente);
    tooltip.innerHTML = "";
    const title = document.createElement("div");
    title.className = "tt-title";
    title.textContent = mes;
    tooltip.appendChild(title);
    const rowCobrado = document.createElement("div");
    rowCobrado.className = "tt-row";
    rowCobrado.innerHTML = `<span class="tt-key"><span class="stroke" style="background:var(--status-good);"></span>Cobrado</span>`;
    const valCobrado = document.createElement("strong");
    valCobrado.textContent = fmtMoney(cobrado);
    rowCobrado.appendChild(valCobrado);
    tooltip.appendChild(rowCobrado);
    const rowPendiente = document.createElement("div");
    rowPendiente.className = "tt-row";
    rowPendiente.innerHTML = `<span class="tt-key"><span class="stroke" style="background:var(--status-warning);"></span>Pendiente</span>`;
    const valPendiente = document.createElement("strong");
    valPendiente.textContent = fmtMoney(pendiente);
    rowPendiente.appendChild(valPendiente);
    tooltip.appendChild(rowPendiente);
    tooltip.style.left = (x+12) + "px";
    tooltip.style.top = (y+12) + "px";
    tooltip.classList.add("visible");
  }
  function hide(){ tooltip.classList.remove("visible"); }
  groups.forEach(g=>{
    g.addEventListener("pointermove", e => show(g, e.clientX, e.clientY));
    g.addEventListener("pointerenter", e => show(g, e.clientX, e.clientY));
    g.addEventListener("pointerleave", hide);
    g.addEventListener("focus", ()=>{ const r = g.getBoundingClientRect(); show(g, r.left, r.top); });
    g.addEventListener("blur", hide);
  });
}

// ---------- Exportar para el contador ----------
function buildExportData(anio, totales, porEntidad, cuentasDelAnio){
  const resumen = [
    ["Cierre anual", anio],
    [],
    ["Total facturado (bruto)", totales.bruto],
    ["Seguridad social", totales.segSocial],
    ["Vacaciones", totales.vacaciones],
    ["Cesantías", totales.cesantias],
    ["Retefuente retenida", totales.retefuente],
    ["Neto", totales.neto],
    [],
    ["Cobrado", totales.pagado],
    ["Pendiente por cobrar", totales.pendiente],
  ];
  const porEntidadRows = [["Entidad","Bruto","% del total"]];
  for (const f of Object.values(porEntidad).sort((a,b)=>b.bruto-a.bruto)){
    porEntidadRows.push([f.nombre, f.bruto, totales.bruto ? Math.round(f.bruto/totales.bruto*100) : 0]);
  }
  const detalleRows = [["N°","Fecha emisión","Entidad","Bruto","Seg. Social","Vacaciones","Cesantías","Retefuente","Neto","Estado","Fecha de pago"]];
  for (const c of [...cuentasDelAnio].sort((a,b)=>a.numero-b.numero)){
    const nombres = c.entidadIds.map(id=>getEntidad(id)).filter(Boolean).map(e=>e.nombre);
    const nombre = nombres.length ? nombres.join(" + ") : (c.adquirenteSnapshot ? c.adquirenteSnapshot.razonSocial : "?");
    const d = c.deduccionesSnapshot || {};
    detalleRows.push([
      String(c.numero).padStart(3,"0"), c.fechaEmision, nombre, c.total,
      d.segSocial||0, d.vacaciones||0, d.cesantias||0, d.retefuente||0, c.neto,
      c.estado === "pagada" ? "Pagada" : "Pendiente", c.fechaPago || "",
    ]);
  }
  return { resumen, porEntidadRows, detalleRows };
}
function downloadFile(filename, content, mime){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
let ultimoCierre = null; // { anio, totales, porEntidad, cuentasDelAnio } — lo que hay calculado en pantalla ahora mismo

function handleExportXlsx(){
  if (!ultimoCierre) return;
  if (typeof XLSX === "undefined"){
    showAlert("No se pudo cargar la librería de Excel (sin conexión a internet). Usa CSV mientras tanto.", "error");
    return;
  }
  const { anio, totales, porEntidad, cuentasDelAnio } = ultimoCierre;
  const { resumen, porEntidadRows, detalleRows } = buildExportData(anio, totales, porEntidad, cuentasDelAnio);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), "Resumen");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(porEntidadRows), "Por entidad");
  const wsDetalle = XLSX.utils.aoa_to_sheet(detalleRows);
  wsDetalle["!cols"] = [{wch:6},{wch:12},{wch:24},{wch:12},{wch:12},{wch:12},{wch:12},{wch:12},{wch:12},{wch:10},{wch:12}];
  XLSX.utils.book_append_sheet(wb, wsDetalle, "Detalle");
  XLSX.writeFile(wb, `cierre-anual-${anio}.xlsx`);
}
function handleExportCsv(){
  if (!ultimoCierre) return;
  const { anio, totales, porEntidad, cuentasDelAnio } = ultimoCierre;
  const { detalleRows } = buildExportData(anio, totales, porEntidad, cuentasDelAnio);
  const csv = detalleRows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  downloadFile(`cierre-anual-${anio}-detalle.csv`, csv, "text/csv;charset=utf-8;");
}

function renderCierre(anio){
  hideAlert(); // limpia cualquier aviso de un cálculo anterior (ej. "sin cuentas de cobro" de otro año)
  const { cuentasDelAnio, totales, porEntidad, porMes } = computeCierre(anio);
  ultimoCierre = { anio, totales, porEntidad, cuentasDelAnio };

  document.getElementById("ca-titulo").textContent = `Cierre ${anio}`;
  document.getElementById("ca-results").hidden = false;

  document.getElementById("ca-resumen").innerHTML = `
    <div class="resumen-item">
      <h3>💵 Total facturado (bruto)</h3>
      <div class="row"><span>${cuentasDelAnio.length} cuenta(s) de cobro</span></div>
      <div class="total">${fmtMoney(totales.bruto)}</div>
    </div>
    <div class="resumen-item">
      <h3>🧾 Deducciones del año</h3>
      <div class="row"><span>Seguridad social</span><span>${fmtMoney(totales.segSocial)}</span></div>
      <div class="row"><span>Vacaciones</span><span>${fmtMoney(totales.vacaciones)}</span></div>
      <div class="row"><span>Cesantías</span><span>${fmtMoney(totales.cesantias)}</span></div>
      <div class="row"><span><strong>Retefuente retenida</strong></span><b>${fmtMoney(totales.retefuente)}</b></div>
      <div class="total">Neto: ${fmtMoney(totales.neto)}</div>
    </div>
    <div class="resumen-item">
      <h3>💰 Estado de cobro</h3>
      <div class="row"><span>Cobrado</span><span>${fmtMoney(totales.pagado)}</span></div>
      <div class="row"><span>Pendiente</span><span>${fmtMoney(totales.pendiente)}</span></div>
    </div>
  `;

  renderMonthlyChart(porMes, anio);

  const entidadesWrap = document.getElementById("ca-entidades-wrap");
  const filasEntidad = Object.values(porEntidad).sort((a,b)=> b.bruto - a.bruto);
  if (filasEntidad.length){
    document.getElementById("ca-entidades-rows").innerHTML = filasEntidad.map(f => `
      <tr><td style="text-align:left;">${esc(f.nombre)}</td><td>${fmtMoney(f.bruto)}</td><td>${totales.bruto ? Math.round(f.bruto/totales.bruto*100) : 0}%</td></tr>
    `).join("");
    entidadesWrap.hidden = false;
  } else {
    entidadesWrap.hidden = true;
  }

  const detalleWrap = document.getElementById("ca-detalle-wrap");
  const exportWrap = document.getElementById("ca-export-wrap");
  if (cuentasDelAnio.length){
    const ordenadas = [...cuentasDelAnio].sort((a,b)=> a.numero - b.numero);
    document.getElementById("ca-detalle-rows").innerHTML = ordenadas.map(c=>{
      const nombres = c.entidadIds.map(id=>getEntidad(id)).filter(Boolean).map(e=>e.nombre);
      const nombre = nombres.length ? nombres.join(" + ") : (c.adquirenteSnapshot ? c.adquirenteSnapshot.razonSocial : "?");
      const pagada = c.estado === "pagada";
      return `<tr>
        <td>${String(c.numero).padStart(3,"0")}</td>
        <td>${c.fechaEmision}</td>
        <td>${esc(nombre)}</td>
        <td>${fmtMoney(c.total)}</td>
        <td>${fmtMoney(c.neto)}</td>
        <td><span class="imp-status ${pagada ? "ok" : "conflict"}">${pagada ? "Pagada" : "Pendiente"}</span></td>
        <td>${c.fechaPago || "—"}</td>
      </tr>`;
    }).join("");
    detalleWrap.hidden = false;
    exportWrap.hidden = false;
  } else {
    detalleWrap.hidden = true;
    exportWrap.hidden = true;
    showAlert(`No hay cuentas de cobro emitidas en ${anio}.`, "error");
  }
}

function handleCalcular(){
  const anio = Number(document.getElementById("ca-anio").value);
  if (!anio || anio < 2000){ showAlert("Escribe un año válido.", "error"); return; }
  renderCierre(anio);
}

// ---------- Init ----------
function showNeedsLogin(){
  document.getElementById("needs-login-text").textContent = "Necesitas iniciar sesión primero en la app principal.";
  document.getElementById("needs-login").hidden = false;
  document.getElementById("ca-root").hidden = true;
}
function showNeedsProject(){
  document.getElementById("needs-login-text").textContent = "Elige o crea tu proyecto primero en la app principal.";
  document.getElementById("needs-login").hidden = false;
  document.getElementById("ca-root").hidden = true;
}
async function enterPage(){
  const { activo } = await resolverProyectoActivo();
  if (!activo){ showNeedsProject(); return; }

  document.getElementById("needs-login").hidden = true;
  document.getElementById("ca-root").hidden = false;
  document.getElementById("ca-proyecto-nombre").textContent = activo.nombre;

  await fetchSuscripcion();
  renderSuscripcionBanner();

  ENTIDADES = await fetchEntidades();
  CUENTAS = await fetchCuentasCobro();

  document.getElementById("ca-anio").value = new Date().getFullYear();
  if (CUENTAS.length) handleCalcular();
}

document.addEventListener("DOMContentLoaded", ()=>{
  if (!sb){
    showAlert("No se pudo cargar el sistema de acceso (revisa tu conexión a internet).", "error");
    return;
  }
  sb.auth.onAuthStateChange((event, session)=>{
    if (session) enterPage(); else showNeedsLogin();
  });
  document.getElementById("btn-calcular").addEventListener("click", handleCalcular);
  document.getElementById("btn-export-xlsx").addEventListener("click", handleExportXlsx);
  document.getElementById("btn-export-csv").addEventListener("click", handleExportCsv);
});
