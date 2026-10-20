// Pruebas de punta a punta de la API contra un Postgres real.
// Uso: TEST_DATABASE_URL=postgres://... node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const DB = process.env.TEST_DATABASE_URL;
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
let srv, cookie = "", cookieGestor = "";
const almacen = fs.mkdtempSync(path.join(os.tmpdir(), "agencia-test-"));

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const h = (c = cookie) => ({ cookie: c, "x-agencia": "1", "content-type": "application/json" });
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers });

before(async () => {
  if (!DB) throw new Error("Falta TEST_DATABASE_URL");
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  await c.query("drop schema public cascade; create schema public;"); await c.end();
  srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), SETUP_CODE: "codigo-prueba", LOCAL_STORAGE_DIR: almacen, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
  srv.stderr.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/api/estado")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("El servidor no arrancó");
});
after(() => { srv?.kill(); fs.rmSync(almacen, { recursive: true, force: true }); });

test("arranque y configuración inicial", async () => {
  let r = await j(await fetch(BASE + "/api/estado"));
  assert.equal(r.body.configurado, false);
  r = await j(await fetch(BASE + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codigo: "mal", email: "a@b.mx", password: "1234567890" }) }));
  assert.equal(r.status, 403);
  const res = await fetch(BASE + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codigo: "codigo-prueba", email: "Admin@Agencia.mx", nombre: "Admin", password: "contrasena-segura" }) });
  assert.equal(res.status, 200);
  cookie = res.headers.get("set-cookie").split(";")[0];
  assert.match(cookie, /^sesion=[a-f0-9]{64}$/);
  r = await j(await fetch(BASE + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codigo: "codigo-prueba", email: "otro@b.mx", password: "1234567890" }) }));
  assert.equal(r.status, 409, "no permite un segundo setup");
  r = await j(await fetch(BASE + "/api/yo", { headers: { cookie } }));
  assert.equal(r.body.email, "admin@agencia.mx");
  assert.equal(r.body.rol, "admin");
});

test("login rechaza contraseña incorrecta y acepta la correcta", async () => {
  let r = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@agencia.mx", password: "nop" }) });
  assert.equal(r.status, 401);
  r = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@agencia.mx", password: "contrasena-segura" }) });
  assert.equal(r.status, 200);
});

let cid;
test("expedientes: protección, alta, trámites y bitácora", async () => {
  let r = await j(await fetch(BASE + "/api/clientes", { headers: {} }));
  assert.equal(r.status, 401, "sin sesión no hay datos");
  r = await j(await fetch(BASE + "/api/clientes", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ nombre: "X" }) }));
  assert.equal(r.status, 403, "sin encabezado de la app no se permiten escrituras");
  r = await j(await fetch(BASE + "/api/clientes", { method: "POST", headers: h(), body: JSON.stringify({ nombre: "Derma Toluca", municipio: "toluca", giros: ["consultorio_estetico"], hace_publicidad: true, publicidad_medios: ["internet_tv"], tipo_persona: "fisica", campo_raro: "x" }) }));
  assert.equal(r.status, 200);
  cid = r.body.id;
  assert.equal(r.body.etapa, "prospecto");
  assert.ok(r.body.tramites.toluca_licencia_sare, "aplica SARE de Toluca");
  assert.ok(r.body.tramites.cofepris_02_001, "aplica permiso de publicidad");
  assert.equal(r.body.campo_raro, undefined, "ignora campos desconocidos");
  r = await j(await fetch(BASE + `/api/clientes/${cid}`, { method: "PATCH", headers: h(), body: JSON.stringify({ tramites: { ...r.body.tramites, toluca_licencia_sare: { estatus: "otorgado", resuelto: "2026-10-20", vence: "2027-10-20" }, inventado: { estatus: "otorgado" } }, etapa: "en_tramite" }) }));
  assert.equal(r.body.tramites.toluca_licencia_sare.estatus, "otorgado");
  assert.equal(r.body.tramites.inventado, undefined, "ignora trámites fuera del catálogo");
  assert.equal(r.body.etapa, "en_tramite");
  r = await j(await fetch(BASE + `/api/clientes/${cid}/bitacora`, { headers: { cookie } }));
  assert.ok(r.body.length >= 2);
});

test("documentos de la agencia: subir, ver, rechazar tipos no permitidos", async () => {
  let fd = new FormData(); fd.append("tipo", "ine"); fd.append("clase", "requisito"); fd.append("archivo", new Blob([PDF], { type: "application/pdf" }), "ine.pdf");
  let r = await j(await fetch(BASE + `/api/clientes/${cid}/documentos`, { method: "POST", headers: { cookie, "x-agencia": "1" }, body: fd }));
  assert.equal(r.status, 200);
  const doc = r.body.documentos.ine; assert.ok(doc.con_archivo);
  const f = await fetch(BASE + `/api/documentos/${doc.id}/archivo`, { headers: { cookie } });
  assert.equal(f.status, 200); assert.equal(Buffer.from(await f.arrayBuffer()).toString(), PDF.toString());
  assert.equal((await fetch(BASE + `/api/documentos/${doc.id}/archivo`)).status, 401, "archivo privado sin sesión");
  fd = new FormData(); fd.append("tipo", "csf"); fd.append("clase", "requisito"); fd.append("archivo", new Blob(["<script>"], { type: "text/html" }), "x.html");
  r = await j(await fetch(BASE + `/api/clientes/${cid}/documentos`, { method: "POST", headers: { cookie, "x-agencia": "1" }, body: fd }));
  assert.equal(r.status, 400);
  fd = new FormData(); fd.append("tipo", "../etc"); fd.append("clase", "requisito");
  r = await j(await fetch(BASE + `/api/clientes/${cid}/documentos`, { method: "POST", headers: { cookie, "x-agencia": "1" }, body: fd }));
  assert.equal(r.status, 400, "tipo con caracteres raros");
});

