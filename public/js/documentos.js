// Generación de documentos en Word (.docx) con los datos del expediente.
import { diagnosticar, GIROS, MEDIOS, munNombre } from "./reglas.js";

const mxn = (n) => (n || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 });
const fechaLarga = (d) => d.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
const V = (v, ph) => (v && String(v).trim() ? String(v).trim() : `[${ph}]`);
const titularDe = (c) => c.tipo_persona === "moral"
  ? `${V(c.razon_social, "RAZÓN SOCIAL DEL CLIENTE")}, representada por ${V(c.representante, "REPRESENTANTE LEGAL")}`
  : V(c.razon_social || c.resp_nombre, "NOMBRE DEL TITULAR");
const firmante = (c) => (c.tipo_persona === "moral" ? V(c.representante, "REPRESENTANTE LEGAL") : V(c.razon_social, "TITULAR"));

export function documentosGenerables(CAT, c) {
  const ids = new Set(diagnosticar(CAT, c).tr.map((t) => t.id));
  const l = [
    { id: "contrato", nombre: "Contrato de servicios", desc: "Agencia ↔ cliente, alcance y honorarios" },
    { id: "carta_poder", nombre: "Carta poder", desc: "Para presentar y recoger trámites" },
    { id: "privacidad", nombre: "Aviso de privacidad", desc: "Para el manejo de sus documentos" },
    { id: "ficha", nombre: "Ficha de captura", desc: "Datos para DIGIPRiS y ventanillas" },
    { id: "checklist", nombre: "Checklist de verificación", desc: "Lo que revisa COPRISEM en la visita" },
  ];
  if (ids.has("mex_coprisem_sellos_libros")) l.push({ id: "escrito_libros", nombre: "Escrito a COPRISEM", desc: "Solicitud de sellado de libros" });
  return l;
}

function scian(c) {
  const g = c.giros || [], l = [];
  if (g.includes("clinica_cirugia")) l.push("622111 / 621111 (confirmar en DIGIPRiS)");
  if (g.includes("consultorio_general")) l.push("621111 / 621112");
  if (g.includes("consultorio_estetico")) l.push("621111 o 621113 según DIGIPRiS");
  if (g.includes("farmacia")) l.push("464111");
  return l.join("; ") || "[CLAVE SCIAN]";
}

function checklist(c) {
  const g = c.giros || [], cir = c.hace_cirugia || g.includes("clinica_cirugia"), med = g.some((x) => x !== "farmacia");
  const s = [["Documentos a la vista", ["Aviso de funcionamiento o licencia sanitaria", "Título y cédula del responsable sanitario", "Aviso de responsable sanitario", "Licencia municipal de funcionamiento vigente", "Dictamen o visto bueno de protección civil vigente"]]];
  if (med) s.push(
    ["Consultorio (NOM-005-SSA3)", ["Sala de espera y sanitario", "Área de entrevista separada del área de exploración", "Lavabo con agua, jabón y toallas desechables", "Mesa de exploración, banco de altura y lámpara", "Esfigmomanómetro, estetoscopio, estuche de diagnóstico, termómetro, báscula con estadímetro", "Botiquín de urgencias surtido y sin caducados", "Iluminación y ventilación adecuadas"]],
    ["Expediente clínico (NOM-004-SSA3)", ["Expedientes con historia clínica, notas de evolución y consentimiento informado firmados", "Resguardo confidencial de expedientes", "Si es electrónico: sistema conforme a NOM-024-SSA3"]],
    ["RPBI (NOM-087-SEMARNAT-SSA1)", ["Contenedores rojos para punzocortantes y bolsas rojas/amarillas", "Almacenamiento temporal identificado", "Contrato con recolector autorizado y manifiestos de entrega"]]);
  if (g.includes("consultorio_estetico")) s.push(["Procedimientos estéticos", ["Factura de compra legal de toxina, rellenos y medicamentos", "Registro sanitario vigente de productos y equipos (láser, aparatología)", "Bitácora de apertura y uso de frascos multidosis", "Consentimiento informado específico por procedimiento", "Cadena de frío documentada para productos refrigerados"]]);
  if (cir) s.push(["Cirugía ambulatoria (NOM-016-SSA3)", ["Licencia sanitaria 05-034 para actos quirúrgicos", "Quirófano con circulación blanca y gris diferenciadas", "Central de equipos y esterilización (CEyE) o servicio contratado", "Área de recuperación", "Carro rojo con desfibrilador y bitácora de revisión", "Responsable sanitario con especialidad quirúrgica certificada", "Anestesiólogo y registro anestésico (NOM-006-SSA3)", "Oxígeno y gases medicinales con resguardo seguro"]]);
  if (g.includes("farmacia")) s.push(["Farmacia", ["Aviso de funcionamiento o licencia 05-001-G (si maneja controlados)", "Responsable sanitario con título de farmacia o química", "Suplemento de la FEUM vigente para establecimientos", "Control de temperatura y humedad con registro", "Área de medicamentos caducos separada e identificada", ...(c.maneja_controlados ? ["Controlados bajo llave", "Libros de control al día y autorizados", "Recetas especiales archivadas"] : []), ...(c.vende_antibioticos ? ["Recetas de antibióticos selladas, registradas y archivadas 365 días"] : [])]]);
  s.push(["Protección civil", ["Extintores vigentes con etiqueta y responsiva", "Señalización de rutas de evacuación y salidas", "Botiquín de primeros auxilios", "Programa interno o específico de protección civil", "Constancias de capacitación de brigadas y simulacros"]]);
  if (c.hace_publicidad) s.push(["Publicidad", ["Permiso de publicidad COFEPRIS-02-001 por campaña", "Anuncios con nombre del responsable y número de cédula", "Sin promesas de resultados ni testimonios engañosos"]]);
  return s;
}

