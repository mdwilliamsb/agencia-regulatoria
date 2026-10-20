// Consola de la agencia: tablero, clientes, diagnóstico, expediente, ajustes.
import {
  GIROS, HECHOS, MEDIOS, MUNICIPIOS, ESTATUS, ETAPAS, ETIQ_USUARIO, NIVEL_TXT,
  costo, diagnosticar, docsRequeridos, munNombre,
} from "./reglas.js";
import { documentosGenerables, contenidoDoc, construirDocx, descargarBlob } from "./documentos.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mxn = (n) => (n || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 });
const HOY = () => new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }) + "T12:00:00");
const hoyISO = () => HOY().toISOString().slice(0, 10);
const fecha = (iso) => (iso ? new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" }) : "—");
const fechaHora = (iso) => (iso ? new Date(iso).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const fechaLarga = (d) => d.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
const addMonths = (iso, m) => { const d = new Date(iso + "T12:00:00"); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };
const diasHasta = (iso) => Math.round((new Date(iso + "T12:00:00") - HOY()) / 86400000);
const fmtCosto = (c) => (c == null ? `<span style="color:var(--warn)">por confirmar</span>` : c === 0 ? "sin costo" : mxn(c));

let CAT = null, catById = {};
const S = { yo: null, clientes: new Map(), config: {}, route: "tablero", cid: null, borrador: null, estado: {} };

/* ---------- API ---------- */
async function api(metodo, ruta, cuerpo) {
  const opt = { method: metodo, headers: { "x-agencia": "1" }, credentials: "same-origin" };
  if (cuerpo instanceof FormData) opt.body = cuerpo;
  else if (cuerpo !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(cuerpo); }
  let r;
  try { r = await fetch(ruta, opt); } catch { throw new Error("Sin conexión. Revisa tu internet e inténtalo de nuevo."); }
  if (r.status === 401 && !ruta.startsWith("/api/login") && !ruta.startsWith("/api/setup")) { S.yo = null; render(true); throw new Error("Tu sesión terminó. Vuelve a entrar."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "No se pudo completar. Inténtalo de nuevo.");
  return j;
}
const ponerCliente = (c) => { if (c && c.id) S.clientes.set(c.id, c); return c; };

/* ---------- UI ---------- */
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800); }
function modal(html) { const m = $("#modal"); m.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; m.querySelectorAll("[data-cerrar]").forEach((b) => b.addEventListener("click", cerrarModal)); return m; }
function cerrarModal() { const m = $("#modal"); m.hidden = true; m.innerHTML = ""; }
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") cerrarModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) cerrarModal(); });
function pillEstatus(e) { const x = ESTATUS.find((s) => s[0] === e) || ESTATUS[0]; return `<span class="pill ${x[2]}">${x[1]}</span>`; }
function copiar(texto, el) {
  const fallback = () => { if (el) { el.focus(); el.select(); } toast("Selecciona y copia el texto"); };
  try { navigator.clipboard.writeText(texto).then(() => toast("Copiado"), fallback); } catch { fallback(); }
}

/* ---------- alertas ---------- */
function alertasDe(id, c) {
  const out = [], nom = c.nombre || "Sin nombre";
  if (c.etapa === "perdido") return out;
  const { tr } = diagnosticar(CAT, c);
  for (const [tid, x] of Object.entries(c.tramites || {})) {
    const n = catById[tid]?.nombre || tid;
    if (x.vence) {
      const d = diasHasta(x.vence);
      if (d < 0) out.push({ sev: "crit", orden: 0, id, t: `Vencido: ${n}`, d: `${nom} · venció el ${fecha(x.vence)}` });
      else if (d <= 60) out.push({ sev: "warn", orden: 1, id, t: `Renovar en ${d} días: ${n}`, d: `${nom} · vence el ${fecha(x.vence)}` });
    }
    if (x.estatus === "prevencion") out.push({ sev: "crit", orden: 0, id, t: `Responder prevención: ${n}`, d: `${nom}${x.folio ? ` · folio ${x.folio}` : ""}` });
    if (x.estatus === "esperando_cliente") out.push({ sev: "acc", orden: 2, id, t: `Esperando al cliente: ${n}`, d: `${nom}${x.notas ? ` · ${x.notas}` : ""}` });
  }
  if (tr.some((t) => t.id === "cofepris_02_001") && !(c.folio_publicidad || "").trim()) out.push({ sev: "warn", orden: 1, id, t: "Anuncios bloqueados hasta tener permiso de publicidad", d: `${nom} · sin folio COFEPRIS-02-001` });
  const docs = c.documentos || {};
  const nuevos = Object.values(docs).filter((d) => d.origen === "portal" && diasHasta(d.fecha) >= -3).length;
  if (nuevos) out.push({ sev: "acc", orden: 2, id, t: `El cliente subió ${nuevos} documento${nuevos > 1 ? "s" : ""} por el portal`, d: `${nom} · revísalo${nuevos > 1 ? "s" : ""}` });
  const falt = docsRequeridos(c).filter((r) => !docs[r.id]).length;
  if (falt && ["contratado", "en_tramite"].includes(c.etapa)) out.push({ sev: "acc", orden: 3, id, t: `Faltan ${falt} documento${falt > 1 ? "s" : ""} del cliente`, d: nom });
  return out;
}

/* ---------- vistas: acceso ---------- */
function vistaLogin() {
  return `<section class="sheet login"><h1>Entrar</h1><p class="lead" style="margin-bottom:16px">Consola de la agencia.</p>
  <form id="login" class="stack" novalidate>
    <label class="f"><span>Correo</span><input type="email" id="lg-email" autocomplete="username" required></label>
    <label class="f"><span>Contraseña</span><input type="password" id="lg-pass" autocomplete="current-password" required></label>
    <div class="err" id="lg-err" role="alert"></div>
    <button class="primary" type="submit">Entrar</button></form></section>`;
}
function vistaSetup() {
  return `<section class="sheet login"><h1>Configura la agencia</h1><p class="lead" style="margin-bottom:16px">Crea la cuenta de administrador. Necesitas el código de configuración que te di.</p>
  <form id="setup" class="stack" novalidate>
    <label class="f"><span>Código de configuración</span><input type="text" id="st-codigo" autocomplete="off" required></label>
    <label class="f"><span>Tu nombre</span><input type="text" id="st-nombre" autocomplete="name"></label>
    <label class="f"><span>Correo</span><input type="email" id="st-email" autocomplete="username" required></label>
    <label class="f"><span>Contraseña (mínimo 10 caracteres)</span><input type="password" id="st-pass" autocomplete="new-password" required minlength="10"></label>
    <div class="err" id="st-err" role="alert"></div>
    <button class="primary" type="submit">Crear cuenta</button></form></section>`;
}

/* ---------- vistas: tablero y clientes ---------- */
function vistaTablero() {
  const cs = [...S.clientes.entries()];
  const activos = cs.filter(([, c]) => ["contratado", "en_tramite"].includes(c.etapa));
  let enCurso = 0, espera = 0; const al = [];
  cs.forEach(([id, c]) => {
    Object.values(c.tramites || {}).forEach((x) => {
      if (["reuniendo_documentos", "listo_para_firma", "presentado", "en_revision", "prevencion", "esperando_cliente"].includes(x.estatus)) enCurso++;
      if (x.estatus === "esperando_cliente") espera++;
    });
    al.push(...alertasDe(id, c));
  });
  al.sort((a, b) => a.orden - b.orden);
  const crit = al.filter((a) => a.sev === "crit").length;
  const prospectos = cs.filter(([, c]) => c.etapa === "prospecto");
  return `<div class="head"><div><h1>Tablero</h1><p class="lead">Lo que necesita atención hoy, ${fechaLarga(HOY())}.</p></div><a class="link" href="#nuevo">+ Nuevo diagnóstico</a></div>
  <div class="kpis">
    <div class="kpi"><div class="n">${activos.length}</div><div class="l">clientes con trámites activos</div></div>
    <div class="kpi"><div class="n">${enCurso}</div><div class="l">trámites en curso</div></div>
    <div class="kpi"><div class="n">${espera}</div><div class="l">esperando al cliente</div></div>
    <div class="kpi ${crit ? "alerta" : ""}"><div class="n">${crit}</div><div class="l">urgentes (vencidos o prevenciones)</div></div>
  </div>
  <div class="grid2">
    <section class="sheet"><div class="pad" style="border-bottom:1px solid var(--rule)"><h2>Alertas</h2></div>
      ${al.length ? `<ul class="alertas">${al.map((a) => `<li><span class="sev ${a.sev}"></span><div><div class="al-t">${esc(a.t)}</div><div class="al-d">${esc(a.d)}</div></div><a class="link" href="#c-${a.id}">Abrir</a></li>`).join("")}</ul>`
        : `<div class="vacio"><b>Nada pendiente</b>Aquí aparecen vencimientos a 60 días, prevenciones, documentos nuevos del portal y anuncios sin permiso.</div>`}
    </section>
    <section class="sheet"><div class="pad" style="border-bottom:1px solid var(--rule)"><h2>Prospectos por cerrar</h2></div>
      ${prospectos.length ? `<div class="tscroll"><table><thead><tr><th>Prospecto</th><th>Municipio</th><th style="text-align:right">Cotización</th></tr></thead><tbody>${prospectos.map(([id, c]) => {
        const { tr, h } = diagnosticar(CAT, c); const der = tr.reduce((s, t) => s + (costo(t, h) || 0), 0); const hon = (c.honorario || S.config.honorario_default || 0) * tr.length;
        return `<tr><td><a class="link" href="#c-${id}">${esc(c.nombre || "Sin nombre")}</a><div class="tr-meta">${tr.length} trámites</div></td><td>${esc(munNombre(c.municipio))}</td><td class="num">${mxn(der + hon)}</td></tr>`;
      }).join("")}</tbody></table></div>`
        : `<div class="vacio"><b>Sin prospectos</b>Haz un diagnóstico y guárdalo como prospecto para darle seguimiento.</div>`}
    </section>
  </div>`;
}

function vistaClientes() {
  const cs = [...S.clientes.entries()].sort((a, b) => String(b[1].actualizado || "").localeCompare(String(a[1].actualizado || "")));
  return `<div class="head"><div><h1>Clientes</h1><p class="lead">Cada cliente es un expediente: perfil, trámites, documentos, portal y cotización.</p></div><a class="link" href="#nuevo">+ Nuevo diagnóstico</a></div>
  <section class="sheet">${cs.length ? `<div class="tscroll"><table><thead><tr><th>Cliente</th><th>Etapa</th><th>Municipio</th><th>Otorgados</th><th>Docs pendientes</th><th>Portal</th></tr></thead><tbody>${cs.map(([id, c]) => {
    const { tr } = diagnosticar(CAT, c); const ts = c.tramites || {}; const ok = tr.filter((t) => ts[t.id]?.estatus === "otorgado").length;
    const falt = docsRequeridos(c).filter((r) => !(c.documentos || {})[r.id]).length;
    const et = (ETAPAS.find((e) => e[0] === c.etapa) || ETAPAS[0])[1];
    return `<tr><td><a class="link" href="#c-${id}">${esc(c.nombre || "Sin nombre")}</a><div class="tr-meta">${esc((c.giros || []).map((g) => GIROS.find((x) => x[0] === g)?.[1]).join(", "))}</div></td>
      <td><span class="pill ${c.etapa === "al_corriente" ? "ok" : c.etapa === "perdido" ? "" : "acc"}">${et}</span></td><td>${esc(munNombre(c.municipio))}</td>
      <td class="num">${ok} / ${tr.length}</td><td class="num">${falt}</td><td>${c.portal?.activo ? `<span class="pill ok">activo</span>` : `<span class="pill">sin liga</span>`}</td></tr>`;
  }).join("")}</tbody></table></div>`
    : `<div class="vacio"><b>Todavía no hay expedientes</b>Empieza con un <a class="link" href="#nuevo">diagnóstico</a>: captura cómo opera el consultorio y guárdalo como prospecto.</div>`}</section>`;
}

/* ---------- formulario de perfil ---------- */
function formPerfil(c, pref) {
  const ck = (k) => (c[k] ? "checked" : "");
  return `<form id="${pref}" class="stack" novalidate>
  <fieldset><legend>Cliente</legend><div class="fgrid">
    <label class="f full"><span>Nombre comercial</span><input type="text" id="${pref}-nombre" value="${esc(c.nombre)}" placeholder="Clínica o médico"></label>
    <label class="f"><span>Tipo de persona</span><select id="${pref}-tipo_persona"><option value="fisica" ${c.tipo_persona !== "moral" ? "selected" : ""}>Persona física</option><option value="moral" ${c.tipo_persona === "moral" ? "selected" : ""}>Persona moral</option></select></label>
    <label class="f"><span>RFC</span><input type="text" id="${pref}-rfc" value="${esc(c.rfc)}" autocomplete="off"></label>
    <label class="f full"><span>Razón social o nombre del titular</span><input type="text" id="${pref}-razon_social" value="${esc(c.razon_social)}"></label>
    <label class="f full"><span>Representante legal (si es persona moral)</span><input type="text" id="${pref}-representante" value="${esc(c.representante)}"></label>
    <label class="f"><span>Teléfono / WhatsApp</span><input type="tel" id="${pref}-telefono" value="${esc(c.telefono)}"></label>
    <label class="f"><span>Correo</span><input type="email" id="${pref}-correo" value="${esc(c.correo)}"></label>
    <label class="f full"><span>Domicilio del establecimiento</span><input type="text" id="${pref}-domicilio" value="${esc(c.domicilio)}"></label>
    <label class="f"><span>Municipio</span><select id="${pref}-municipio">${MUNICIPIOS.map(([v, l]) => `<option value="${v}" ${c.municipio === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="f"><span>m² construidos</span><input type="number" min="0" id="${pref}-m2_construidos" value="${esc(c.m2_construidos || "")}"></label>
  </div></fieldset>
  <fieldset><legend>Giro</legend>${GIROS.map(([g, l, s]) => `<label class="chk"><input type="checkbox" data-giro="${g}" id="${pref}-g-${g}" ${(c.giros || []).includes(g) ? "checked" : ""}><span>${l}${s ? `<small>${s}</small>` : ""}</span></label>`).join("")}</fieldset>
  <fieldset><legend>Cómo opera</legend>${HECHOS.map(([k, l, s]) => `<label class="chk"><input type="checkbox" data-hecho="${k}" id="${pref}-h-${k}" ${ck(k)}><span>${l}${s ? `<small>${s}</small>` : ""}</span></label>`).join("")}</fieldset>
  <fieldset><legend>Publicidad</legend>
    <label class="chk"><input type="checkbox" data-hecho="hace_publicidad" id="${pref}-h-hace_publicidad" ${ck("hace_publicidad")}><span>Anuncia sus servicios</span></label>
    <div class="inline">${MEDIOS.map(([m, l]) => `<label class="chk"><input type="checkbox" data-medio="${m}" id="${pref}-m-${m}" ${(c.publicidad_medios || []).includes(m) ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
    <label class="f"><span>Folio del permiso de publicidad (si ya lo tiene)</span><input type="text" id="${pref}-folio_publicidad" value="${esc(c.folio_publicidad)}"></label>
  </fieldset>
  <fieldset><legend>Responsable sanitario</legend><div class="fgrid">
    <label class="f full"><span>Nombre</span><input type="text" id="${pref}-resp_nombre" value="${esc(c.resp_nombre)}"></label>
    <label class="f"><span>Cédula profesional</span><input type="text" id="${pref}-resp_cedula" value="${esc(c.resp_cedula)}"></label>
    <label class="f"><span>Especialidad y cédula</span><input type="text" id="${pref}-resp_especialidad" value="${esc(c.resp_especialidad)}"></label>
  </div></fieldset>
  <fieldset><legend>Cotización</legend><div class="fgrid">
    <label class="f"><span>Honorario por trámite (MXN)</span><input type="number" min="0" step="100" id="${pref}-honorario" value="${esc(c.honorario || "")}" placeholder="${S.config.honorario_default ? S.config.honorario_default : "Define tu tarifa"}"></label>
  </div></fieldset>
  </form>`;
}
const CAMPOS_TXT = ["nombre", "tipo_persona", "rfc", "razon_social", "representante", "telefono", "correo", "domicilio", "municipio", "folio_publicidad", "resp_nombre", "resp_cedula", "resp_especialidad"];
function leerPerfil(pref) {
  const f = $("#" + pref); const p = {};
  CAMPOS_TXT.forEach((k) => (p[k] = ($("#" + pref + "-" + k)?.value || "").trim()));
  p.m2_construidos = parseFloat($("#" + pref + "-m2_construidos").value) || 0;
  p.honorario = parseFloat($("#" + pref + "-honorario").value) || 0;
  p.giros = [...f.querySelectorAll("[data-giro]:checked")].map((x) => x.dataset.giro);
  p.publicidad_medios = [...f.querySelectorAll("[data-medio]:checked")].map((x) => x.dataset.medio);
  f.querySelectorAll("[data-hecho]").forEach((x) => (p[x.dataset.hecho] = x.checked));
  return p;
}

function resumenDiag(p) {
  const { h, tr, hayMun } = diagnosticar(CAT, p);
  const der = tr.reduce((s, t) => s + (costo(t, h) || 0), 0), pend = tr.filter((t) => costo(t, h) == null).length;
  const hon = p.honorario || S.config.honorario_default || 0;
  const avisos = [];
  if (!p.giros.length) avisos.push(["warn", "Marca al menos un giro", "Sin giro solo se muestran trámites municipales generales."]);
  if (!hayMun) avisos.push(["crit", "Municipio sin catálogo", "Faltan licencia de funcionamiento, uso de suelo y protección civil de este municipio. Investígalo antes de cotizar."]);
  if (h.hace_cirugia && !p.giros.includes("clinica_cirugia")) avisos.push(["crit", "Hace cirugía sin estar registrado como clínica", "Necesita licencia 05-034-H y responsable sanitario con especialidad quirúrgica certificada. Es el hallazgo más común en verificaciones de COPRISEM."]);
  if (tr.some((t) => t.id === "cofepris_02_001")) avisos.push(["warn", "Ningún anuncio sale sin permiso", "Necesita permiso de publicidad por campaña antes de pautar en Meta o TikTok."]);
  return `<div class="kpis" style="margin:0">
    <div class="kpi"><div class="n">${tr.length}</div><div class="l">trámites aplican</div></div>
    <div class="kpi"><div class="n">${mxn(der)}</div><div class="l">derechos conocidos</div></div>
    <div class="kpi"><div class="n">${pend}</div><div class="l">costos por confirmar</div></div>
    <div class="kpi"><div class="n">${hon ? mxn(hon * tr.length) : "—"}</div><div class="l">honorarios de gestión</div></div></div>
  ${avisos.map(([k, t, d]) => `<div class="aviso ${k}"><b>${t}</b>${d}</div>`).join("")}
  <section class="sheet">${tr.length ? tr.map((t, i) => `<div class="tr-row"><div><div class="tr-nom">${String(i + 1).padStart(2, "0")} · ${esc(t.nombre)}</div><div class="tr-meta">${t.homoclave ? `<code>${esc(t.homoclave)}</code> · ` : ""}${esc(NIVEL_TXT[t.nivel])} · ${esc(t.autoridad)}</div></div><div class="tr-costo">${fmtCosto(costo(t, h))}</div></div>`).join("") : `<div class="vacio">Marca un giro para ver los trámites.</div>`}</section>`;
}

function vistaNuevo() {
  const b = S.borrador || { municipio: "metepec", tipo_persona: "fisica", giros: [] };
  return `<div class="head"><div><h1>Nuevo diagnóstico</h1><p class="lead">Captura cómo opera el consultorio. La lista de trámites se actualiza mientras escribes; guárdalo como prospecto para darle seguimiento.</p></div></div>
  <div class="grid-cli"><section class="sheet pad">${formPerfil(b, "nv")}<div class="btns" style="margin-top:16px"><button type="button" class="primary" id="nv-guardar">Guardar como prospecto</button><button type="button" id="nv-limpiar">Limpiar</button></div></section>
  <section class="stack" id="nv-res" aria-live="polite"></section></div>`;
}

function vistaAjustes() {
  const c = S.config, admin = S.yo?.rol === "admin";
  return `<div class="head"><div><h1>Ajustes</h1><p class="lead">Datos de la agencia para los documentos, equipo y tu contraseña.</p></div></div>
  <div class="grid2">
  <section class="sheet pad"><h2 style="margin-bottom:12px">Datos de la agencia</h2><form id="cfg" class="stack" novalidate><div class="fgrid">
    <label class="f full"><span>Razón social de la agencia</span><input type="text" id="cfg-razon_social" value="${esc(c.razon_social)}" ${admin ? "" : "disabled"}></label>
    <label class="f"><span>RFC</span><input type="text" id="cfg-rfc" value="${esc(c.rfc)}" ${admin ? "" : "disabled"}></label>
    <label class="f"><span>Representante legal</span><input type="text" id="cfg-representante" value="${esc(c.representante)}" ${admin ? "" : "disabled"}></label>
    <label class="f full"><span>Domicilio fiscal</span><input type="text" id="cfg-domicilio" value="${esc(c.domicilio)}" ${admin ? "" : "disabled"}></label>
    <label class="f full"><span>Gestor o gestores autorizados (aparecen en la carta poder)</span><input type="text" id="cfg-gestores" value="${esc(c.gestores)}" placeholder="Nombre completo; separa varios con coma" ${admin ? "" : "disabled"}></label>
    <label class="f"><span>Teléfono que ve el cliente en su portal</span><input type="tel" id="cfg-telefono" value="${esc(c.telefono)}" ${admin ? "" : "disabled"}></label>
    <label class="f"><span>Correo para datos personales</span><input type="email" id="cfg-correo_privacidad" value="${esc(c.correo_privacidad)}" ${admin ? "" : "disabled"}></label>
    <label class="f"><span>Honorario por trámite por defecto (MXN)</span><input type="number" min="0" step="100" id="cfg-honorario_default" value="${esc(c.honorario_default || "")}" ${admin ? "" : "disabled"}></label>
    <label class="f"><span>Anticipo (%)</span><input type="number" min="0" max="100" id="cfg-anticipo" value="${esc(c.anticipo ?? 50)}" ${admin ? "" : "disabled"}></label>
  </div>${admin ? `<div class="btns"><button type="button" class="primary" id="cfg-guardar">Guardar datos</button></div>` : `<p class="nota">Solo un administrador puede cambiar estos datos.</p>`}</form></section>
  <div class="stack">
    ${admin ? `<section class="sheet pad stack"><h2>Equipo</h2><div id="usuarios" class="nota">Cargando…</div>
      <form id="nu" class="stack" novalidate><h3>Agregar persona</h3><div class="fgrid">
        <label class="f"><span>Nombre</span><input type="text" id="nu-nombre"></label>
        <label class="f"><span>Correo</span><input type="email" id="nu-email" autocomplete="off"></label>
        <label class="f"><span>Contraseña temporal</span><input type="text" id="nu-pass" autocomplete="off" minlength="10"></label>
        <label class="f"><span>Rol</span><select id="nu-rol"><option value="gestor">Gestor</option><option value="admin">Administrador</option></select></label>
      </div><div class="btns"><button type="button" id="nu-agregar">Agregar</button></div><p class="nota" style="margin:0">Comparte la contraseña temporal en persona o por un medio seguro. El gestor puede cambiarla en Ajustes.</p></form></section>` : ""}
    <section class="sheet pad stack"><h2>Tu contraseña</h2><form id="pw" class="stack" novalidate>
      <label class="f"><span>Actual</span><input type="password" id="pw-actual" autocomplete="current-password"></label>
      <label class="f"><span>Nueva (mínimo 10 caracteres)</span><input type="password" id="pw-nueva" autocomplete="new-password"></label>
      <div class="btns"><button type="button" id="pw-guardar">Cambiar contraseña</button></div></form></section>
    <section class="sheet pad stack"><h2>Estado del sistema</h2><p class="nota" style="margin:0">Revisión automática de documentos del portal: <b>${S.estado.ia ? "activa" : "apagada (agrega una clave de IA en Railway para activarla)"}</b>.</p></section>
  </div></div>`;
}
async function pintarUsuarios() {
  const box = $("#usuarios"); if (!box) return;
  try {
    const us = await api("GET", "/api/usuarios");
    box.innerHTML = `<div class="tscroll"><table><thead><tr><th>Persona</th><th>Rol</th><th></th></tr></thead><tbody>${us.map((u) => `<tr><td>${esc(u.nombre || u.email)}<div class="tr-meta">${esc(u.email)}</div></td><td>${u.rol === "admin" ? "Administrador" : "Gestor"}${u.activo ? "" : ` <span class="pill">desactivado</span>`}</td><td>${u.id === S.yo.id ? "" : `<button type="button" class="link" data-u-activo="${u.id}" data-v="${u.activo ? "0" : "1"}">${u.activo ? "Desactivar" : "Reactivar"}</button>`}</td></tr>`).join("")}</tbody></table></div>`;
  } catch (e) { box.textContent = e.message; }
}

/* ---------- expediente ---------- */
function vistaCliente(id) {
  const c = S.clientes.get(id);
  if (!c) return `<div class="vacio"><b>No encontré este expediente</b>Puede que se haya borrado. <a class="link" href="#clientes">Ver clientes</a></div>`;
  return `<div class="head"><div><a class="link" href="#clientes">← Clientes</a><h1 id="cl-titulo">${esc(c.nombre || "Sin nombre")}</h1><p class="lead" id="cl-sub"></p></div>
    <label class="f etapa-sel"><span>Etapa</span><select id="cl-etapa">${ETAPAS.map(([v, l]) => `<option value="${v}" ${c.etapa === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
  <div id="cl-alertas" class="stack" style="margin-bottom:16px"></div>
  <div class="grid-cli">
    <section class="stack">
      <div class="sheet pad">${formPerfil(c, "pf")}<div class="btns" style="margin-top:16px"><button type="button" class="primary" id="pf-guardar">Guardar perfil</button><span class="nota" id="pf-estado"></span></div></div>
      <div class="sheet"><div class="sec"><h2>Historial</h2><ul class="bit" id="cl-bit" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px"></ul></div></div>
      ${S.yo?.rol === "admin" ? `<div class="sheet pad stack"><h3>Zona de riesgo</h3><p class="nota" style="margin:0">Borra el expediente, sus trámites y todos sus archivos.</p><div class="btns"><button type="button" class="danger" id="cl-borrar">Borrar expediente</button></div></div>` : ""}
    </section>
    <section class="stack">
      <div class="sheet"><div class="sec" id="cl-portal"></div></div>
      <div class="sheet"><div class="pad" style="border-bottom:1px solid var(--rule);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h2>Trámites</h2><span class="nota" id="cl-tr-res"></span></div><div id="cl-tramites"></div></div>
      <div class="sheet"><div class="sec"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h2>Documentos del cliente</h2><button type="button" class="link" id="cl-msg">Mensaje de pendientes</button></div><div id="cl-docs"></div><p class="nota" style="margin:0">Nunca subas aquí la e.firma (.key, .cer o contraseña). El titular inicia sesión él mismo en DIGIPRiS.</p></div></div>
      <div class="sheet"><div class="sec"><h2>Generar documentos</h2><div class="gen" id="cl-gen"></div><p class="nota" style="margin:0">Modelos para revisar con tu abogado antes de usarlos con clientes. Se descargan en Word con los datos del expediente.</p></div></div>
      <div class="sheet"><div class="sec"><h2>Cotización</h2><textarea class="cot" id="cl-cot" readonly aria-label="Cotización"></textarea><div class="btns"><button type="button" class="primary" id="cl-copiar">Copiar cotización</button></div></div></div>
      <div class="sheet"><div class="sec"><h2>Obligaciones continuas</h2><ul id="cl-obl" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:14px"></ul></div></div>
    </section>
  </div>`;
}

function pintarClienteDinamico(id) {
  const c = S.clientes.get(id); if (!c || !$("#cl-titulo")) return;
  const { h, tr, obl } = diagnosticar(CAT, c); const ts = c.tramites || {};
  $("#cl-titulo").textContent = c.nombre || "Sin nombre";
  $("#cl-sub").textContent = `${munNombre(c.municipio)} · ${(c.giros || []).map((g) => GIROS.find((x) => x[0] === g)?.[1]).join(", ") || "sin giro"}`;
  $("#cl-alertas").innerHTML = alertasDe(id, c).map((a) => `<div class="aviso ${a.sev}"><b>${esc(a.t)}</b>${esc(a.d)}</div>`).join("");
  // portal
  const p = c.portal || {};
  $("#cl-portal").innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h2>Portal del cliente</h2>${p.activo ? `<span class="pill ok">liga activa</span>` : `<span class="pill">sin liga activa</span>`}</div>
    <p class="nota" style="margin:0">El cliente entra con una liga personal, sin contraseña: ve sus documentos pendientes, los sube desde el celular, ve el avance de sus trámites y descarga sus permisos otorgados.${p.activo ? ` La liga vence el ${fecha(p.expira)}. Último acceso: ${p.ultimo_acceso ? fechaHora(p.ultimo_acceso) : "todavía no entra"}.` : ""}</p>
    <div class="btns"><button type="button" class="primary" id="pt-generar">${p.activo ? "Generar liga nueva" : "Generar liga"}</button>${p.activo ? `<button type="button" id="pt-revocar">Desactivar liga</button>` : ""}</div>
    ${p.activo ? `<p class="nota" style="margin:0">Por seguridad la liga solo se muestra al generarla. Si el cliente la perdió, genera una nueva: la anterior deja de funcionar.</p>` : ""}`;
  // trámites
  const fuera = Object.keys(ts).filter((k) => !tr.some((t) => t.id === k) && catById[k]);
  const lista = [...tr.map((t) => ({ t, fuera: false })), ...fuera.map((k) => ({ t: catById[k], fuera: true }))];
  $("#cl-tr-res").textContent = `${tr.filter((t) => ts[t.id]?.estatus === "otorgado").length} de ${tr.length} otorgados`;
  const cont = $("#cl-tramites");
  if (cont.contains(document.activeElement)) { cont.dataset.pend = "1"; }
  else {
    cont.innerHTML = lista.length ? lista.map(({ t, fuera }) => {
      const x = ts[t.id] || {}, tid = t.id, res = (c.resoluciones || {})[tid];
      return `<div class="tr-row ${fuera ? "fuera" : ""}" data-tid="${tid}">
      <div><div class="tr-nom">${esc(t.nombre)}</div><div class="tr-meta">${t.homoclave ? `<code>${esc(t.homoclave)}</code> · ` : ""}${esc(t.autoridad)}${t.recurrencia_meses ? ` · renueva cada ${t.recurrencia_meses} meses` : ""}</div>
        <div class="chips" style="margin-top:4px">${pillEstatus(x.estatus || "por_iniciar")}${fuera ? `<span class="pill warn">ya no aplica según el perfil</span>` : ""}${(t.requiere_usuario || []).map((u) => `<span class="pill">${ETIQ_USUARIO[u] || u}</span>`).join("")}${t.confianza !== "oficial" ? `<span class="pill warn">dato ${t.confianza.replace("_", " ")}</span>` : ""}</div>
        ${t.alerta ? `<div class="tr-meta" style="margin-top:4px;border-left:2px solid var(--warn);padding-left:8px;color:var(--ink)">${esc(t.alerta)}</div>` : ""}</div>
      <div class="tr-costo">${fmtCosto(costo(t, h))}</div>
      <div class="tr-ctrl">
        <label class="f"><span>Estatus</span><select data-k="estatus" id="tr-${tid}-estatus">${ESTATUS.map(([v, l]) => `<option value="${v}" ${(x.estatus || "por_iniciar") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="f"><span>Folio</span><input type="text" data-k="folio" id="tr-${tid}-folio" value="${esc(x.folio)}"></label>
        <label class="f"><span>Presentado</span><input type="date" data-k="presentado" id="tr-${tid}-presentado" value="${esc(x.presentado)}"></label>
        <label class="f"><span>Resuelto</span><input type="date" data-k="resuelto" id="tr-${tid}-resuelto" value="${esc(x.resuelto)}"></label>
        <label class="f"><span>Vence</span><input type="date" data-k="vence" id="tr-${tid}-vence" value="${esc(x.vence)}"></label>
        <label class="f" style="grid-column:1 / -1"><span>Notas</span><input type="text" data-k="notas" id="tr-${tid}-notas" value="${esc(x.notas)}" placeholder="Qué falta, con quién se habló, prevención…"></label>
        ${x.estatus === "otorgado" ? `<div style="grid-column:1 / -1" class="btns">${res ? `<span class="pill ok">permiso cargado</span><a class="link" href="/api/documentos/${res.id}/archivo" target="_blank" rel="noopener">Ver permiso</a><button type="button" class="link" data-res-quitar="${tid}">Quitar</button>` : `<label class="link" style="cursor:pointer">Subir permiso otorgado (el cliente lo verá en su portal)<input type="file" data-res-subir="${tid}" id="res-${tid}" hidden accept="application/pdf,image/*"></label>`}</div>` : ""}
      </div></div>`;
    }).join("") : `<div class="vacio">Marca un giro en el perfil para generar los trámites.</div>`;
    delete cont.dataset.pend;
  }
  // documentos
  const docs = c.documentos || {};
  $("#cl-docs").innerHTML = docsRequeridos(c).map((r) => {
    const d = docs[r.id];
    const origen = d ? (d.origen === "portal" ? "subido por el cliente" : d.con_archivo ? "subido por la agencia" : "entregado en físico") : "";
    return `<div class="doc-row"><div><div class="n">${esc(r.nombre)}</div><div class="s">${d ? `Recibido ${fecha(d.fecha)} · ${origen}${d.archivo ? ` · ${esc(d.archivo)}` : ""}` : "Pendiente"}${d?.ia_nota ? `<br>Revisión automática: ${esc(d.ia_nota)}` : ""}</div></div>
      <div class="btns">${d ? `<span class="pill ok">recibido</span>${d.con_archivo ? `<a class="link" href="/api/documentos/${d.id}/archivo" target="_blank" rel="noopener">Ver</a>` : ""}<button type="button" class="link" data-doc-quitar="${r.id}">Quitar</button>`
      : `<label class="link" style="cursor:pointer">Subir<input type="file" data-doc-subir="${r.id}" id="up-${r.id}" hidden accept="image/*,application/pdf"></label><button type="button" class="link" data-doc-marcar="${r.id}">Recibido en físico</button>`}</div></div>`;
  }).join("");
  $("#cl-gen").innerHTML = documentosGenerables(CAT, c).map((g) => `<button type="button" data-gen="${g.id}"><span>${g.nombre}</span><small>${g.desc}</small></button>`).join("");
  $("#cl-cot").value = textoCotizacion(c);
  $("#cl-obl").innerHTML = obl.map((o) => `<li>${esc(o.nombre)}</li>`).join("");
}
async function pintarBitacora(id) {
  const ul = $("#cl-bit"); if (!ul) return;
  try {
    const b = await api("GET", `/api/clientes/${id}/bitacora`);
    ul.innerHTML = b.length ? b.slice(0, 30).map((x) => `<li><b>${esc(x.actor === "portal" ? "Cliente (portal)" : x.actor.replace("agencia:", ""))}</b> ${esc(x.accion)}${x.detalle?.tipo ? ` · ${esc(catById[x.detalle.tipo]?.nombre || x.detalle.tipo)}` : ""} — ${fechaHora(x.creado)}</li>`).join("") : `<li>Sin movimientos todavía.</li>`;
  } catch { ul.innerHTML = ""; }
}

function textoCotizacion(c) {
  const { h, tr, hayMun } = diagnosticar(CAT, c);
  const der = tr.reduce((s, t) => s + (costo(t, h) || 0), 0), pend = tr.filter((t) => costo(t, h) == null).length;
  const hon = c.honorario || S.config.honorario_default || 0, honT = hon * tr.length, ant = S.config.anticipo ?? 50;
  const pasos = new Set(tr.flatMap((t) => t.requiere_usuario || []));
  return [`Diagnóstico regulatorio — ${c.nombre || "Prospecto"}`, `Municipio: ${munNombre(c.municipio)}, Estado de México`, "", `Trámites que aplican (${tr.length}):`,
    ...tr.map((t, k) => { const x = costo(t, h); return `${k + 1}. ${t.nombre}${t.homoclave ? " (" + t.homoclave + ")" : ""} — derechos: ${x == null ? "por confirmar" : x === 0 ? "sin costo" : mxn(x)}`; }), "",
    `Derechos oficiales conocidos: ${mxn(der)}${pend ? ` (+${pend} por confirmar)` : ""}. Se pagan directamente a la autoridad.`,
    hon ? `Honorarios de gestión: ${mxn(honT)} (${tr.length} × ${mxn(hon)}). Anticipo ${ant}%: ${mxn((honT * ant) / 100)}.` : "Honorarios de gestión: por definir.",
    hon ? `Total estimado: ${mxn(der + honT)}` : "", "",
    "Lo que el titular hará personalmente: " + ([...pasos].map((u) => ETIQ_USUARIO[u] || u).join(", ") || "—") + ".",
    "La agencia actúa con carta poder del titular y no garantiza la resolución de la autoridad.",
    hayMun ? "" : "\nNota: la capa municipal de esta ubicación está en investigación; la lista puede crecer."].filter((x) => x !== "").join("\n");
}

function mensajePendientes(c) {
  const docs = c.documentos || {}; const f = docsRequeridos(c).filter((r) => !docs[r.id]);
  const { tr } = diagnosticar(CAT, c); const esp = tr.filter((t) => (c.tramites || {})[t.id]?.estatus === "esperando_cliente");
  return [`Hola${c.razon_social ? ` ${c.razon_social.split(" ")[0]}` : ""}, te escribimos de la agencia que lleva los permisos de ${c.nombre || "tu consultorio"}.`, "",
    f.length ? "Para avanzar necesitamos estos documentos (foto o PDF legible):" : "Ya tenemos todos tus documentos, gracias.", ...f.map((r) => `• ${r.nombre}`),
    esp.length ? `\nTambién necesitamos tu apoyo con:\n${esp.map((t) => `• ${t.nombre}${c.tramites[t.id].notas ? ` — ${c.tramites[t.id].notas}` : ""}`).join("\n")}` : "",
    c.portal?.activo ? "\nPuedes subirlos desde tu portal con la liga que te enviamos." : "",
    "", "Por seguridad, nunca nos envíes tu e.firma ni su contraseña: cuando un trámite la requiera, lo hacemos juntos y tú la capturas."].filter((x) => x !== "").join("\n");
}

/* ---------- ruteo ---------- */
function ruta() {
  const h = (location.hash || "#tablero").slice(1);
  if (h.startsWith("c-")) { S.route = "cliente"; S.cid = h.slice(2); }
  else { S.route = ["tablero", "clientes", "nuevo", "ajustes"].includes(h) ? h : "tablero"; S.cid = null; }
  render(true);
}
window.addEventListener("hashchange", ruta);

function setNav() {
  const activo = S.route === "cliente" ? "clientes" : S.route;
  document.querySelectorAll("#nav a").forEach((a) => (a.dataset.r === activo ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  $("#nav").hidden = !S.yo;
  $("#usr").innerHTML = S.yo ? `<span>${esc(S.yo.nombre || S.yo.email)}</span><button type="button" id="salir">Salir</button>` : "";
}

function render(completo) {
  setNav();
  const main = $("#main");
  if (!S.yo) {
    if (completo || (!$("#login") && !$("#setup"))) main.innerHTML = S.estado.configurado === false ? vistaSetup() : vistaLogin();
    return;
  }
  if (S.route === "cliente") {
    if (completo || $("#pf")?.dataset.cid !== S.cid) { main.innerHTML = vistaCliente(S.cid); const f = $("#pf"); if (f) f.dataset.cid = S.cid; pintarBitacora(S.cid); }
    pintarClienteDinamico(S.cid); return;
  }
  if (S.route === "nuevo") { if (completo || !$("#nv")) main.innerHTML = vistaNuevo(); $("#nv-res").innerHTML = resumenDiag(leerPerfil("nv")); return; }
  if (S.route === "ajustes") { if (completo || !$("#cfg")) { main.innerHTML = vistaAjustes(); pintarUsuarios(); } return; }
  main.innerHTML = S.route === "clientes" ? vistaClientes() : vistaTablero();
}

/* ---------- eventos ---------- */
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.target.id === "login") {
    $("#lg-err").textContent = "";
    try { await api("POST", "/api/login", { email: $("#lg-email").value, password: $("#lg-pass").value }); await arrancarSesion(); }
    catch (err) { $("#lg-err").textContent = err.message; }
  }
  if (e.target.id === "setup") {
    $("#st-err").textContent = "";
    try { await api("POST", "/api/setup", { codigo: $("#st-codigo").value.trim(), nombre: $("#st-nombre").value, email: $("#st-email").value, password: $("#st-pass").value }); S.estado.configurado = true; await arrancarSesion(); }
    catch (err) { $("#st-err").textContent = err.message; }
  }
});

document.addEventListener("input", (e) => {
  if (e.target.closest("#nv")) { S.borrador = leerPerfil("nv"); $("#nv-res").innerHTML = resumenDiag(S.borrador); }
  if (e.target.closest("#pf")) $("#pf-estado").textContent = "Cambios sin guardar";
});

async function guardarCliente(id, patch, msg = "Guardado") {
  try { ponerCliente(await api("PATCH", `/api/clientes/${id}`, patch)); toast(msg); render(false); pintarBitacora(id); return true; }
  catch (e) { toast(e.message); return false; }
}
async function subirArchivo(id, file, tipo, clase) {
  if (file.size > 15 * 1024 * 1024) { toast("El archivo pasa de 15 MB. Comprime el PDF o toma la foto de nuevo."); return; }
  const fd = new FormData(); fd.append("tipo", tipo); fd.append("clase", clase); fd.append("archivo", file);
  toast("Subiendo…");
  try { ponerCliente(await api("POST", `/api/clientes/${id}/documentos`, fd)); toast(clase === "resolucion" ? "Permiso cargado; el cliente ya lo ve en su portal" : "Documento recibido"); render(false); pintarBitacora(id); }
  catch (e) { toast(e.message); }
}

document.addEventListener("change", async (e) => {
  const t = e.target;
  const row = t.closest(".tr-row[data-tid]");
  if (row && t.dataset.k && S.route === "cliente") {
    const c = S.clientes.get(S.cid); const tid = row.dataset.tid; const ts = { ...(c.tramites || {}) }; const x = { ...(ts[tid] || { estatus: "por_iniciar" }) };
    x[t.dataset.k] = t.value;
    const cat = catById[tid];
    if (t.dataset.k === "resuelto" && t.value && cat?.recurrencia_meses && !x.vence) x.vence = addMonths(t.value, cat.recurrencia_meses);
    if (t.dataset.k === "estatus" && t.value === "otorgado" && !x.resuelto) { x.resuelto = hoyISO(); if (cat?.recurrencia_meses && !x.vence) x.vence = addMonths(x.resuelto, cat.recurrencia_meses); }
    ts[tid] = x; const patch = { tramites: ts };
    const tr = diagnosticar(CAT, c).tr; const todos = tr.length && tr.every((q) => ["otorgado", "no_aplica"].includes((ts[q.id] || {}).estatus));
    if (todos && c.etapa !== "al_corriente") patch.etapa = "al_corriente";
    else if (!todos && ["prospecto", "contratado"].includes(c.etapa) && ["presentado", "en_revision", "prevencion", "otorgado"].includes(x.estatus)) patch.etapa = "en_tramite";
    const ok = await guardarCliente(S.cid, patch, patch.etapa === "al_corriente" ? "Guardado: cliente al corriente" : "Guardado");
    if (ok && t.dataset.k === "estatus") { const el = $("#cl-etapa"); if (el) el.value = S.clientes.get(S.cid).etapa; const cont = $("#cl-tramites"); if (cont) { cont.dataset.pend = ""; t.blur(); pintarClienteDinamico(S.cid); } }
    return;
  }
  if (t.id === "cl-etapa") { await guardarCliente(S.cid, { etapa: t.value }, "Etapa actualizada"); return; }
  if (t.dataset.docSubir && t.files?.[0]) { await subirArchivo(S.cid, t.files[0], t.dataset.docSubir, "requisito"); return; }
  if (t.dataset.resSubir && t.files?.[0]) { await subirArchivo(S.cid, t.files[0], t.dataset.resSubir, "resolucion"); return; }
});
document.addEventListener("focusout", (e) => { const cont = $("#cl-tramites"); if (cont && cont.dataset.pend && !cont.contains(e.relatedTarget)) setTimeout(() => pintarClienteDinamico(S.cid), 0); });

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.id === "salir") { await api("POST", "/api/logout").catch(() => {}); S.yo = null; S.clientes.clear(); render(true); return; }
  if (t.id === "nv-limpiar") { S.borrador = null; render(true); return; }
  if (t.id === "nv-guardar") {
    const p = leerPerfil("nv"); if (!p.nombre) { toast("Escribe el nombre del prospecto"); $("#nv-nombre").focus(); return; }
    t.disabled = true;
    try { const c = ponerCliente(await api("POST", "/api/clientes", p)); S.borrador = null; toast("Prospecto guardado"); location.hash = "c-" + c.id; }
    catch (err) { toast(err.message); }
    t.disabled = false; return;
  }
  if (t.id === "pf-guardar") {
    const p = leerPerfil("pf"); const c = S.clientes.get(S.cid); const ts = { ...(c.tramites || {}) };
    diagnosticar(CAT, p).tr.forEach((q) => { if (!ts[q.id]) ts[q.id] = { estatus: "por_iniciar" }; });
    if (await guardarCliente(S.cid, { ...p, tramites: ts }, "Perfil guardado")) $("#pf-estado").textContent = "Guardado";
    return;
  }
  if (t.id === "cfg-guardar") {
    const d = {}; ["razon_social", "rfc", "representante", "domicilio", "gestores", "correo_privacidad", "telefono"].forEach((k) => (d[k] = $("#cfg-" + k).value.trim()));
    d.honorario_default = parseFloat($("#cfg-honorario_default").value) || 0; d.anticipo = parseFloat($("#cfg-anticipo").value) || 0;
    try { await api("PUT", "/api/config", d); S.config = { ...S.config, ...d }; toast("Datos guardados"); } catch (err) { toast(err.message); }
    return;
  }
  if (t.id === "nu-agregar") {
    try { await api("POST", "/api/usuarios", { nombre: $("#nu-nombre").value, email: $("#nu-email").value, password: $("#nu-pass").value, rol: $("#nu-rol").value }); toast("Persona agregada"); ["nu-nombre", "nu-email", "nu-pass"].forEach((k) => ($("#" + k).value = "")); pintarUsuarios(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (t.dataset.uActivo) { try { await api("PATCH", `/api/usuarios/${t.dataset.uActivo}`, { activo: t.dataset.v === "1" }); pintarUsuarios(); } catch (err) { toast(err.message); } return; }
  if (t.id === "pw-guardar") {
    try { await api("POST", "/api/cambiar-password", { actual: $("#pw-actual").value, nueva: $("#pw-nueva").value }); toast("Contraseña cambiada"); $("#pw-actual").value = $("#pw-nueva").value = ""; }
    catch (err) { toast(err.message); }
    return;
  }
  if (t.id === "cl-copiar") { copiar($("#cl-cot").value, $("#cl-cot")); return; }
  if (t.id === "cl-msg") {
    const m = modal(`<h2>Mensaje para el cliente</h2><p class="nota" style="margin:0">Cópialo y envíalo por WhatsApp o correo.</p><textarea readonly id="msg-txt">${esc(mensajePendientes(S.clientes.get(S.cid)))}</textarea><div class="btns"><button type="button" class="primary" id="msg-copiar">Copiar mensaje</button><button type="button" data-cerrar>Cerrar</button></div>`);
    m.querySelector("#msg-copiar").addEventListener("click", () => copiar(m.querySelector("#msg-txt").value, m.querySelector("#msg-txt"))); return;
  }
  if (t.id === "pt-generar") {
    const c = S.clientes.get(S.cid);
    if (c.portal?.activo) {
      const m = modal(`<h2>¿Generar una liga nueva?</h2><p style="margin:0">La liga que tiene ${esc(c.nombre || "el cliente")} dejará de funcionar.</p><div class="btns"><button type="button" class="primary" id="pt-conf">Generar liga nueva</button><button type="button" data-cerrar>Cancelar</button></div>`);
      m.querySelector("#pt-conf").addEventListener("click", () => generarLiga(c)); return;
    }
    generarLiga(c); return;
  }
  if (t.id === "pt-revocar") { try { ponerCliente(await api("DELETE", `/api/clientes/${S.cid}/portal`)); toast("Liga desactivada"); render(false); pintarBitacora(S.cid); } catch (err) { toast(err.message); } return; }
  if (t.dataset.gen) {
    const c = { ...S.clientes.get(S.cid), ...leerPerfil("pf") }; t.disabled = true;
    try { const d = contenidoDoc(CAT, t.dataset.gen, c, S.config, HOY()); descargarBlob(await construirDocx(d), d.archivo); toast("Documento descargado"); }
    catch (err) { toast(err.message || "No se pudo generar el documento"); }
    t.disabled = false; return;
  }
  if (t.dataset.docMarcar) { const fd = new FormData(); fd.append("tipo", t.dataset.docMarcar); fd.append("clase", "requisito"); try { ponerCliente(await api("POST", `/api/clientes/${S.cid}/documentos`, fd)); toast("Marcado como recibido"); render(false); pintarBitacora(S.cid); } catch (err) { toast(err.message); } return; }
  if (t.dataset.docQuitar || t.dataset.resQuitar) {
    const tipo = t.dataset.docQuitar || t.dataset.resQuitar, clase = t.dataset.resQuitar ? "resolucion" : "requisito";
    const m = modal(`<h2>¿Quitar este documento?</h2><p style="margin:0">Se borra el archivo guardado${clase === "resolucion" ? " y el cliente deja de verlo en su portal" : " y vuelve a quedar como pendiente"}.</p><div class="btns"><button type="button" class="danger" id="dq-conf">Quitar</button><button type="button" data-cerrar>Cancelar</button></div>`);
    m.querySelector("#dq-conf").addEventListener("click", async () => { cerrarModal(); try { ponerCliente(await api("DELETE", `/api/clientes/${S.cid}/documentos/${tipo}?clase=${clase}`)); toast("Documento quitado"); render(false); pintarBitacora(S.cid); } catch (err) { toast(err.message); } });
    return;
  }
  if (t.id === "cl-borrar") {
    const c = S.clientes.get(S.cid);
    const m = modal(`<h2>¿Borrar el expediente de ${esc(c.nombre || "este cliente")}?</h2><p style="margin:0">Se borran el perfil, los trámites, los archivos subidos y la liga del portal. No se puede deshacer.</p><div class="btns"><button type="button" class="danger" id="conf-borrar">Sí, borrar</button><button type="button" data-cerrar>Cancelar</button></div>`);
    m.querySelector("#conf-borrar").addEventListener("click", async () => { try { await api("DELETE", `/api/clientes/${S.cid}`); S.clientes.delete(S.cid); cerrarModal(); toast("Expediente borrado"); location.hash = "clientes"; } catch (err) { toast(err.message); } });
  }
});

async function generarLiga(c) {
  try {
    const r = await api("POST", `/api/clientes/${c.id}/portal`); ponerCliente(r.cliente); render(false); pintarBitacora(c.id);
    const msg = `Hola${c.razon_social ? ` ${c.razon_social.split(" ")[0]}` : ""}, este es tu portal para los permisos de ${c.nombre || "tu consultorio"}. Ahí puedes subir tus documentos desde el celular y ver el avance de cada trámite:\n\n${r.url}\n\nLa liga es personal; no la compartas. Vence en ${r.dias} días.`;
    const m = modal(`<h2>Liga del portal</h2><p class="nota" style="margin:0">Mándala por WhatsApp. Solo se muestra ahora; si se pierde, genera una nueva.</p><div class="url-box" id="pt-url">${esc(r.url)}</div><label class="f"><span>Mensaje listo para enviar</span><textarea id="pt-msg" readonly style="min-height:140px">${esc(msg)}</textarea></label><div class="btns"><button type="button" class="primary" id="pt-copiar-msg">Copiar mensaje</button><button type="button" id="pt-copiar-url">Copiar solo la liga</button><button type="button" data-cerrar>Cerrar</button></div>`);
    m.querySelector("#pt-copiar-msg").addEventListener("click", () => copiar(msg, m.querySelector("#pt-msg")));
    m.querySelector("#pt-copiar-url").addEventListener("click", () => copiar(r.url));
  } catch (err) { toast(err.message); }
}

/* ---------- arranque ---------- */
async function cargarDatos() {
  const [cs, cfg] = await Promise.all([api("GET", "/api/clientes"), api("GET", "/api/config")]);
  S.clientes = new Map(cs.map((c) => [c.id, c])); S.config = cfg || {};
}
async function arrancarSesion() {
  const r = await api("GET", "/api/sesion");
  S.yo = r.usuario;
  if (!S.yo) { render(true); return; }
  await cargarDatos();
  ruta();
}
(async function () {
  try {
    [CAT, S.estado] = await Promise.all([fetch("/api/catalogo").then((r) => r.json()), fetch("/api/estado").then((r) => r.json())]);
    catById = Object.fromEntries(CAT.tramites.map((t) => [t.id, t]));
  } catch { $("#main").innerHTML = `<div class="aviso crit"><b>No se pudo cargar la agencia</b>Revisa tu conexión y recarga la página.</div>`; return; }
  try { await arrancarSesion(); } catch { render(true); }
  // Refresca en segundo plano para ver lo que suben los clientes por el portal.
  setInterval(async () => {
    if (!S.yo || document.hidden) return;
    try { await cargarDatos(); if (S.route === "tablero" || S.route === "clientes") render(false); else if (S.route === "cliente") pintarClienteDinamico(S.cid); } catch {}
  }, 60000);
})();
