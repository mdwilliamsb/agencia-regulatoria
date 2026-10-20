import express from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, migrar, registrar } from "./src/db.js";
import { guardar, leer, borrar, modoAlmacenamiento } from "./src/storage.js";
import { revisarDocumento, iaDisponible } from "./src/ia.js";
import { diagnosticar, docsRequeridos, ESTATUS, munNombre } from "./public/js/reglas.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CAT = JSON.parse(fs.readFileSync(path.join(DIR, "catalogo_tramites.json"), "utf8"));
const catById = Object.fromEntries(CAT.tramites.map((t) => [t.id, t]));
const PROD = process.env.NODE_ENV === "production";
const MAX_BYTES = 15 * 1024 * 1024;
const MIME_OK = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const DIAS_PORTAL = 45;
const AUTORIDAD_CLIENTE = { municipal: "Ayuntamiento", estatal: "Gobierno del Estado de México", estatal_descentralizado: "Autoridad sanitaria del estado (COPRISEM)", federal: "Autoridad federal (COFEPRIS o SEMARNAT)" };

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const token = () => crypto.randomBytes(32).toString("hex");
const log = (nivel, msg, meta = {}) => console.log(JSON.stringify({ nivel, msg, ts: new Date().toISOString(), ...meta }));

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (PROD) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});
app.use(express.json({ limit: "1mb" }));
const subir = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

/* ---------- límites de frecuencia simples en memoria ---------- */
const cubetas = new Map();
function limitar(clave, max, ventanaMs) {
  const ahora = Date.now();
  const c = cubetas.get(clave) || { n: 0, desde: ahora };
  if (ahora - c.desde > ventanaMs) { c.n = 0; c.desde = ahora; }
  c.n++; cubetas.set(clave, c);
  return c.n <= max;
}
setInterval(() => { const lim = Date.now() - 3600000; for (const [k, v] of cubetas) if (v.desde < lim) cubetas.delete(k); }, 600000).unref();

/* ---------- sesiones de la agencia ---------- */
function leerCookie(req, nombre) {
  const c = req.headers.cookie || "";
  const m = c.split(/;\s*/).find((x) => x.startsWith(nombre + "="));
  return m ? decodeURIComponent(m.slice(nombre.length + 1)) : null;
}
async function usuarioDe(req) {
  const t = leerCookie(req, "sesion");
  if (!t || !/^[a-f0-9]{64}$/.test(t)) return null;
  const { rows } = await q(
    `select u.id, u.email, u.nombre, u.rol from sesiones s join usuarios u on u.id = s.usuario_id
     where s.token_hash = $1 and s.expira > now() and u.activo`, [sha(t)]);
  return rows[0] || null;
}
const auth = (rol) => async (req, res, next) => {
  try {
    const u = await usuarioDe(req);
    if (!u) return res.status(401).json({ error: "Tu sesión terminó. Vuelve a entrar." });
    if (rol === "admin" && u.rol !== "admin") return res.status(403).json({ error: "Solo un administrador puede hacer esto." });
    // Protección contra peticiones de otros sitios: las escrituras deben traer este encabezado.
    if (req.method !== "GET" && req.get("x-agencia") !== "1") return res.status(403).json({ error: "Petición no permitida." });
    req.usuario = u; next();
  } catch (e) { next(e); }
};
function ponerSesion(res, t) {
  res.setHeader("Set-Cookie", `sesion=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}${PROD ? "; Secure" : ""}`);
}

