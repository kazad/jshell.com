// POST /pill/api/submit — opt-in photo contribution for the regression suite.
// Body: multipart form with `photo` (JPEG) and a `meta` JSON field:
//   { count, adjusted, target, lowConfidence, variant, build }
// Photo -> R2 (valeye-photos), metadata -> D1 (submissions). The user's
// adjusted count is a human-verified label — future ground truth.
export async function onRequestPost({ request, env }) {
  try {
    const form = await request.formData();
    const photo = form.get('photo');
    const meta = JSON.parse(form.get('meta') || '{}');
    if (!photo || typeof photo.arrayBuffer !== 'function') {
      return json({ error: 'missing photo' }, 400);
    }
    const buf = await photo.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return json({ error: 'photo too large' }, 413);
    // A blank/black frame compresses to a tiny JPEG. Real pill photos are far
    // larger; rejecting these keeps unsatisfiable images out of the corpus.
    if (buf.byteLength < 40 * 1024) return json({ error: 'photo blank or too small' }, 400);

    const id = crypto.randomUUID();
    const day = new Date().toISOString().slice(0, 10);
    const key = `photos/${day}/${id}.jpg`;

    await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
    await env.DB.prepare(
      `INSERT INTO submissions (id, r2_key, ts, count, adjusted, target, low_confidence, variant, build, ua, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, key, Date.now(),
      int(meta.count), int(meta.adjusted), int(meta.target), int(meta.lowConfidence),
      str(meta.variant), str(meta.build), str(request.headers.get('user-agent')),
      meta.note == null ? null : String(meta.note).slice(0, 500)
    ).run();

    return json({ ok: true, id });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

const int = (v) => (Number.isFinite(+v) ? Math.round(+v) : null);
const str = (v) => (v == null ? null : String(v).slice(0, 200));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
