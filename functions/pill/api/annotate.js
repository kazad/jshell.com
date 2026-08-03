// POST /pill/api/annotate — attach the human's verdict to a prior submission:
// adjusted count, note about what the counter missed, medication name, target.
// These fields ARE the ground-truth labels for the regression suite.
export async function onRequestPost({ request, env }) {
  try {
    const b = await request.json();
    if (!b.id || typeof b.id !== 'string') return json({ error: 'missing id' }, 400);
    const r = await env.DB.prepare(
      `UPDATE submissions SET
         adjusted = COALESCE(?, adjusted),
         note = COALESCE(?, note),
         med = COALESCE(?, med),
         target = COALESCE(?, target)
       WHERE id = ?`
    ).bind(int(b.adjusted), str(b.note, 2000), str(b.med, 200), int(b.target), b.id).run();
    return json({ ok: true, updated: r.meta.changes });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

const int = (v) => (Number.isFinite(+v) ? Math.round(+v) : null);
const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
