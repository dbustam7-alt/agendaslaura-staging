/* Cierre anual — resume, para la declaración de renta, lo que ya quedó DOCUMENTADO
   en cuentas de cobro (no una proyección desde los turnos agendados): bruto, cada
   deducción, neto y estado de cobro, por año y por entidad.
   Reutiliza shared.js (conexión, entidades, cuentas_cobro). */

let CUENTAS = [];

function showAlert(msg, type){
  const box = document.getElementById("alert-box");
  box.hidden = false;
  box.className = "alert " + type;
  box.textContent = (type === "error" ? "⚠️ " : "✅ ") + msg;
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

  for (const c of cuentasDelAnio){
    totales.bruto += c.total;
    if (c.deduccionesSnapshot){
      totales.segSocial += c.deduccionesSnapshot.segSocial || 0;
      totales.vacaciones += c.deduccionesSnapshot.vacaciones || 0;
      totales.cesantias += c.deduccionesSnapshot.cesantias || 0;
      totales.retefuente += c.deduccionesSnapshot.retefuente || 0;
    }
    totales.neto += c.neto;
    if (c.estado === "pagada") totales.pagado += c.total; else totales.pendiente += c.total;

    for (const linea of (c.lineas || [])){
      const eid = entidadIdDeLinea(c, linea);
      const key = eid || "sin-atribuir";
      const nombre = linea.entidadNombre || (eid ? (getEntidad(eid) ? getEntidad(eid).nombre : "(entidad eliminada)") : "Sin atribuir");
      if (!porEntidad[key]) porEntidad[key] = { nombre, bruto: 0 };
      porEntidad[key].bruto += linea.total;
    }
  }

  return { cuentasDelAnio, totales, porEntidad };
}

function renderCierre(anio){
  const { cuentasDelAnio, totales, porEntidad } = computeCierre(anio);

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
      </tr>`;
    }).join("");
    detalleWrap.hidden = false;
  } else {
    detalleWrap.hidden = true;
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
  document.getElementById("needs-login").hidden = false;
  document.getElementById("ca-root").hidden = true;
}
async function enterPage(){
  document.getElementById("needs-login").hidden = true;
  document.getElementById("ca-root").hidden = false;

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
});