export function contenidoDoc(CAT, tipo, c, a, hoyD = new Date()) {
  const { h, tr } = diagnosticar(CAT, c), hoy = fechaLarga(hoyD);
  const ag = V(a.razon_social, "RAZÓN SOCIAL DE LA AGENCIA"), agRep = V(a.representante, "REPRESENTANTE DE LA AGENCIA");
  const mun = c.municipio === "otro" ? "[MUNICIPIO]" : munNombre(c.municipio);
  const lugar = `${mun}, Estado de México`;
  const hon = c.honorario || a.honorario_default || 0, ant = a.anticipo ?? 50;
  const lista = tr.map((t) => `${t.nombre}${t.homoclave ? ` (${t.homoclave})` : ""} ante ${t.autoridad}`);
  const gest = (a.gestores || "").split(",").map((s) => s.trim()).filter(Boolean);
  const nombre = c.nombre || "cliente";
  switch (tipo) {
    case "contrato": return { archivo: `Contrato de servicios - ${nombre}.docx`, titulo: "CONTRATO DE PRESTACIÓN DE SERVICIOS DE GESTORÍA REGULATORIA", bloques: [
      { p: `Contrato que celebran, por una parte, ${ag}, representada por ${agRep}, a quien en lo sucesivo se le denominará "LA AGENCIA", y por la otra ${titularDe(c)}, con RFC ${V(c.rfc, "RFC")}, a quien se le denominará "EL CLIENTE", al tenor de las siguientes declaraciones y cláusulas.` },
      { h: "DECLARACIONES" },
      { p: `I. EL CLIENTE declara que opera o pretende operar el establecimiento denominado "${V(c.nombre, "NOMBRE COMERCIAL")}", ubicado en ${V(c.domicilio, "DOMICILIO DEL ESTABLECIMIENTO")}, ${lugar}.` },
      { p: "II. LA AGENCIA declara que cuenta con la capacidad para gestionar trámites administrativos ante autoridades sanitarias, municipales y de protección civil, sin que ello implique representación legal en juicio." },
      { h: "CLÁUSULAS" },
      { p: "PRIMERA. Objeto. LA AGENCIA se obliga a integrar, presentar y dar seguimiento, en nombre de EL CLIENTE, a los siguientes trámites:" },
      { li: lista.length ? lista : ["[LISTA DE TRÁMITES]"] },
      { p: `SEGUNDA. Honorarios. EL CLIENTE pagará a LA AGENCIA ${hon ? `${mxn(hon)} por trámite, para un total de ${mxn(hon * tr.length)} más IVA` : "[MONTO DE HONORARIOS] más IVA"}. Se cubrirá un anticipo del ${ant}% a la firma de este contrato y el resto contra la presentación de cada trámite.` },
      { p: "TERCERA. Derechos y gastos. Los derechos, aprovechamientos y cuotas que fijen las autoridades no forman parte de los honorarios y serán pagados directamente por EL CLIENTE a la autoridad correspondiente. Tampoco se incluyen honorarios de terceros como consultores de protección civil, peritos, recolectores de residuos o adecuaciones al inmueble." },
      { p: "CUARTA. Obligaciones de EL CLIENTE. Entregar documentación veraz, completa y vigente; firmar las solicitudes que le correspondan; iniciar sesión con su e.firma cuando el trámite lo exija; atender las visitas de verificación; y mantener las condiciones del establecimiento conforme a la normatividad aplicable." },
      { p: "QUINTA. Alcance. LA AGENCIA se obliga a realizar las gestiones con diligencia, pero no garantiza el sentido de la resolución de la autoridad, la cual depende de las condiciones del establecimiento y de la autoridad competente. LA AGENCIA no custodia ni utiliza la firma electrónica de EL CLIENTE." },
      { p: "SEXTA. Confidencialidad y datos personales. LA AGENCIA tratará la información y los datos personales de EL CLIENTE y de su personal conforme a su aviso de privacidad y a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares, y solo para los fines de este contrato." },
      { p: "SÉPTIMA. Vigencia y terminación. Este contrato estará vigente hasta la conclusión de los trámites contratados. Cualquiera de las partes podrá darlo por terminado con aviso por escrito de quince días; los honorarios de los trámites ya presentados no serán reembolsables." },
      { p: "OCTAVA. Jurisdicción. Para la interpretación y cumplimiento de este contrato, las partes se someten a los tribunales competentes de Toluca, Estado de México." },
      { p: `Leído que fue, las partes lo firman en ${lugar}, el ${hoy}.` },
      { firmas: [["LA AGENCIA", agRep], ["EL CLIENTE", firmante(c)]] }] };
    case "carta_poder": return { archivo: `Carta poder - ${nombre}.docx`, titulo: "CARTA PODER", bloques: [
      { p: `${lugar}, a ${hoy}.`, der: true },
      { p: "A QUIEN CORRESPONDA:" },
      { p: `Por medio de la presente, ${titularDe(c)}, con RFC ${V(c.rfc, "RFC")}, en mi carácter de titular del establecimiento "${V(c.nombre, "NOMBRE COMERCIAL")}" ubicado en ${V(c.domicilio, "DOMICILIO")}, otorgo poder amplio y suficiente a ${gest.length ? gest.join(", ") : "[NOMBRE DEL GESTOR]"}, para que en mi nombre y representación realice las siguientes gestiones ante la Comisión Federal para la Protección contra Riesgos Sanitarios, la Comisión para la Protección contra Riesgos Sanitarios del Estado de México, el Ayuntamiento de ${mun} y las coordinaciones de Protección Civil estatal y municipal:` },
      { li: ["Presentar solicitudes, avisos y escritos, y entregar la documentación que los acompañe.", "Recibir notificaciones, prevenciones, acuses, oficios, licencias y permisos.", "Dar respuesta a prevenciones y requerimientos de información.", "Consultar el estado de los trámites y recoger documentos."] },
      { p: "Este poder no faculta para firmar en mi nombre solicitudes que requieran mi firma autógrafa o electrónica, ni para pagar derechos con cargo a mis cuentas." },
      { firmas: [["OTORGA", firmante(c)], ["ACEPTA", gest[0] || "[NOMBRE DEL GESTOR]"]] },
      { firmas: [["TESTIGO", "[NOMBRE Y FIRMA]"], ["TESTIGO", "[NOMBRE Y FIRMA]"]] },
      { nota: `Anexar copia de identificación oficial de quien otorga, de quien acepta y de los testigos.${c.tipo_persona === "moral" ? " Persona moral: algunas autoridades piden que el representante acredite su personalidad con poder notarial; anexar copia." : ""}` }] };
    case "privacidad": return { archivo: `Aviso de privacidad - ${a.razon_social || "agencia"}.docx`, titulo: "AVISO DE PRIVACIDAD INTEGRAL", bloques: [
      { p: `${ag}, con domicilio en ${V(a.domicilio, "DOMICILIO DE LA AGENCIA")}, es responsable del tratamiento de los datos personales que nos proporcione, conforme a la Ley Federal de Protección de Datos Personales en Posesión de los Particulares.` },
      { h: "Datos que recabamos" },
      { p: "Nombre, identificación oficial, RFC, domicilio, teléfono y correo del titular, del representante legal y del responsable sanitario; título, cédula profesional y certificados de especialidad; documentos del inmueble y del establecimiento." },
      { h: "Finalidades" },
      { li: ["Integrar y presentar los trámites contratados ante autoridades sanitarias, municipales y de protección civil.", "Dar seguimiento a los trámites y avisarle de vencimientos y renovaciones.", "Facturar y cobrar los servicios."] },
      { h: "Transferencias" },
      { p: "Sus datos se comparten únicamente con las autoridades ante las que se presentan los trámites, en la medida necesaria para cada uno. No se venden ni se ceden a terceros con fines comerciales." },
      { h: "Derechos ARCO" },
      { p: `Puede solicitar el acceso, rectificación, cancelación u oposición al tratamiento de sus datos, o revocar su consentimiento, escribiendo a ${V(a.correo_privacidad, "CORREO DE CONTACTO")}. Responderemos en el plazo que fija la ley.` },
      { h: "Cambios al aviso" },
      { p: "Cualquier cambio a este aviso se le comunicará por el mismo medio por el que tenemos contacto con usted." },
      { p: `Fecha de última actualización: ${hoy}.` },
      { firmas: [["Acepto los términos de este aviso", firmante(c)]] }] };
    case "ficha": return { archivo: `Ficha de captura - ${nombre}.docx`, titulo: "FICHA DE CAPTURA DEL ESTABLECIMIENTO", bloques: [
      { nota: `Para llenar DIGIPRiS y los formatos de ventanilla. Verificar cada dato contra los documentos originales. Generada el ${hoy}.` },
      { tabla: [["Nombre comercial", V(c.nombre, "")], ["Tipo de persona", c.tipo_persona === "moral" ? "Moral" : "Física"], ["Razón social / titular", V(c.razon_social, "")], ["RFC", V(c.rfc, "")], ["Representante legal", c.tipo_persona === "moral" ? V(c.representante, "") : "No aplica"], ["Domicilio del establecimiento", V(c.domicilio, "")], ["Municipio", lugar], ["Teléfono", V(c.telefono, "")], ["Correo", V(c.correo, "")], ["Giro(s)", (c.giros || []).map((g) => GIROS.find((x) => x[0] === g)?.[1]).join(", ") || "[GIRO]"], ["Clave SCIAN sugerida", scian(c)], ["m² construidos", c.m2_construidos ? String(c.m2_construidos) : "[m²]"], ["Responsable sanitario", V(c.resp_nombre, "")], ["Cédula profesional", V(c.resp_cedula, "")], ["Especialidad y cédula", V(c.resp_especialidad, "")], ["Actos quirúrgicos", h.hace_cirugia ? "Sí" : "No"], ["Medicamentos controlados", c.maneja_controlados ? "Sí" : "No"], ["Rayos X", c.tiene_rayos_x ? "Sí" : "No"], ["Publicidad", h.hace_publicidad ? (c.publicidad_medios || []).map((m) => MEDIOS.find((x) => x[0] === m)?.[1]).join(", ") : "No"]] },
      { h: "Trámites a presentar" }, { li: lista }] };
    case "checklist": return { archivo: `Checklist de verificacion - ${nombre}.docx`, titulo: "CHECKLIST PARA LA VISITA DE VERIFICACIÓN SANITARIA", bloques: [
      { nota: "Guía práctica de preparación. La verificación se rige por la NOM vigente y el acta de la autoridad; revisar contra el texto oficial." },
      ...checklist(c).flatMap(([sec, items]) => [{ h: sec }, { li: items.map((i) => "☐  " + i) }])] };
    case "escrito_libros": return { archivo: `Escrito COPRISEM sellado de libros - ${nombre}.docx`, titulo: "", bloques: [
      { p: `${lugar}, a ${hoy}.`, der: true },
      { p: "SUBDIRECCIÓN DE NORMATIVIDAD SANITARIA\nCOMISIÓN PARA LA PROTECCIÓN CONTRA RIESGOS SANITARIOS DEL ESTADO DE MÉXICO\nP R E S E N T E" },
      { p: `${titularDe(c)}, titular del establecimiento "${V(c.nombre, "NOMBRE COMERCIAL")}", con domicilio en ${V(c.domicilio, "DOMICILIO")}, ${lugar}, señalando como autorizado para oír y recibir notificaciones a ${gest[0] || "[NOMBRE DEL GESTOR]"}, respetuosamente solicito el sellado de los siguientes libros del establecimiento:` },
      { li: ["Libro de registro diario de pacientes", "Libro de registro de enfermedades infectocontagiosas", ...(h.hace_cirugia ? ["Libro de registro de cirugías", "Libro de registro de defunciones"] : [])] },
      { p: "Para tal efecto anexo copia del aviso de funcionamiento o licencia sanitaria del establecimiento y los libros correspondientes." },
      { p: "Sin otro particular, quedo a sus órdenes." },
      { firmas: [["A T E N T A M E N T E", firmante(c)]] }] };
  }
  throw new Error("Documento desconocido: " + tipo);
}

