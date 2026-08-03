// GET /pill/api/history?limit=50 — every photo this app has counted, newest
// first, straight from the cloud. History is server-side so nothing is lost
// when a photo isn't explicitly saved, and so the same account sees the same
// history on any device. Each row doubles as a backtest case.
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '60', 10)));
  const before = parseInt(url.searchParams.get('before') || '0', 10);
  const sql = before
    ? `SELECT id, ts, count, adjusted, target, low_confidence, med, note, build
         FROM submissions WHERE ts < ? ORDER BY ts DESC LIMIT ?`
    : `SELECT id, ts, count, adjusted, target, low_confidence, med, note, build
         FROM submissions ORDER BY ts DESC LIMIT ?`;
  const stmt = before ? env.DB.prepare(sql).bind(before, limit) : env.DB.prepare(sql).bind(limit);
  const { results } = await stmt.all();
  return new Response(JSON.stringify({ ok: true, rows: results }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