/* ---------- utilidades de clientes ---------- */
async function clienteCompleto(id) {
  const { rows } = await q("select * from clientes where id = $1", [id]);
  if (!rows[0]) return null;
  const { rows: docs } = await q("select id, clase, tipo, archivo, mime, tamano, storage_key, origen, ia_nota, creado from documentos where cliente_id = $1 order by creado", [id]);
  return formatear(rows[0], docs);
}
function formatear(r, docs) {
  const documentos = {}, resoluciones = {};
  for (const d of docs) {
    const v = { id: d.id, fecha: d.creado.toISOString().slice(0, 10), archivo: d.archivo, con_archivo: !!d.storage_key, origen: d.origen, ia_nota: d.ia_nota };
    if (d.clase === "requisito") documentos[d.tipo] = v; else resoluciones[d.tipo] = v;
  }
  return {
    id: r.id, ...r.datos, creado: r.creado, actualizado: r.actualizado, documentos, resoluciones,
    portal: { activo: !!r.portal_token_hash && r.portal_expira > new Date(), expira: r.portal_expira, ultimo_acceso: r.portal_ultimo_acceso, usos: r.portal_usos },
  };
}
const PERFIL = ["nombre", "tipo_persona", "rfc", "razon_social", "representante", "telefono", "correo", "domicilio", "municipio", "folio_publicidad",
  "resp_nombre", "resp_cedula", "resp_especialidad", "m2_construidos", "honorario", "giros", "publicidad_medios", "hace_cirugia", "maneja_controlados",
  "vende_antibioticos", "tiene_rayos_x", "obra_nueva_o_remodelacion", "servicio_individual", "uso_suelo_no_compatible", "hace_publicidad", "etapa", "tramites"];
const ETAPAS_OK = ["prospecto", "contratado", "en_tramite", "al_corriente", "perdido"];
const ESTATUS_OK = new Set(ESTATUS.map((e) => e[0]));
function limpiarPerfil(b) {
  const o = {};
  for (const k of PERFIL) if (k in b) o[k] = b[k];
  for (const k of ["nombre", "tipo_persona", "rfc", "razon_social", "representante", "telefono", "correo", "domicilio", "municipio", "folio_publicidad", "resp_nombre", "resp_cedula", "resp_especialidad"])
    if (k in o) o[k] = String(o[k] ?? "").slice(0, 300);
  for (const k of ["m2_construidos", "honorario"]) if (k in o) o[k] = Math.max(0, Number(o[k]) || 0);
  for (const k of ["giros", "publicidad_medios"]) if (k in o) o[k] = Array.isArray(o[k]) ? o[k].map(String).slice(0, 10) : [];
  for (const k of ["hace_cirugia", "maneja_controlados", "vende_antibioticos", "tiene_rayos_x", "obra_nueva_o_remodelacion", "servicio_individual", "uso_suelo_no_compatible", "hace_publicidad"])
    if (k in o) o[k] = !!o[k];
  if ("etapa" in o && !ETAPAS_OK.includes(o.etapa)) delete o.etapa;
  if ("tramites" in o) {
    const t = {};
    for (const [id, x] of Object.entries(o.tramites || {})) {
      if (!catById[id] || typeof x !== "object") continue;
      t[id] = {
        estatus: ESTATUS_OK.has(x.estatus) ? x.estatus : "por_iniciar",
        ...Object.fromEntries(["folio", "presentado", "resuelto", "vence", "notas"].filter((k) => x[k]).map((k) => [k, String(x[k]).slice(0, 500)])),
      };
    }
    o.tramites = t;
  }
  return o;
}
const actor = (req) => "agencia:" + req.usuario.email;

/* ---------- API pública de arranque ---------- */
app.get("/api/estado", async (req, res, next) => {
  try {
    const { rows } = await q("select count(*)::int n from usuarios");
    res.json({ configurado: rows[0].n > 0, ia: iaDisponible(), almacenamiento: modoAlmacenamiento });
  } catch (e) { next(e); }
});
app.get("/api/catalogo", (req, res) => res.json(CAT));

