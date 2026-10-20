import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Falta DATABASE_URL");

// Railway expone Postgres en la red privada sin TLS; la URL pública sí lo requiere.
const ssl = /sslmode=require|\.proxy\.rlwy\.net|railway\.app/.test(url) ? { rejectUnauthorized: false } : false;
export const pool = new pg.Pool({ connectionString: url, ssl, max: 10 });

export const q = (text, params) => pool.query(text, params);

export async function migrar() {
  await q(`
    create table if not exists usuarios (
      id serial primary key,
      email text unique not null,
      nombre text not null default '',
      hash text not null,
      rol text not null default 'gestor' check (rol in ('admin','gestor')),
      activo boolean not null default true,
      creado timestamptz not null default now()
    );
    create table if not exists sesiones (
      token_hash text primary key,
      usuario_id int not null references usuarios(id) on delete cascade,
      expira timestamptz not null
    );
    create table if not exists config (
      id int primary key default 1 check (id = 1),
      datos jsonb not null default '{}'::jsonb
    );
    create table if not exists clientes (
      id uuid primary key default gen_random_uuid(),
      datos jsonb not null default '{}'::jsonb,
      creado timestamptz not null default now(),
      actualizado timestamptz not null default now(),
      portal_token_hash text unique,
      portal_expira timestamptz,
      portal_usos int not null default 0,
      portal_max_usos int not null default 300,
      portal_ultimo_acceso timestamptz
    );
    create table if not exists documentos (
      id uuid primary key default gen_random_uuid(),
      cliente_id uuid not null references clientes(id) on delete cascade,
      clase text not null check (clase in ('requisito','resolucion')),
      tipo text not null,
      archivo text,
      mime text,
      tamano int,
      storage_key text,
      origen text not null,
      ia_nota text,
      creado timestamptz not null default now()
    );
    create index if not exists documentos_cliente_idx on documentos (cliente_id);
    create table if not exists bitacora (
      id bigserial primary key,
      cliente_id uuid references clientes(id) on delete cascade,
      actor text not null,
      accion text not null,
      detalle jsonb,
      creado timestamptz not null default now()
    );
    create index if not exists bitacora_cliente_idx on bitacora (cliente_id, creado desc);
    insert into config (id) values (1) on conflict do nothing;
  `);
}

export async function registrar(cliente_id, actor, accion, detalle = null) {
  await q("insert into bitacora (cliente_id, actor, accion, detalle) values ($1,$2,$3,$4)", [cliente_id, actor, accion, detalle]);
}
