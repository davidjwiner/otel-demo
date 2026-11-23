import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://localhost:5432/otel_demo",
  ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (item text PRIMARY KEY, stock int NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id serial PRIMARY KEY, item text NOT NULL, qty int NOT NULL, status text NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      id serial PRIMARY KEY, kind text NOT NULL, order_id int NOT NULL,
      traceparent text, tracestate text, created_at timestamptz DEFAULT now(), taken_at timestamptz
    );
    INSERT INTO inventory VALUES ('widget', 1000000), ('gadget', 1000000), ('gizmo', 1000000)
      ON CONFLICT (item) DO NOTHING;
  `);
}