let liga;
test("portal del cliente: liga, carga, subida, permisos y revocación", async () => {
  let r = await j(await fetch(BASE + `/api/clientes/${cid}/portal`, { method: "POST", headers: h() }));
  assert.equal(r.status, 200);
  liga = r.body.url.split("#")[1];
  assert.match(liga, /^[a-f0-9]{64}$/);
  assert.equal(r.body.cliente.portal.activo, true);

  r = await j(await fetch(BASE + "/api/portal/cargar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "0".repeat(64) }) }));
  assert.equal(r.status, 401, "liga falsa");
  r = await j(await fetch(BASE + "/api/portal/cargar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: liga }) }));
  assert.equal(r.status, 200);
  assert.equal(r.body.cliente.nombre, "Derma Toluca");
  assert.equal(r.body.cliente.rfc, undefined, "el portal no expone datos internos");
  assert.ok(r.body.requisitos.find((x) => x.id === "ine").recibido);
  assert.ok(!r.body.requisitos.find((x) => x.id === "csf").recibido);
  assert.ok(r.body.tramites.length > 3);

  const fd = new FormData(); fd.append("token", liga); fd.append("tipo", "csf"); fd.append("archivo", new Blob([PDF], { type: "application/pdf" }), "constancia.pdf");
  r = await j(await fetch(BASE + "/api/portal/subir", { method: "POST", body: fd }));
  assert.equal(r.status, 200);
  const fd2 = new FormData(); fd2.append("token", liga); fd2.append("tipo", "planos"); fd2.append("archivo", new Blob([PDF], { type: "application/pdf" }), "x.pdf");
  r = await j(await fetch(BASE + "/api/portal/subir", { method: "POST", body: fd2 }));
  assert.equal(r.status, 400, "no acepta documentos fuera de su lista");

  r = await j(await fetch(BASE + `/api/clientes/${cid}`, { headers: { cookie } }));
  assert.equal(r.body.documentos.csf.origen, "portal");

  const fd3 = new FormData(); fd3.append("tipo", "toluca_licencia_sare"); fd3.append("clase", "resolucion"); fd3.append("archivo", new Blob([PDF], { type: "application/pdf" }), "licencia.pdf");
  r = await j(await fetch(BASE + `/api/clientes/${cid}/documentos`, { method: "POST", headers: { cookie, "x-agencia": "1" }, body: fd3 }));
  const resId = r.body.resoluciones.toluca_licencia_sare.id;
  r = await j(await fetch(BASE + "/api/portal/cargar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: liga }) }));
  assert.equal(r.body.tramites.find((t) => t.id === "toluca_licencia_sare").permiso, resId);
  const p = await fetch(BASE + "/api/portal/permiso", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: liga, doc: resId }) });
  assert.equal(p.status, 200);
  const otro = await fetch(BASE + "/api/portal/permiso", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: liga, doc: r.body.requisitos[0].id }) });
  assert.equal(otro.status, 404, "solo descarga permisos, no otros archivos");

  r = await j(await fetch(BASE + `/api/clientes/${cid}/portal`, { method: "DELETE", headers: h() }));
  assert.equal(r.body.portal.activo, false);
  r = await j(await fetch(BASE + "/api/portal/cargar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: liga }) }));
  assert.equal(r.status, 401, "liga revocada");
});

test("equipo: gestor no puede borrar ni cambiar ajustes", async () => {
  let r = await j(await fetch(BASE + "/api/usuarios", { method: "POST", headers: h(), body: JSON.stringify({ email: "gestor@agencia.mx", nombre: "Gestor", password: "temporal-123", rol: "gestor" }) }));
  assert.equal(r.status, 200);
  const res = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "gestor@agencia.mx", password: "temporal-123" }) });
  cookieGestor = res.headers.get("set-cookie").split(";")[0];
  r = await j(await fetch(BASE + "/api/clientes", { headers: { cookie: cookieGestor } }));
  assert.equal(r.body.length, 1, "el gestor ve los expedientes");
  r = await j(await fetch(BASE + `/api/clientes/${cid}`, { method: "DELETE", headers: h(cookieGestor) }));
  assert.equal(r.status, 403);
  r = await j(await fetch(BASE + "/api/config", { method: "PUT", headers: h(cookieGestor), body: JSON.stringify({ razon_social: "X" }) }));
  assert.equal(r.status, 403);
  r = await j(await fetch(BASE + "/api/config", { method: "PUT", headers: h(), body: JSON.stringify({ razon_social: "Agencia Prueba", anticipo: 300 }) }));
  assert.equal(r.status, 200);
  r = await j(await fetch(BASE + "/api/config", { headers: { cookie } }));
  assert.equal(r.body.anticipo, 100, "anticipo topado a 100%");
});

test("borrar expediente elimina archivos y cierra sesión", async () => {
  let r = await j(await fetch(BASE + `/api/clientes/${cid}`, { method: "DELETE", headers: h() }));
  assert.equal(r.status, 200);
  const quedan = fs.existsSync(path.join(almacen, "clientes", cid)) ? fs.readdirSync(path.join(almacen, "clientes", cid), { recursive: true }).filter((f) => f.endsWith(".pdf")) : [];
  assert.equal(quedan.length, 0);
  await fetch(BASE + "/api/logout", { method: "POST", headers: { cookie } });
  r = await j(await fetch(BASE + "/api/yo", { headers: { cookie } }));
  assert.equal(r.status, 401);
});
