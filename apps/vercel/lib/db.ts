import { Pool } from "pg";

const g = globalThis as unknown as { pool?: Pool; migrated?: Promise<void> };

export function pool() {
  if (!g.pool) {
    const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/otel_demo";
    g.pool = new Pool({ connectionString: url, ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false }, max: 3 });
  }
  return g.pool;
}

export function migrate() {
  g.migrated ??= pool()
    .query(`
      CREATE TABLE IF NOT EXISTS inventory (item text PRIMARY KEY, stock int NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id serial PRIMARY KEY, item text NOT NULL, qty int NOT NULL, status text NOT NULL);
      INSERT INTO inventory VALUES ('widget', 1000000), ('gadget', 1000000), ('gizmo', 1000000) ON CONFLICT (item) DO NOTHING;`)
    .then(() => undefined);
  return g.migrated;
}