app.post("/api/setup", async (req, res, next) => {
  try {
    const { codigo, email, nombre, password } = req.body || {};
    if (!process.env.SETUP_CODE || codigo !== process.env.SETUP_CODE) return res.status(403).json({ error: "El código de configuración no es correcto." });
    if (!email || !password || String(password).length < 10) return res.status(400).json({ error: "Escribe correo y una contraseña de al menos 10 caracteres." });
    const { rows } = await q("select count(*)::int n from usuarios");
    if (rows[0].n > 0) return res.status(409).json({ error: "La agencia ya tiene administrador. Entra con tu cuenta." });
    const hash = await bcrypt.hash(String(password), 12);
    const { rows: u } = await q("insert into usuarios (email, nombre, hash, rol) values ($1,$2,$3,'admin') returning id", [String(email).toLowerCase().trim(), String(nombre || ""), hash]);
    const t = token();
    await q("insert into sesiones (token_hash, usuario_id, expira) values ($1,$2, now() + interval '14 days')", [sha(t), u[0].id]);
    ponerSesion(res, t);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post("/api/login", async (req, res, next) => {
  try {
    if (!limitar("login:" + req.ip, 10, 15 * 60000)) return res.status(429).json({ error: "Demasiados intentos. Espera 15 minutos." });
    const email = String(req.body?.email || "").toLowerCase().trim();
    const { rows } = await q("select id, hash from usuarios where email = $1 and activo", [email]);
    const ok = rows[0] && (await bcrypt.compare(String(req.body?.password || ""), rows[0].hash));
    if (!ok) return res.status(401).json({ error: "Correo o contraseña incorrectos." });
    const t = token();
    await q("insert into sesiones (token_hash, usuario_id, expira) values ($1,$2, now() + interval '14 days')", [sha(t), rows[0].id]);
    await q("delete from sesiones where expira < now()");
    ponerSesion(res, t);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/logout", async (req, res) => {
  const t = leerCookie(req, "sesion");
  if (t) await q("delete from sesiones where token_hash = $1", [sha(t)]).catch(() => {});
  res.setHeader("Set-Cookie", "sesion=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/yo", auth(), (req, res) => res.json(req.usuario));
app.get("/api/sesion", async (req, res) => res.json({ usuario: await usuarioDe(req) }));

/* ---------- usuarios (admin) ---------- */
app.get("/api/usuarios", auth("admin"), async (req, res) => {
  const { rows } = await q("select id, email, nombre, rol, activo, creado from usuarios order by id");
  res.json(rows);
});
app.post("/api/usuarios", auth("admin"), async (req, res, next) => {
  try {
    const { email, nombre, password, rol } = req.body || {};
    if (!email || String(password || "").length < 10) return res.status(400).json({ error: "Escribe correo y una contraseña temporal de al menos 10 caracteres." });
    const hash = await bcrypt.hash(String(password), 12);
    await q("insert into usuarios (email, nombre, hash, rol) values ($1,$2,$3,$4)", [String(email).toLowerCase().trim(), String(nombre || ""), hash, rol === "admin" ? "admin" : "gestor"]);
    res.json({ ok: true });
  } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "Ya existe un usuario con ese correo." }); next(e); }
});
app.patch("/api/usuarios/:id", auth("admin"), async (req, res) => {
  if (Number(req.params.id) === req.usuario.id && req.body?.activo === false) return res.status(400).json({ error: "No puedes desactivar tu propia cuenta." });
  if (typeof req.body?.activo === "boolean") await q("update usuarios set activo = $1 where id = $2", [req.body.activo, req.params.id]);
  if (req.body?.activo === false) await q("delete from sesiones where usuario_id = $1", [req.params.id]);
  res.json({ ok: true });
});
app.post("/api/cambiar-password", auth(), async (req, res) => {
  const { actual, nueva } = req.body || {};
  if (String(nueva || "").length < 10) return res.status(400).json({ error: "La contraseña nueva debe tener al menos 10 caracteres." });
  const { rows } = await q("select hash from usuarios where id = $1", [req.usuario.id]);
  if (!(await bcrypt.compare(String(actual || ""), rows[0].hash))) return res.status(400).json({ error: "La contraseña actual no es correcta." });
  await q("update usuarios set hash = $1 where id = $2", [await bcrypt.hash(String(nueva), 12), req.usuario.id]);
  res.json({ ok: true });
});

/* ---------- configuración de la agencia ---------- */
const CONFIG_CAMPOS = ["razon_social", "rfc", "representante", "domicilio", "gestores", "correo_privacidad", "telefono", "honorario_default", "anticipo"];
app.get("/api/config", auth(), async (req, res) => {
  const { rows } = await q("select datos from config where id = 1");
  res.json(rows[0]?.datos || {});
});
app.put("/api/config", auth("admin"), async (req, res) => {
  const d = {};
  for (const k of CONFIG_CAMPOS) if (k in (req.body || {})) d[k] = ["honorario_default", "anticipo"].includes(k) ? Math.max(0, Number(req.body[k]) || 0) : String(req.body[k] ?? "").slice(0, 300);
  if (d.anticipo > 100) d.anticipo = 100;
  await q("update config set datos = datos || $1::jsonb where id = 1", [JSON.stringify(d)]);
  res.json({ ok: true });
});

/* ---------- clientes ---------- */
app.get("/api/clientes", auth(), async (req, res) => {
  const { rows } = await q("select * from clientes order by actualizado desc");
  const { rows: docs } = await q("select id, cliente_id, clase, tipo, archivo, mime, tamano, storage_key, origen, ia_nota, creado from documentos order by creado");
  const por = {};
  docs.forEach((d) => (por[d.cliente_id] ||= []).push(d));
  res.json(rows.map((r) => formatear(r, por[r.id] || [])));
});
app.post("/api/clientes", auth(), async (req, res) => {
  const p = limpiarPerfil(req.body || {});
  if (!p.nombre) return res.status(400).json({ error: "Escribe el nombre del prospecto." });
  const tramites = {};
  diagnosticar(CAT, p).tr.forEach((t) => (tramites[t.id] = { estatus: "por_iniciar" }));
  const datos = { ...p, etapa: "prospecto", tramites };
  const { rows } = await q("insert into clientes (datos) values ($1) returning id", [datos]);
  await registrar(rows[0].id, actor(req), "creó el expediente");
  res.json(await clienteCompleto(rows[0].id));
});
app.get("/api/clientes/:id", auth(), async (req, res) => {
  const c = await clienteCompleto(req.params.id).catch(() => null);
  if (!c) return res.status(404).json({ error: "No encontré este expediente." });
  res.json(c);
});
app.patch("/api/clientes/:id", auth(), async (req, res) => {
  const p = limpiarPerfil(req.body || {});
  const { rowCount } = await q("update clientes set datos = datos || $1::jsonb, actualizado = now() where id = $2", [p, req.params.id]).catch(() => ({ rowCount: 0 }));
  if (!rowCount) return res.status(404).json({ error: "No encontré este expediente." });
  await registrar(req.params.id, actor(req), "actualizó", { campos: Object.keys(p) });
  res.json(await clienteCompleto(req.params.id));
});
app.delete("/api/clientes/:id", auth("admin"), async (req, res) => {
  const { rows } = await q("select storage_key from documentos where cliente_id = $1 and storage_key is not null", [req.params.id]).catch(() => ({ rows: [] }));
  await q("delete from clientes where id = $1", [req.params.id]).catch(() => {});
  for (const r of rows) await borrar(r.storage_key).catch(() => {});
  res.json({ ok: true });
});
app.get("/api/clientes/:id/bitacora", auth(), async (req, res) => {
  const { rows } = await q("select actor, accion, detalle, creado from bitacora where cliente_id = $1 order by creado desc limit 100", [req.params.id]).catch(() => ({ rows: [] }));
  res.json(rows);
});

/* ---------- documentos (agencia) ---------- */
async function guardarDocumento({ cliente_id, clase, tipo, file, origen, ia_nota }) {
  const ext = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.mimetype];
  const key = `clientes/${cliente_id}/${clase}/${tipo}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
  await guardar(key, file.buffer, file.mimetype);
  try {
    const { rows } = await q(
      `insert into documentos (cliente_id, clase, tipo, archivo, mime, tamano, storage_key, origen, ia_nota)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [cliente_id, clase, tipo, String(file.originalname || "documento").slice(0, 200), file.mimetype, file.size, key, origen, ia_nota || null]);
    await q("update clientes set actualizado = now() where id = $1", [cliente_id]);
    return rows[0].id;
  } catch (e) { await borrar(key).catch(() => {}); throw e; }
}
const tipoValido = (t) => /^[a-z0-9_]{2,60}$/.test(t);

