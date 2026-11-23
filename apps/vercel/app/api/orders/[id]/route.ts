import { pool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { rows } = await pool().query("SELECT id, status FROM orders WHERE id = $1", [Number(id)]);
  if (!rows[0]) return new Response("not found", { status: 404 });
  return Response.json(rows[0]);
}
