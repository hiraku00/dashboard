import { env } from "cloudflare:workers";
import { ensureSchema } from "@/db";

export async function GET() {
  await ensureSchema({ seed: false });
  const [total, completed, movie, audio, text] = await env.DB.batch<{ count: number }>([
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND status='completed'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND content_type='movie'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND content_type='audio'"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM items WHERE deleted_at IS NULL AND content_type='text'"),
  ]);
  const count = (result: D1Result<{ count: number }>) => Number(result.results?.[0]?.count ?? 0);
  return Response.json({ total: count(total), completed: count(completed), movie: count(movie), audio: count(audio), text: count(text) });
}