app.post("/api/clientes/:id/documentos", auth(), subir.single("archivo"), async (req, res, next) => {
  try {
    const clase = req.body.clase === "resolucion" ? "resolucion" : "requisito";
    const tipo = String(req.body.tipo || "");
    if (!tipoValido(tipo) || (clase === "resolucion" && !catById[tipo])) return res.status(400).json({ error: "Tipo de documento no válido." });
    if (!(await clienteCompleto(req.params.id).catch(() => null))) return res.status(404).json({ error: "No encontré este expediente." });
    if (req.file) {
      if (!MIME_OK.includes(req.file.mimetype)) return res.status(400).json({ error: "Usa PDF, JPG, PNG o WEBP." });
      await guardarDocumento({ cliente_id: req.params.id, clase, tipo, file: req.file, origen: actor(req) });
    } else {
      await q("insert into documentos (cliente_id, clase, tipo, origen) values ($1,$2,$3,$4)", [req.params.id, clase, tipo, actor(req)]);
    }
    await registrar(req.params.id, actor(req), clase === "resolucion" ? "subió permiso otorgado" : (req.file ? "subió documento" : "marcó documento recibido"), { tipo });
    res.json(await clienteCompleto(req.params.id));
  } catch (e) { next(e); }
});
app.delete("/api/clientes/:id/documentos/:tipo", auth(), async (req, res) => {
  const clase = req.query.clase === "resolucion" ? "resolucion" : "requisito";
  const { rows } = await q("delete from documentos where cliente_id = $1 and tipo = $2 and clase = $3 returning storage_key", [req.params.id, req.params.tipo, clase]).catch(() => ({ rows: [] }));
  for (const r of rows) if (r.storage_key) await borrar(r.storage_key).catch(() => {});
  await registrar(req.params.id, actor(req), "quitó documento", { tipo: req.params.tipo, clase });
  res.json(await clienteCompleto(req.params.id));
});
async function enviarArchivo(res, d) {
  const buf = await leer(d.storage_key);
  const nombre = (d.archivo || "documento").replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ]/g, "_");
  res.set({ "Content-Type": d.mime, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(nombre)}`, "Cache-Control": "private, no-store" });
  res.send(buf);
}
app.get("/api/documentos/:id/archivo", auth(), async (req, res, next) => {
  try {
    const { rows } = await q("select * from documentos where id = $1 and storage_key is not null", [req.params.id]).catch(() => ({ rows: [] }));
    if (!rows[0]) return res.status(404).send("No encontrado");
    await enviarArchivo(res, rows[0]);
  } catch (e) { next(e); }
});

/* ---------- liga del portal (agencia) ---------- */
app.post("/api/clientes/:id/portal", auth(), async (req, res) => {
  const t = token();
  const { rowCount } = await q(
    `update clientes set portal_token_hash = $1, portal_expira = now() + ($2 || ' days')::interval, portal_usos = 0 where id = $3`,
    [sha(t), String(DIAS_PORTAL), req.params.id]).catch(() => ({ rowCount: 0 }));
  if (!rowCount) return res.status(404).json({ error: "No encontré este expediente." });
  await registrar(req.params.id, actor(req), "generó liga del portal");
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.json({ url: `${base}/portal#${t}`, dias: DIAS_PORTAL, cliente: await clienteCompleto(req.params.id) });
});
app.delete("/api/clientes/:id/portal", auth(), async (req, res) => {
  await q("update clientes set portal_token_hash = null, portal_expira = null where id = $1", [req.params.id]).catch(() => {});
  await registrar(req.params.id, actor(req), "desactivó la liga del portal");
  res.json(await clienteCompleto(req.params.id));
});

