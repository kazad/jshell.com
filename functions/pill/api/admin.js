// POST /pill/api/admin — data-management operations for /pill/data.html.
// Auth: header `x-valeye-key` must equal env.ADMIN_KEY (a Pages secret).
// Body: JSON { action, ... }
//   { action:'list', before?: <ts>, limit?: <=100 }   -> rows newest-first
//   { action:'delete', id }                           -> delete D1 row + R2 object
//   { action:'label', id, adjusted?, note?, med? }    -> update row labels
export async function onRequestPost({ request, env }) {
  if (!env.ADMIN_KEY || request.headers.get('x-valeye-key') !== env.ADMIN_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    const b = await request.json();

    if (b.action === 'list') {
      const limit = Math.min(Math.max(int(b.limit) ?? 50, 1), 100);
      const before = int(b.before);
      const sql = `SELECT id, r2_key, ts, count, adjusted, target, low_confidence,
                          variant, build, ua, note, med
                   FROM submissions ${before ? 'WHERE ts < ?' : ''}
                   ORDER BY ts DESC LIMIT ?`;
      const stmt = before
        ? env.DB.prepare(sql).bind(before, limit)
        : env.DB.prepare(sql).bind(limit);
      const { results } = await stmt.all();
      return json({ ok: true, rows: results });
    }

    if (b.action === 'delete') {
      if (!b.id || typeof b.id !== 'string') return json({ error: 'missing id' }, 400);
      const row = await env.DB.prepare('SELECT r2_key FROM submissions WHERE id = ?')
        .bind(b.id).first();
      if (!row) return json({ error: 'not found' }, 404);
      if (row.r2_key) await env.PHOTOS.delete(row.r2_key);
      await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(b.id).run();
      return json({ ok: true, deleted: b.id });
    }

    if (b.action === 'label') {
      if (!b.id || typeof b.id !== 'string') return json({ error: 'missing id' }, 400);
      const r = await env.DB.prepare(
        `UPDATE submissions SET
           adjusted = CASE WHEN ? THEN ? ELSE adjusted END,
           note     = CASE WHEN ? THEN ? ELSE note END,
           med      = CASE WHEN ? THEN ? ELSE med END
         WHERE id = ?`
      ).bind(
        has(b, 'adjusted') ? 1 : 0, int(b.adjusted),
        has(b, 'note') ? 1 : 0, str(b.note, 2000),
        has(b, 'med') ? 1 : 0, str(b.med, 200),
        b.id
      ).run();
      return json({ ok: true, updated: r.meta.changes });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
const int = (v) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.round(+v) : null);
const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
