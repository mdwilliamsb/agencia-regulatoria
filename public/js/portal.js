// Portal del cliente: entra con su liga personal, sube documentos, ve avance y descarga permisos.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fecha = (iso) => (iso ? new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" }) : "");
const TOKEN = (location.hash || "").slice(1);

const ESTADO_CLIENTE = {
  por_iniciar: ["Por iniciar", ""],
  reuniendo_documentos: ["Juntando documentos", "acc"],
  esperando_cliente: ["Necesitamos algo de ti", "warn"],
  listo_para_firma: ["Listo para tu firma", "warn"],
  presentado: ["Presentado ante la autoridad", "acc"],
  en_revision: ["En revisión de la autoridad", "acc"],
  prevencion: ["La autoridad pidió información; ya lo estamos atendiendo", "acc"],
  otorgado: ["Otorgado", "ok"],
  rechazado: ["Rechazado; te vamos a contactar", "crit"],
};

let toastT;
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3500); }

function invalida() {
  $("#titulo").textContent = "Esta liga ya no funciona";
  $("#sub").textContent = "";
  $("#main").innerHTML = `<div class="aviso"><b>La liga venció o fue reemplazada.</b><br>Pide una nueva a la agencia que lleva tus permisos.</div>`;
}

async function post(ruta, cuerpo) {
  const opt = { method: "POST" };
  if (cuerpo instanceof FormData) opt.body = cuerpo;
  else { opt.headers = { "content-type": "application/json" }; opt.body = JSON.stringify(cuerpo); }
  return fetch(ruta, opt);
}

async function cargar() {
  if (!/^[a-f0-9]{64}$/.test(TOKEN)) return invalida();
  let r;
  try { r = await post("/api/portal/cargar", { token: TOKEN }); }
  catch { $("#main").innerHTML = `<div class="aviso">Sin conexión. Revisa tu internet y vuelve a abrir la liga.</div>`; return; }
  if (r.status === 401) return invalida();
  if (!r.ok) { $("#main").innerHTML = `<div class="aviso">No pudimos abrir tu portal. Inténtalo en unos minutos.</div>`; return; }
  pintar(await r.json());
}