/* ---------- portal del cliente (público, con liga) ---------- */
async function clienteDelPortal(req) {
  const t = String(req.body?.token || "");
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  const { rows } = await q("select * from clientes where portal_token_hash = $1", [sha(t)]);
  const r = rows[0];
  if (!r || !r.portal_expira || r.portal_expira < new Date() || r.portal_usos >= r.portal_max_usos) return null;
  await q("update clientes set portal_usos = portal_usos + 1, portal_ultimo_acceso = now() where id = $1", [r.id]);
  return r;
}
const limitePortal = (req, res, next) => (limitar("portal:" + req.ip, 120, 15 * 60000) ? next() : res.status(429).json({ error: "Demasiadas solicitudes. Espera unos minutos." }));

app.post("/api/portal/cargar", limitePortal, async (req, res, next) => {
  try {
    const r = await clienteDelPortal(req);
    if (!r) return res.status(401).json({ error: "invalida" });
    const c = await clienteCompleto(r.id);
    const { rows: cfg } = await q("select datos from config where id = 1");
    const ag = cfg[0]?.datos || {};
    const { tr } = diagnosticar(CAT, c);
    const visibles = tr.filter((t) => (c.tramites?.[t.id]?.estatus || "por_iniciar") !== "no_aplica");
    res.json({
      agencia: { nombre: ag.razon_social || "Agencia Regulatoria", telefono: ag.telefono || "" },
      cliente: { nombre: c.nombre || "", municipio: munNombre(c.municipio) },
      requisitos: docsRequeridos(c).map((d) => ({ ...d, recibido: !!c.documentos[d.id], fecha: c.documentos[d.id]?.fecha || null, nota: c.documentos[d.id]?.origen === "portal" ? c.documentos[d.id]?.ia_nota || null : null })),
      tramites: visibles.map((t) => {
        const x = c.tramites?.[t.id] || {};
        return { id: t.id, nombre: t.nombre, autoridad: AUTORIDAD_CLIENTE[t.nivel] || "", estatus: x.estatus || "por_iniciar", vence: x.vence || null, permiso: c.resoluciones[t.id] ? c.resoluciones[t.id].id : null };
      }),
      expira: r.portal_expira,
    });
  } catch (e) { next(e); }
});

