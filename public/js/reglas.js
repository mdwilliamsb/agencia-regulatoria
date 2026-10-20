// Motor de reglas compartido entre el navegador y el servidor.
// Decide qué trámites aplican a un establecimiento a partir de su perfil y del catálogo.

export const UMA = 117.31; // UMA 2026

export const GIROS = [
  ["consultorio_general", "Consultorio general o de especialidad", "Sin procedimientos invasivos"],
  ["consultorio_estetico", "Consultorio estético", "Toxina, rellenos, láser, aparatología"],
  ["farmacia", "Farmacia", ""],
  ["clinica_cirugia", "Clínica con cirugía ambulatoria", ""],
];
export const HECHOS = [
  ["hace_cirugia", "Hace algún acto quirúrgico", "Lipo, lipotransferencia, blefaroplastia"],
  ["maneja_controlados", "Maneja medicamentos controlados", "Incluye tramadol desde jul-2026"],
  ["vende_antibioticos", "Vende antibióticos", ""],
  ["tiene_rayos_x", "Tiene rayos X, arco en C o mastógrafo", ""],
  ["obra_nueva_o_remodelacion", "Va a construir o remodelar quirófano", ""],
  ["servicio_individual", "Es un solo médico anunciando su propio servicio", ""],
  ["uso_suelo_no_compatible", "El local está en zona habitacional sin uso de suelo comercial", "Toluca permite operar temporalmente con autorización de 3–5 UMA"],
];
export const MEDIOS = [["internet_tv", "Internet / TV"], ["radio", "Radio"], ["prensa", "Prensa"], ["folletos", "Folletos"], ["exteriores", "Exteriores"]];
export const MUNICIPIOS = [["metepec", "Metepec"], ["toluca", "Toluca"], ["otro", "Otro municipio del Edomex"]];
export const ESTATUS = [
  ["por_iniciar", "Por iniciar", ""], ["reuniendo_documentos", "Reuniendo documentos", "acc"],
  ["esperando_cliente", "Esperando al cliente", "warn"], ["listo_para_firma", "Listo para firma", "acc"],
  ["presentado", "Presentado", "acc"], ["en_revision", "En revisión", "acc"],
  ["prevencion", "Prevención: responder", "crit"], ["otorgado", "Otorgado", "ok"],
  ["rechazado", "Rechazado", "crit"], ["no_aplica", "No aplica", ""],
];
export const ETAPAS = [["prospecto", "Prospecto"], ["contratado", "Contratado"], ["en_tramite", "En trámite"], ["al_corriente", "Al corriente"], ["perdido", "Perdido"]];
export const ETIQ_USUARIO = {
  login_efirma: "inicio de sesión con e.firma", firma_solicitud: "firma del titular", pago_derechos: "pago de derechos",
  visita_inspeccion: "visita de inspección", entrega_fisica_libros: "entrega física de libros", contratar_consultor_registrado: "consultor de PC registrado",
};
export const NIVEL_TXT = { municipal: "Ayuntamiento", estatal: "Gobierno del estado", estatal_descentralizado: "Sanitario estatal (convenio COFEPRIS)", federal: "Federal" };

export function evaluar(c, h) {
  if (c === true || c == null) return true;
  if (c === false) return false;
  if (typeof c === "string") return !!h[c];
  const [op, a] = Object.entries(c)[0];
  const g = new Set(h.giros || []);
  switch (op) {
    case "all": return a.every((x) => evaluar(x, h));
    case "any": return a.some((x) => evaluar(x, h));
    case "not": return !evaluar(a, h);
    case "giro": return g.has(a);
    case "any_giro": return a.some((x) => g.has(x));
    case "none_giro": return !a.some((x) => g.has(x));
    case "gt": return (h[a[0]] || 0) > a[1];
    case "in": return a[1].includes(h[a[0]]);
  }
  throw new Error("Operador desconocido: " + op);
}

export const enJur = (t, h) => (!t.estado || t.estado === h.estado) && (!t.municipio || t.municipio === h.municipio);