let docxCargando = null;
function cargarDocx() {
  if (window.docx) return Promise.resolve(window.docx);
  if (docxCargando) return docxCargando;
  docxCargando = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js";
    s.onload = () => (window.docx ? res(window.docx) : rej(new Error("docx")));
    s.onerror = () => { docxCargando = null; rej(new Error("No se pudo cargar el generador de Word. Revisa tu conexión.")); };
    document.head.appendChild(s);
  });
  return docxCargando;
}

export async function construirDocx(d) {
  const X = await cargarDocx();
  const { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType } = X;
  const F = "Arial";
  const P = (text, o = {}) => new Paragraph({
    alignment: o.align || AlignmentType.JUSTIFIED, spacing: { after: 160, line: 300 },
    children: String(text).split("\n").flatMap((ln, i) => [...(i ? [new TextRun({ break: 1 })] : []), new TextRun({ text: ln, font: F, size: o.size || 22, bold: !!o.bold, italics: !!o.it })]),
  });
  const ch = [];
  if (d.titulo) ch.push(P(d.titulo, { align: AlignmentType.CENTER, bold: true, size: 26 }));
  for (const b of d.bloques) {
    if (b.h) ch.push(P(b.h, { bold: true, align: AlignmentType.LEFT }));
    else if (b.p) ch.push(P(b.p, { align: b.der ? AlignmentType.RIGHT : AlignmentType.JUSTIFIED }));
    else if (b.li) b.li.forEach((x) => ch.push(new Paragraph({ spacing: { after: 80 }, indent: { left: 500, hanging: 280 }, children: [new TextRun({ text: (x.startsWith("☐") ? "" : "•  ") + x, font: F, size: 22 })] })));
    else if (b.nota) ch.push(P(b.nota, { it: true, size: 19, align: AlignmentType.LEFT }));
    else if (b.tabla) ch.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: b.tabla.map(([k, v]) => new TableRow({ children: [new TableCell({ width: { size: 35, type: WidthType.PERCENTAGE }, children: [P(k, { bold: true, align: AlignmentType.LEFT, size: 20 })] }), new TableCell({ children: [P(v, { align: AlignmentType.LEFT, size: 20 })] })] })) }), P(""));
    else if (b.firmas) {
      const N = { style: "none", size: 0, color: "FFFFFF" };
      ch.push(P(""), P(""));
      ch.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: N, bottom: N, left: N, right: N, insideHorizontal: N, insideVertical: N },
        rows: [new TableRow({ children: b.firmas.map(([rol, nom]) => new TableCell({ borders: { top: N, bottom: N, left: N, right: N }, children: [P("________________________________", { align: AlignmentType.CENTER }), P(nom, { align: AlignmentType.CENTER, bold: true, size: 20 }), P(rol, { align: AlignmentType.CENTER, size: 18 })] })) })] }));
    }
  }
  const doc = new Document({ sections: [{ properties: { page: { margin: { top: 1300, bottom: 1300, left: 1400, right: 1400 } } }, children: ch }] });
  return Packer.toBlob(doc);
}

export function descargarBlob(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
