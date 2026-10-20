# Agencia Regulatoria

Consola de la agencia de trámites para consultorios y clínicas (COFEPRIS, COPRISEM, Ayuntamiento, Protección Civil) y portal de clientes.

- **Consola (`/`)**: diagnóstico de trámites por giro y municipio, expedientes, estatus y vencimientos, documentos del cliente, documentos en Word (contrato, carta poder, aviso de privacidad, escrito COPRISEM, ficha de captura, checklist de verificación), cotización, equipo.
- **Portal del cliente (`/portal#<liga>`)**: el médico entra con una liga personal (sin contraseña), sube sus documentos desde el celular, ve el avance de sus trámites y descarga sus permisos otorgados.

## Cómo funciona

| Pieza | Dónde |
|---|---|
| Servidor | `server.js` (Node 20+, Express 5) |
| Base de datos | Postgres (`DATABASE_URL`); las tablas se crean solas al arrancar (`src/db.js`) |
| Archivos | Bucket S3 de Railway (`BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`); sin ellas, carpeta local `./data/uploads` |
| Reglas de trámites | `catalogo_tramites.json` + `public/js/reglas.js` (compartido por servidor y navegador) |
| Revisión de documentos con IA | `src/ia.js`; se activa con `ANTHROPIC_API_KEY` u `OPENAI_API_KEY`. Sin clave, los documentos se aceptan sin revisión |

### Seguridad
- Contraseñas con bcrypt; sesión en cookie `HttpOnly`, `SameSite=Lax`, `Secure` en producción.
- Escrituras de la consola exigen el encabezado `x-agencia: 1` (protección contra peticiones de otros sitios).
- La liga del portal guarda solo el hash SHA-256 del token; vence a los 45 días, tiene límite de usos y se reemplaza al generar una nueva.
- El portal solo devuelve campos permitidos y solo descarga permisos (`clase = 'resolucion'`) del propio cliente.
- Archivos privados: solo se sirven con sesión o con la liga del cliente.

## Variables de entorno

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Postgres |
| `SETUP_CODE` | Código de un solo uso para crear la primera cuenta de administrador |
| `PUBLIC_URL` | URL pública para armar las ligas del portal (opcional) |
| `NODE_ENV=production` | Cookies `Secure` y HSTS |
| `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `BUCKET_URL_STYLE` | Almacenamiento |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Revisión automática de documentos (opcional) |

## Desarrollo

```bash
npm install
DATABASE_URL=postgresql://localhost/agencia SETUP_CODE=dev npm start
TEST_DATABASE_URL=postgresql://localhost/agencia_test npm test   # borra el esquema public de esa base
```

## Actualizar el catálogo de trámites

Edita `catalogo_tramites.json`. Cada trámite tiene `aplica_si` (condición sobre el perfil), `estado`/`municipio` (jurisdicción), costo, vigencia, `confianza` y `verificado_en`. Para un municipio nuevo agrega sus trámites con `"municipio": "<clave>"` y añádelo a `MUNICIPIOS` en `public/js/reglas.js`.