export function costo(t, h) {
  if (t.costo_mxn_por_medio) return (h.publicidad_medios || []).reduce((s, m) => s + (t.costo_mxn_por_medio[m] || 0), 0);
  if (t.costo_uma != null) return Math.round(t.costo_uma * UMA * 100) / 100;
  return t.costo_mxn ?? null;
}

export function ordenar(ts) {
  const ids = new Set(ts.map((t) => t.id)), antes = {};
  ts.forEach((t) => (antes[t.id] = new Set()));
  ts.forEach((t) => (t.precede_a || []).forEach((s) => ids.has(s) && antes[s].add(t.id)));
  const peso = { municipal: 0, estatal: 1, estatal_descentralizado: 2, federal: 3 };
  const pend = [...ts].sort((a, b) => peso[a.nivel] - peso[b.nivel]);
  const hechos = new Set(), out = [];
  while (pend.length) {
    const i = pend.findIndex((t) => [...antes[t.id]].every((x) => hechos.has(x)));
    if (i < 0) throw new Error("Ciclo de dependencias en el catálogo");
    const t = pend.splice(i, 1)[0];
    out.push(t); hechos.add(t.id);
  }
  return out;
}

export function hechosDe(p) {
  const giros = p.giros || [];
  return {
    ...p, estado: "MEX", giros,
    hace_cirugia: !!p.hace_cirugia || giros.includes("clinica_cirugia"),
    hace_publicidad: !!p.hace_publicidad && (p.publicidad_medios || []).length > 0,
  };
}

export function diagnosticar(CAT, p) {
  const h = hechosDe(p);
  const tr = ordenar(CAT.tramites.filter((t) => enJur(t, h) && evaluar(t.aplica_si, h)));
  const hayMun = CAT.tramites.some((t) => t.estado === h.estado && t.municipio === h.municipio);
  const obl = CAT.obligaciones_continuas.filter((o) => evaluar(o.aplica_si, h));
  return { h, tr, hayMun, obl };
}

// Documentos que la agencia pide al cliente según su perfil.
export function docsRequeridos(c) {
  const g = c.giros || [], cir = !!c.hace_cirugia || g.includes("clinica_cirugia"), moral = c.tipo_persona === "moral";
  const atiende = g.some((x) => x !== "farmacia");
  const l = [
    ["ine", "INE del titular o representante legal", true, "Identificación oficial vigente, por ambos lados"],
    ["acta", "Acta constitutiva", moral, "Con datos de inscripción en el Registro Público"],
    ["poder_notarial", "Poder notarial del representante legal", moral, ""],
    ["csf", "Constancia de situación fiscal (SAT)", true, "Del mes en curso"],
    ["domicilio", "Comprobante de domicilio del establecimiento", true, "Luz, agua o predial, no mayor a 3 meses"],
    ["inmueble", "Escritura o contrato de arrendamiento", true, "Del local donde opera el consultorio"],
    ["fotos", "Fotos de fachada, laterales e interior", true, "Pueden ir en un solo PDF"],
    ["croquis", "Croquis de ubicación", true, "Con calles de referencia"],
    ["resp_titulo", "Título y cédula del responsable sanitario", g.length > 0, ""],
    ["resp_especialidad", "Certificado de especialidad del responsable (consejo)", cir, "Vigente"],
    ["planos", "Planos arquitectónicos y programa médico-arquitectónico", cir, ""],
    ["rpbi", "Contrato con recolector de RPBI", atiende, "Residuos peligrosos biológico-infecciosos"],
    ["libros", "Libros de control foliados", !!c.maneja_controlados, ""],
    ["rayos_x", "Manual de protección radiológica y cédula técnica del equipo", !!c.tiene_rayos_x, ""],
    ["publicidad", "Arte o video final de cada anuncio", !!c.hace_publicidad, ""],
    ["carta_poder", "Carta poder firmada", true, "La que te enviamos, firmada y con testigos"],
    ["contrato", "Contrato de servicios firmado", true, ""],
  ];
  return l.filter((x) => x[2]).map(([id, nombre, , ayuda]) => ({ id, nombre, ayuda }));
}

export const munNombre = (m) => (MUNICIPIOS.find((x) => x[0] === m) || [0, m || "—"])[1];
