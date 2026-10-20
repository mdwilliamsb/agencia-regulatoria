// Almacenamiento privado de archivos: bucket S3 de Railway en producción,
// carpeta local en desarrollo (cuando no hay variables del bucket).
import fs from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const { BUCKET, ENDPOINT, REGION, ACCESS_KEY_ID, SECRET_ACCESS_KEY } = process.env;
const usarS3 = !!(BUCKET && ENDPOINT && ACCESS_KEY_ID && SECRET_ACCESS_KEY);
const LOCAL = path.resolve(process.env.LOCAL_STORAGE_DIR || "./data/uploads");

const s3 = usarS3
  ? new S3Client({
      endpoint: ENDPOINT,
      region: REGION || "auto",
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
      forcePathStyle: process.env.BUCKET_URL_STYLE === "path",
    })
  : null;

export const modoAlmacenamiento = usarS3 ? "s3" : "local";

const seguro = (key) => {
  if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes("..")) throw new Error("Clave de archivo inválida");
  return key;
};

export async function guardar(key, buffer, mime) {
  seguro(key);
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: mime }));
  } else {
    const p = path.join(LOCAL, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buffer);
  }
}

export async function leer(key) {
  seguro(key);
  if (s3) {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return Buffer.from(await r.Body.transformToByteArray());
  }
  return fs.readFile(path.join(LOCAL, key));
}

export async function borrar(key) {
  seguro(key);
  if (s3) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  else await fs.rm(path.join(LOCAL, key), { force: true });
}