function pintar(d) {
  document.title = `Permisos · ${d.cliente.nombre}`;
  $("#ag").textContent = d.agencia.nombre;
  $("#titulo").textContent = d.cliente.nombre || "Tu consultorio";
  $("#sub").textContent = `Permisos de tu establecimiento en ${d.cliente.municipio}`;
  const pend = d.requisitos.filter((x) => !x.recibido), ok = d.requisitos.filter((x) => x.recibido);
  const pct = d.requisitos.length ? Math.round((ok.length / d.requisitos.length) * 100) : 0;
  const necesita = d.tramites.filter((t) => ["esperando_cliente", "listo_para_firma"].includes(t.estatus));
  const permisos = d.tramites.filter((t) => t.permiso);

  $("#main").innerHTML = `
  ${necesita.length ? `<div class="aviso"><b>Necesitamos tu apoyo</b><br>${necesita.map((t) => esc(t.nombre)).join("<br>")}<br>Te contactaremos, o escríbenos${d.agencia.telefono ? ` al ${esc(d.agencia.telefono)}` : ""}.</div>` : ""}
  <section class="card">
    <div class="card-h"><h2>Tus documentos</h2><span class="n">${ok.length} de ${d.requisitos.length} entregados</span></div>
    <div class="prog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Documentos entregados"><i style="width:${pct}%"></i></div>
    ${pend.length ? pend.map((x) => `<div class="item" data-tipo="${esc(x.id)}">
      <div class="t">${esc(x.nombre)}</div>${x.ayuda ? `<div class="a">${esc(x.ayuda)}</div>` : ""}
      <div class="row"><label class="subir" id="lb-${esc(x.id)}">Subir foto o PDF<input type="file" accept="image/*,application/pdf" data-subir="${esc(x.id)}" aria-label="Subir ${esc(x.nombre)}"></label></div>
      <div class="res" id="res-${esc(x.id)}"></div></div>`).join("")
      : `<div class="vacio">Ya entregaste todos tus documentos. Gracias.</div>`}
    ${ok.length ? `<div class="item"><div class="a"><b>Ya recibidos:</b> ${ok.map((x) => esc(x.nombre)).join(" · ")}</div></div>` : ""}
  </section>
  <p class="nota">Toma la foto con buena luz, sin cortes y de ambos lados cuando aplique. Nunca nos envíes tu e.firma ni su contraseña.</p>
  <section class="card">
    <div class="card-h"><h2>Avance de tus trámites</h2><span class="n">${d.tramites.filter((t) => t.estatus === "otorgado").length} de ${d.tramites.length} otorgados</span></div>
    ${d.tramites.map((t) => { const [txt, cls] = ESTADO_CLIENTE[t.estatus] || ESTADO_CLIENTE.por_iniciar;
      return `<div class="item"><div class="t">${esc(t.nombre)}</div><div class="a">${esc(t.autoridad)}</div><div class="row"><span class="pill ${cls}">${txt}</span>${t.vence ? `<span class="a">Vence el ${fecha(t.vence)}</span>` : ""}</div></div>`; }).join("")}
  </section>
  ${permisos.length ? `<section class="card"><div class="card-h"><h2>Tus permisos</h2></div>${permisos.map((t) => `<div class="item"><div class="t">${esc(t.nombre)}</div><div class="row"><button type="button" class="sec" data-permiso="${esc(t.permiso)}" data-nombre="${esc(t.nombre)}">Descargar</button>${t.vence ? `<span class="a">Vence el ${fecha(t.vence)}</span>` : ""}</div></div>`).join("")}</section>` : ""}
  <p class="nota">Esta liga es personal y vence el ${fecha(d.expira)}.${d.agencia.telefono ? ` Dudas: ${esc(d.agencia.telefono)}.` : ""}</p>`;
}

document.addEventListener("change", async (e) => {
  const inp = e.target; const tipo = inp.dataset?.subir; if (!tipo || !inp.files?.[0]) return;
  const f = inp.files[0], lb = $("#lb-" + tipo), res = $("#res-" + tipo);
  if (f.size > 15 * 1024 * 1024) { res.innerHTML = `<div class="msg crit">El archivo pasa de 15 MB. Toma la foto de nuevo o comprime el PDF.</div>`; inp.value = ""; return; }
  lb.setAttribute("aria-busy", "true"); lb.firstChild.textContent = "Revisando…"; res.innerHTML = "";
  const fd = new FormData(); fd.append("token", TOKEN); fd.append("tipo", tipo); fd.append("archivo", f);
  try {
    const r = await post("/api/portal/subir", fd);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) return invalida();
    if (!r.ok) { res.innerHTML = `<div class="msg crit">${esc(j.error || "No se pudo subir. Inténtalo de nuevo.")}</div>`; }
    else { toast("Documento recibido. Gracias."); await cargar(); return; }
  } catch { res.innerHTML = `<div class="msg crit">Sin conexión. Inténtalo de nuevo.</div>`; }
  lb.removeAttribute("aria-busy"); lb.firstChild.textContent = "Subir foto o PDF"; inp.value = "";
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-permiso]"); if (!b) return;
  b.disabled = true;
  try {
    const r = await post("/api/portal/permiso", { token: TOKEN, doc: b.dataset.permiso });
    if (r.status === 401) return invalida();
    if (!r.ok) throw new Error();
    const blob = await r.blob();
    const ext = blob.type === "application/pdf" ? "pdf" : (blob.type.split("/")[1] || "jpg");
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `${b.dataset.nombre}.${ext}`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch { toast("No se pudo descargar. Inténtalo de nuevo."); }
  b.disabled = false;
});

cargar();