app.post("/api/portal/subir", limitePortal, subir.single("archivo"), async (req, res, next) => {
  try {
    const r = await clienteDelPortal(req);
    if (!r) return res.status(401).json({ error: "invalida" });
    const tipo = String(req.body.tipo || "");
    const c = await clienteCompleto(r.id);
    const req_ = docsRequeridos(c).find((d) => d.id === tipo);
    if (!req_) return res.status(400).json({ error: "Ese documento no está en tu lista." });
    if (!req.file) return res.status(400).json({ error: "Elige un archivo." });
    if (!MIME_OK.includes(req.file.mimetype)) return res.status(400).json({ error: "Usa PDF o foto (JPG, PNG o WEBP)." });
    const rev = await revisarDocumento(req.file.buffer, req.file.mimetype, req_.nombre);
    if (rev && !rev.coincide) return res.status(422).json({ rechazado: true, error: `Este archivo no parece ser "${req_.nombre}". ${rev.nota}`.trim() });
    if (rev && !rev.legible) return res.status(422).json({ rechazado: true, error: `No se lee bien. ${rev.nota} Toma la foto con buena luz y sin cortes.`.trim() });
    await guardarDocumento({ cliente_id: r.id, clase: "requisito", tipo, file: req.file, origen: "portal", ia_nota: rev ? rev.nota : "Sin revisión automática" });
    await registrar(r.id, "portal", "cliente subió documento", { tipo });
    res.json({ ok: true, nota: rev?.nota || null });
  } catch (e) { next(e); }
});

app.post("/api/portal/permiso", limitePortal, async (req, res, next) => {
  try {
    const r = await clienteDelPortal(req);
    if (!r) return res.status(401).send("Liga no válida");
    const { rows } = await q("select * from documentos where id = $1 and cliente_id = $2 and clase = 'resolucion' and storage_key is not null", [String(req.body?.doc || ""), r.id]).catch(() => ({ rows: [] }));
    if (!rows[0]) return res.status(404).send("No encontrado");
    await enviarArchivo(res, rows[0]);
  } catch (e) { next(e); }
});

/* ---------- páginas ---------- */
app.use(express.static(path.join(DIR, "public"), { extensions: ["html"], maxAge: PROD ? "1h" : 0 }));
app.get("/portal", (req, res) => res.sendFile(path.join(DIR, "public", "portal.html")));
app.get("/", (req, res) => res.sendFile(path.join(DIR, "public", "index.html")));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "El archivo pasa de 15 MB. Comprime el PDF o toma la foto de nuevo." : "No se pudo recibir el archivo." });
  log("error", "error no controlado", { error: err.message, ruta: req.path });
  res.status(500).json({ error: "Algo falló de nuestro lado. Inténtalo de nuevo." });
});

const PORT = Number(process.env.PORT) || 3000;
migrar().then(() => {
  app.listen(PORT, () => log("info", "Agencia Regulatoria lista", { puerto: PORT, almacenamiento: modoAlmacenamiento, ia: iaDisponible() }));
}).catch((e) => { log("error", "no se pudo preparar la base", { error: e.message }); process.exit(1); });

export { app };
