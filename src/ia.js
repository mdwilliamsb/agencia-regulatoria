// Revisión de documentos con IA: confirma que el archivo subido es del tipo que se pidió
// (que no suban una INE donde va el contrato de arrendamiento).
// Es opcional: sin ANTHROPIC_API_KEY ni OPENAI_API_KEY el documento se acepta y queda "sin revisar".

const PROMPT = (tipoNombre) => `Eres asistente de una gestoría de trámites sanitarios en México.
Te muestro un archivo que un cliente subió como: "${tipoNombre}".
Responde SOLO un objeto JSON: {"coincide": true|false, "legible": true|false, "nota": "<máx. 25 palabras en español>"}.
"coincide" es false solo si claramente es otro tipo de documento. "legible" es false si está borroso, cortado o ilegible.
En "nota" di qué documento parece y cualquier problema (vencido, incompleto, falta un lado).`;

function parsear(texto) {
  const m = String(texto || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return { coincide: j.coincide !== false, legible: j.legible !== false, nota: String(j.nota || "").slice(0, 300) };
  } catch { return null; }
}

async function conAnthropic(buf, mime, tipoNombre) {
  const b64 = buf.toString("base64");
  const bloque = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: b64 } };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
      max_tokens: 200,
      messages: [{ role: "user", content: [bloque, { type: "text", text: PROMPT(tipoNombre) }] }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error("Anthropic " + r.status);
  const j = await r.json();
  return parsear(j.content?.map((c) => c.text || "").join(""));
}

async function conOpenAI(buf, mime, tipoNombre) {
  const url = `data:${mime};base64,${buf.toString("base64")}`;
  const parte = mime === "application/pdf"
    ? { type: "file", file: { filename: "documento.pdf", file_data: url } }
    : { type: "image_url", image_url: { url } };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: 200,
      messages: [{ role: "user", content: [parte, { type: "text", text: PROMPT(tipoNombre) }] }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error("OpenAI " + r.status);
  const j = await r.json();
  return parsear(j.choices?.[0]?.message?.content);
}

export const iaDisponible = () => !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

export async function revisarDocumento(buf, mime, tipoNombre) {
  try {
    if (process.env.ANTHROPIC_API_KEY) return await conAnthropic(buf, mime, tipoNombre);
    if (process.env.OPENAI_API_KEY) return await conOpenAI(buf, mime, tipoNombre);
  } catch (e) {
    console.warn(JSON.stringify({ nivel: "warn", msg: "revisión IA falló", error: e.message }));
  }
  return null; // sin revisión
}
